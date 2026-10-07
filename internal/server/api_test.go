package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

func key(k string) *string { return &k }

type response interface{ StatusCode() int }

// result is a generated client call's reply, to check with want.
type result[R response] struct {
	res R
	err error
}

func got[R response](res R, err error) result[R] { return result[R]{res, err} }

// want fails the test unless the call answered status, and returns the reply.
func (r result[R]) want(t *testing.T, status int) R {
	t.Helper()
	if r.err != nil {
		t.Fatal(r.err)
	}
	if r.res.StatusCode() != status {
		t.Fatalf("status %d, want %d: %s", r.res.StatusCode(), status, reflect.ValueOf(r.res).Elem().FieldByName("Body").Bytes())
	}
	return r.res
}

func decode(t *testing.T, res *http.Response, v any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

// agent creates an agent Member in WEB with skills and a token, and returns its client.
func (h *harness) agent(name string, defaultTimeout *int, skills ...string) (*client.ClientWithResponses, string) {
	t := h.t
	ctx := t.Context()
	m := got(h.admin.CreateMemberWithResponse(ctx, &client.CreateMemberParams{},
		client.CreateMemberBody{Name: name, Kind: client.Agent})).want(t, http.StatusCreated)
	got(h.admin.AddTeamMemberWithResponse(ctx, "WEB", name, &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
	for _, s := range skills {
		got(h.admin.GrantSkillWithResponse(ctx, name, s, &client.GrantSkillParams{})).want(t, http.StatusNoContent)
	}
	tok := got(h.admin.IssueTokenWithResponse(ctx, name, &client.IssueTokenParams{},
		client.IssueTokenBody{Name: "main", DefaultHeartbeatTimeoutSeconds: defaultTimeout})).want(t, http.StatusCreated)
	h.secrets[name] = tok.JSON201.Secret
	return h.client(tok.JSON201.Secret, name+"-1"), m.JSON201.ID
}

func (h *harness) secretOf(t *testing.T, name string) string {
	t.Helper()
	secret, ok := h.secrets[name]
	if !ok {
		t.Fatalf("no token made for %s", name)
	}
	return secret
}

// The claim path end to end through the generated client: the admin sets up a Project and an
// agent, the agent files a Task with Break down, `next` hands it the Breakdown filed with it, and
// it heartbeats and completes it.
func TestClaimPathThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bot, botID := h.agent("bot", ptrInt(60), "breakdown")

		// Nothing to take yet: `next` waits, then answers 204.
		start := time.Now()
		got(bot.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(1)})).want(t, http.StatusNoContent)
		if waited := time.Since(start); waited < time.Second {
			t.Fatalf("next answered after %s, want about a second", waited)
		}

		filed := h.seed(h.secretOf(t, "bot"), core.NewTask{Project: ptrStr("WEB"), Title: "Sign-up", Breakdown: true})
		if filed.Task.Key != "WEB-1" || filed.Task.OwnerID != botID || len(filed.Subtasks) != 1 ||
			filed.Subtasks[0].Kind != "breakdown" || filed.Subtasks[0].Key != "WEB-2" {
			t.Fatalf("filed %+v", filed)
		}
		takeable := got(bot.ListTakeableTasksWithResponse(ctx, &client.ListTakeableTasksParams{})).want(t, http.StatusOK).JSON200
		if len(takeable.Items) != 1 || takeable.Items[0].Key != "WEB-2" {
			t.Fatalf("takeable %+v", takeable.Items)
		}

		label := "claude-opus-5-5"
		next := got(bot.NextTaskWithResponse(ctx, &client.NextTaskParams{IdempotencyKey: key("next-1")},
			client.NextTaskBody{WaitSeconds: ptrInt(5), ModelLabel: &label})).want(t, http.StatusOK).JSON200
		c := next.Task.Claim
		if next.Task.Key != "WEB-2" || c == nil || c.HolderID != botID || c.SessionID != "bot-1" || c.HeartbeatTimeoutSeconds == nil ||
			*c.HeartbeatTimeoutSeconds != 60 || c.ExpiresAt == nil || *c.ModelLabel != label || *c.SkillVersion != 1 {
			t.Fatalf("next claimed %+v with %+v", next.Task, c)
		}
		// A retry with the same key gets the same reply and claims nothing more.
		again := got(bot.NextTaskWithResponse(ctx, &client.NextTaskParams{IdempotencyKey: key("next-1")},
			client.NextTaskBody{WaitSeconds: ptrInt(5), ModelLabel: &label})).want(t, http.StatusOK)
		if first := mustMarshal(t, next); !bytes.Equal(bytes.TrimSpace(again.Body), first) {
			t.Fatalf("retry of next answered\n%s\nnot\n%s", again.Body, first)
		}

		hb := got(bot.HeartbeatWithResponse(ctx, "WEB-2", &client.HeartbeatParams{IdempotencyKey: key("hb")})).want(t, http.StatusOK).JSON200
		if hb.Status != client.HeartbeatStatusOk || hb.ExpiresAt == nil {
			t.Fatalf("heartbeat %+v", hb)
		}
		// Another Member cannot complete it.
		other, _ := h.agent("other", nil, "breakdown")
		res := got(other.CompleteTaskWithResponse(ctx, "WEB-2", &client.CompleteTaskParams{}, client.CompleteTaskBody{})).want(t, http.StatusConflict)
		if res.JSONDefault.Code != client.ErrorCodeNotHolder {
			t.Fatalf("other's complete: %s", res.Body)
		}
		note := "filed the Tasks"
		done := got(bot.CompleteTaskWithResponse(ctx, "WEB-2", &client.CompleteTaskParams{IdempotencyKey: key("done")},
			client.CompleteTaskBody{Note: &note})).want(t, http.StatusOK).JSON200
		if done.State != client.TaskStateDone || done.Claim != nil || done.EndedAt == nil {
			t.Fatalf("completed %+v", done)
		}
		task := got(bot.GetTaskWithResponse(ctx, next.Task.ID)).want(t, http.StatusOK).JSON200
		if len(task.Claims) != 1 || *task.Claims[0].HowEnded != client.ClaimEndCompleted || len(task.Notes) != 1 {
			t.Fatalf("task %+v", task)
		}

		act := got(bot.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200
		var kinds []string
		for _, a := range act.Items {
			if a.SubjectID == next.Task.ID {
				kinds = append(kinds, string(a.Kind))
			}
		}
		if strings.Join(kinds, " ") != "task.filed task.claimed task.completed" {
			t.Fatalf("the Task's Activity: %v", kinds)
		}
		if act.LastSeq != act.Items[len(act.Items)-1].Seq {
			t.Fatalf("last_seq %d", act.LastSeq)
		}
		page := got(bot.ListActivityWithResponse(ctx, &client.ListActivityParams{After: &act.LastSeq})).want(t, http.StatusOK).JSON200
		if len(page.Items) != 0 || page.LastSeq != act.LastSeq {
			t.Fatalf("after the last entry: %+v", page)
		}
	})
}

