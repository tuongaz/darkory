package wake_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
	"github.com/tuongaz/darkory/internal/wake"
)

// instance is one server process: its own Store, Notifier and HTTP server, on a shared database.
type instance struct {
	st  *store.Store
	n   *wake.Notifier
	srv *server.Server
	ts  *httptest.Server
}

func startInstance(t *testing.T, dsn string) *instance {
	t.Helper()
	st, err := store.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	n := wake.New()
	pg, err := wake.ListenPostgres(t.Context(), n, st, dsn, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pg.Close)
	// A keep-alive far longer than the test, so an Activity stream re-reads only when woken.
	srv := server.New(st, server.Options{Wake: n, KeepAlive: time.Hour})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &instance{st: st, n: n, srv: srv, ts: ts}
}

func (in *instance) client(t *testing.T, secret, session string) *client.ClientWithResponses {
	t.Helper()
	c, err := client.NewClientWithResponses(in.ts.URL, client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Darkory-Session", session)
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// stream opens the Activity stream on in after seq and sends each event's sequence number.
func (in *instance) stream(t *testing.T, secret, session string, after int64) <-chan int64 {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, in.ts.URL+"/v1/activity/stream?after="+strconv.FormatInt(after, 10), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Darkory-Session", session)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stream: status %d", res.StatusCode)
	}
	ids := make(chan int64, 100)
	go func() {
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "id: "); ok {
				n, _ := strconv.ParseInt(v, 10, 64)
				ids <- n
			}
		}
	}()
	return ids
}

func ptr[T any](v T) *T { return &v }

// Two server processes on one Postgres database: a waiting `next` and an Activity stream on A
// wake when a write commits on B, before either would have re-read on its own; and again after
// both LISTEN connections are killed and come back.
func TestWritesOnOneProcessWakeWaitersOnAnother(t *testing.T) {
	dsn := storetest.DSN(t, store.Postgres)
	a, b := startInstance(t, dsn), startInstance(t, dsn)
	ctx := t.Context()

	init, err := a.srv.Core().Init(ctx, "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	org, secret := init.Organisation.ID, init.Token.Secret
	adminB := b.client(t, secret, "ada-b")
	got(adminB.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).ok(t)
	got(adminB.CreateMemberWithResponse(ctx, &client.CreateMemberParams{}, client.CreateMemberBody{Name: "bot", Kind: client.Agent})).ok(t)
	got(adminB.AddProjectMemberWithResponse(ctx, "WEB", "bot", &client.AddProjectMemberParams{})).ok(t)
	got(adminB.AddProjectMemberWithResponse(ctx, "WEB", "ada", &client.AddProjectMemberParams{})).ok(t)
	got(adminB.GrantSkillWithResponse(ctx, "bot", "breakdown", &client.GrantSkillParams{})).ok(t)
	tok := got(adminB.IssueTokenWithResponse(ctx, "bot", &client.IssueTokenParams{}, client.IssueTokenBody{Name: "main"})).ok(t)
	botA := a.client(t, tok.JSON201.Secret, "bot-a")
	// The Task each round files bot's question under, at the Backlog hold, where nobody takes it.
	anchor := got(adminB.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptr("WEB"), Title: "Anchor",
		Step: ptr("Backlog")})).ok(t).JSON201

	page := got(a.client(t, secret, "ada-a").ListActivityWithResponse(ctx, &client.ListActivityParams{})).ok(t)
	events := a.stream(t, secret, "ada-stream", page.JSON200.LastSeq)
	// The stream's first read finds nothing; let it settle into waiting.
	time.Sleep(200 * time.Millisecond)

	check := func(round string) {
		t.Helper()
		// The Activity stream on A, woken by a write on B.
		project := "T" + strings.ToUpper(round[:1])
		start := time.Now()
		got(adminB.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: project, Name: project})).ok(t)
		select {
		case seq := <-events:
			if since := time.Since(start); since > time.Second {
				t.Fatalf("%s: the stream on A sent %d after %s", round, seq, since)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s: the stream on A did not send B's write within 1 s", round)
		}

		// A waiting `next` on A, woken by a write on B. It re-reads every 2 s on its own, so an
		// answer within 1 s of a write made shortly after it started waiting came from the wake.
		type reply struct {
			res *client.NextTaskResponse
			err error
			at  time.Time
		}
		done := make(chan reply, 1)
		go func() {
			res, err := botA.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptr(10)})
			done <- reply{res, err, time.Now()}
		}()
		time.Sleep(300 * time.Millisecond)
		start = time.Now()
		got(adminB.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Parent: &anchor.Task.Key, Title: "Question " + round,
			Aim: ptr("bot")})).ok(t)
		select {
		case r := <-done:
			if r.err != nil || r.res.StatusCode() != http.StatusOK {
				t.Fatalf("%s: next: %v %s", round, r.err, r.res.Body)
			}
			if took := r.at.Sub(start); took > time.Second {
				t.Fatalf("%s: next on A answered %s after B's write", round, took)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s: next on A did not claim B's Task within 1 s", round)
		}
		// Drain what A's own claim and the filing added to the stream.
		for drained := false; !drained; {
			select {
			case <-events:
			case <-time.After(200 * time.Millisecond):
				drained = true
			}
		}
	}
	check("before")

	// Kill both processes' LISTEN connections.
	var killed int
	if err := a.st.QueryRow(ctx, `SELECT COUNT(pg_terminate_backend(pid)) FROM pg_stat_activity
WHERE application_name = $1 AND datname = current_database()`, wake.ApplicationName).Scan(&killed); err != nil || killed != 2 {
		t.Fatalf("killed %d LISTEN connections: %v", killed, err)
	}
	// Each comes back: a Signal on one wakes a waiter on the other again.
	for _, pair := range [][2]*instance{{a, b}, {b, a}} {
		waitReconnected(t, org, pair[0], pair[1])
	}
	check("after")
}

// waitReconnected waits until a Signal on from wakes a waiter on to.
func waitReconnected(t *testing.T, org string, to, from *instance) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		ch := to.n.Wait(org)
		from.n.Signal(org)
		select {
		case <-ch:
			return
		case <-time.After(200 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("the LISTEN connection did not come back")
		}
	}
}

type result[R interface{ StatusCode() int }] struct {
	res R
	err error
}

func got[R interface{ StatusCode() int }](res R, err error) result[R] { return result[R]{res, err} }

// ok fails the test unless the call succeeded, and returns the reply.
func (r result[R]) ok(t *testing.T) R {
	t.Helper()
	if r.err != nil {
		t.Fatal(r.err)
	}
	if s := r.res.StatusCode(); s >= 300 {
		t.Fatalf("status %d", s)
	}
	return r.res
}
