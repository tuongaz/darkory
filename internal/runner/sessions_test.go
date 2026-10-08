package runner

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// openSessions counts the open Sessions of the agent named name.
func (f *fixture) openSessions(st *store.Store, name string) int {
	f.t.Helper()
	var n int
	if err := st.QueryRow(f.t.Context(), `SELECT COUNT(*) FROM sessions WHERE member_id = $1 AND closed_at IS NULL`, f.ids[name]).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

// A runner holds two Sessions per agent — its own, for reading and for writing as the agent
// outside a Claim, and the one the next Claim is made in, which the agent's session then works
// in — and closes every one when it stops, working or waiting. The owner's Install had every agent
// with 6–8 Sessions open, two per runner start, none ever closed.
func TestRunnerClosesItsSessionsWhenItStops(t *testing.T) {
	st := storetest.Open(t, store.SQLite)
	f := newFixture(t, st)
	f.agent("stuck", "hang", "engineer")
	f.agent("idle", "advance", "review")
	f.ok("ada", "file", "--project", "WEB", "--aim", "stuck", "--title", "Hang")

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(Config{URL: f.ts.URL, Data: f.data, Tokens: []Token{{Name: "stuck", Secret: f.tokens["stuck"]}, {Name: "idle", Secret: f.tokens["idle"]}},
		Timings: f.timings, Tmux: "off", Darkory: exe, Log: slog.New(slog.NewTextHandler(f.log, nil)), GitHub: f.gh})
	if err != nil {
		t.Fatal(err)
	}
	f.srv.AttachRunner(r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()

	eventually(t, 20*time.Second, "WEB-1 running, and both agents with their two Sessions", func() bool {
		return len(r.Running()) == 1 && f.openSessions(st, "stuck") == 2 && f.openSessions(st, "idle") == 2
	})
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the runner did not stop")
	}
	for _, a := range []string{"stuck", "idle"} {
		if n := f.openSessions(st, a); n != 0 {
			t.Fatalf("%s has %d Sessions open after the runner stopped:\n%s", a, n, f.log)
		}
	}
}

// The idle limit is three times the runner's Heartbeat timeout, so no Session the runner keeps
// in use is ever taken for idle.
func TestTheIdleLimitOutlastsTheRunnersHeartbeatTimeout(t *testing.T) {
	if auth.DefaultTokenIdle != 3*DefaultTimings.ClaimTimeout {
		t.Fatalf("the token Session idle limit %v is not three times the runner's Heartbeat timeout %v", auth.DefaultTokenIdle, DefaultTimings.ClaimTimeout)
	}
	if DefaultTimings.Wait >= time.Minute || DefaultTimings.Tick >= time.Minute {
		t.Fatalf("a runner Session can be quiet for a minute or more: %+v", DefaultTimings)
	}
}