// Idempotency-Key over HTTP: a retry gets the stored response; the same key on another request is
// refused; a secret is never kept, so a retried token issue says so.
func TestIdempotencyKeys(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		p := &client.CreateTeamParams{IdempotencyKey: key("team")}
		first := got(h.admin.CreateTeamWithResponse(ctx, p, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		retry := got(h.admin.CreateTeamWithResponse(ctx, p, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		if !bytes.Equal(first.Body, retry.Body) {
			t.Fatalf("retry answered %s, first %s", retry.Body, first.Body)
		}
		reused := got(h.admin.CreateTeamWithResponse(ctx, p, client.CreateTeamBody{Key: "API", Name: "API"})).want(t, http.StatusUnprocessableEntity)
		if reused.JSONDefault.Code != client.ErrorCodeIdempotencyKeyReused {
			t.Fatalf("reused key: %s", reused.Body)
		}
		teams := got(h.admin.ListTeamsWithResponse(ctx)).want(t, http.StatusOK).JSON200
		if len(teams.Items) != 1 {
			t.Fatalf("%d Teams", len(teams.Items))
		}
		tp := &client.IssueTokenParams{IdempotencyKey: key("tok")}
		tok := got(h.admin.IssueTokenWithResponse(ctx, "ada", tp, client.IssueTokenBody{Name: "laptop"})).want(t, http.StatusCreated)
		if !strings.HasPrefix(tok.JSON201.Secret, "dk_") {
			t.Fatalf("token %s", tok.Body)
		}
		again := got(h.admin.IssueTokenWithResponse(ctx, "ada", tp, client.IssueTokenBody{Name: "laptop"})).want(t, http.StatusConflict)
		if strings.Contains(string(again.Body), tok.JSON201.Secret) {
			t.Fatal("a retry showed the secret again")
		}
	})
}

// A login link signs a browser in once: the cookie maps to a browser Session, and logging out
// ends it.
func TestLoginLinkSignsInABrowser(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		link := got(h.admin.IssueLoginLinkWithResponse(ctx, "ada", &client.IssueLoginLinkParams{})).want(t, http.StatusCreated).JSON201
		if !strings.HasPrefix(link.URL, h.ts.URL+"/v1/login-links/") || link.ExpiresAt.Sub(time.Now()) > 15*time.Minute {
			t.Fatalf("link %+v", link)
		}
		res := redeem(t, h.ts, strings.TrimPrefix(link.URL, h.ts.URL))
		if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/" {
			t.Fatalf("redeem: %d to %q", res.StatusCode, res.Header.Get("Location"))
		}
		var cookie *http.Cookie
		for _, ck := range res.Cookies() {
			if ck.Name == "darkory_session" {
				cookie = ck
			}
		}
		if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Value == "" {
			t.Fatalf("cookie %+v", cookie)
		}
		withCookie := func(method, path string) *http.Response {
			req, _ := http.NewRequest(method, h.ts.URL+path, nil)
			req.AddCookie(cookie)
			req.Header.Set("Origin", h.ts.URL) // as the web app's own pages send
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			return res
		}
		me := withCookie(http.MethodGet, "/v1/me")
		var body client.Me
		decode(t, me, &body)
		if me.StatusCode != http.StatusOK || body.Member.Name != "ada" || body.Session.Kind != client.SessionKindBrowser {
			t.Fatalf("me with the cookie: %d %+v", me.StatusCode, body)
		}
		// The link works once: a program posting it again is told not_found, and a browser
		// opening it sees a page saying so.
		again, _ := http.NewRequest(http.MethodPost, link.URL, nil)
		again.Header.Set("Origin", h.ts.URL)
		res, err := http.DefaultClient.Do(again)
		if err != nil {
			t.Fatal(err)
		}
		assertError(t, res, http.StatusNotFound, "not_found")
		res, err = http.Get(link.URL)
		if err != nil {
			t.Fatal(err)
		}
		page, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound || !strings.Contains(string(page), "does not work") {
			t.Fatalf("a used link opened again: %d %s", res.StatusCode, page)
		}

		if res := withCookie(http.MethodPost, "/v1/logout"); res.StatusCode != http.StatusNoContent {
			t.Fatalf("logout: %d", res.StatusCode)
		}
		assertError(t, withCookie(http.MethodGet, "/v1/me"), http.StatusUnauthorized, "unauthenticated")
	})
}

// The Activity stream sends each entry with its sequence number as the event id, keeps an idle
// connection alive, and resumes after Last-Event-ID.
func TestActivityStream(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		before := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200.LastSeq

		// Last-Event-ID 0 asks for the whole history.
		stream := h.openStream(t, "0")
		ids := stream.events(t, int(before))
		if ids[len(ids)-1] != before {
			t.Fatalf("the stream started with %v, want 1…%d", ids, before)
		}
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		if got := stream.events(t, 1); got[0] != before+1 {
			t.Fatalf("the new entry came as %v", got)
		}
		if !stream.keepAlive(t) {
			t.Fatal("no keep-alive comment on an idle stream")
		}
		stream.close()

		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "API", Name: "API"})).want(t, http.StatusCreated)
		resumed := h.openStream(t, strconv.FormatInt(before+1, 10))
		defer resumed.close()
		if got := resumed.events(t, 1); got[0] != before+2 {
			t.Fatalf("resumed after %d with %v", before+1, got)
		}
	})
}

// The stream sends a comment the moment it opens. A proxy that holds the headers back until the
// body's first bytes, as Vite's dev proxy does, then shows the client connected at once rather
// than at the first event or keep-alive, which here is an hour away.
func TestActivityStreamSendsItsFirstBytesAtOnce(t *testing.T) {
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{KeepAlive: time.Hour})
	stream := h.openStream(t, "")
	defer stream.close()
	first := make(chan string, 1)
	go func() {
		line, _ := stream.r.ReadString('\n')
		first <- line
	}()
	select {
	case line := <-first:
		if line != ": connected\n" {
			t.Fatalf("the stream opened with %q, want the comment \": connected\"", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no bytes within two seconds of the stream opening")
	}
}

type sseStream struct {
	res *http.Response
	r   *bufio.Reader
}

func (h *harness) openStream(t *testing.T, lastEventID string) *sseStream {
	t.Helper()
	return h.openStreamAs(t, h.adminSecret, "ada-stream", lastEventID)
}

func (h *harness) openStreamAs(t *testing.T, secret, session, lastEventID string) *sseStream {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, h.ts.URL+"/v1/activity/stream", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Darkory-Session", session)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("stream: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	return &sseStream{res: res, r: bufio.NewReader(res.Body)}
}

// events reads n events and returns their ids, checking each is an activity event.
func (s *sseStream) events(t *testing.T, n int) []int64 {
	t.Helper()
	var ids []int64
	var id int64
	var kind string
	deadline := time.AfterFunc(5*time.Second, func() { s.res.Body.Close() })
	defer deadline.Stop()
	for len(ids) < n {
		line, err := s.r.ReadString('\n')
		if err != nil {
			t.Fatalf("read the stream after %v: %v", ids, err)
		}
		line = strings.TrimRight(line, "\n")
		switch {
		case strings.HasPrefix(line, "id: "):
			id, _ = strconv.ParseInt(line[4:], 10, 64)
		case strings.HasPrefix(line, "event: "):
			kind = line[7:]
		case strings.HasPrefix(line, "data: "):
			if kind != "activity" || !strings.Contains(line, `"seq":`+strconv.FormatInt(id, 10)) {
				t.Fatalf("event %d %q: %s", id, kind, line)
			}
			ids = append(ids, id)
		}
	}
	return ids
}

// keepAlive reads until a keep-alive comment arrives; the comment a stream opens with is not one.
func (s *sseStream) keepAlive(t *testing.T) bool {
	deadline := time.AfterFunc(5*time.Second, func() { s.res.Body.Close() })
	defer deadline.Stop()
	for {
		line, err := s.r.ReadString('\n')
		if err != nil {
			return false
		}
		if line == ": keep-alive\n" {
			return true
		}
	}
}

func (s *sseStream) close() { s.res.Body.Close() }

// rest reads until the server ends the stream and returns the ids of the events it sent; it fails
// the test when the stream is still open after five seconds.
func (s *sseStream) rest(t *testing.T) []int64 {
	t.Helper()
	var timedOut atomic.Bool
	deadline := time.AfterFunc(5*time.Second, func() { timedOut.Store(true); s.res.Body.Close() })
	defer deadline.Stop()
	var ids []int64
	for {
		line, err := s.r.ReadString('\n')
		if err != nil {
			if timedOut.Load() {
				t.Fatalf("the stream is still open after five seconds, having sent %v", ids)
			}
			return ids
		}
		if strings.HasPrefix(line, "id: ") {
			id, _ := strconv.ParseInt(strings.TrimSpace(line[4:]), 10, 64)
			ids = append(ids, id)
		}
	}
}

func ptrInt(n int) *int { return &n }

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
