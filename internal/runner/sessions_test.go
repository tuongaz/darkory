package runner

import (
	"context"
	"log/slog"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// openSessions counts the open Sessions of the agent named name.
func (f *fixture) openSessions(st *store.Store, name string) int {
	f.t.Helper()
	var n int
	if err := st.QueryRow(f.t.Context(), `SELECT COUNT(*) FROM sessions WHERE member_id = $1 AND closed_at IS NULL`, shortid.Canonical(f.ids[name])).Scan(&n); err != nil {
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

// runningTasks are the keys of the Tasks the runner works now, sorted.
func runningTasks(r *Runner) []string {
	var keys []string
	for _, s := range r.Running() {
		keys = append(keys, s.Task)
	}
	slices.Sort(keys)
	return keys
}

// holds checks for d that r never runs more than n Shifts at once.
func holds(t *testing.T, r *Runner, n int, d time.Duration) {
	t.Helper()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for end := time.After(d); ; {
		if got := runningTasks(r); len(got) > n {
			t.Fatalf("%d Shifts at once (%v), at most %d", len(got), got, n)
		}
		select {
		case <-end:
			return
		case <-tick.C:
		}
	}
}

// holdsFor is how long a test watches that no more Shifts start: ten of the runner's Ticks, in
// which a free loop would take a waiting Task.
func (f *fixture) holdsFor() time.Duration { return 10 * f.timings.Tick }

// An agent runs as many Shifts at once as its settings say, one Session and one Claim each, on
// Tasks of its own; the next Task waits for one of them. A count lowered while two run takes
// effect as a Shift ends: the second loop takes no new Task.
func TestRunnerRunsAnAgentsShifts(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "agent", "set", "builder", "--shifts", "2")
	for _, title := range []string{"Cart page", "Totals", "Receipt"} {
		f.ok("ada", "file", "--project", "WEB", "--title", title)
	}
	r := f.run("builder")

	eventually(t, 20*time.Second, "two Shifts at once", func() bool { return len(r.Running()) == 2 })
	holds(t, r, 2, f.holdsFor())
	running := runningTasks(r)
	sessions := map[string]bool{}
	for _, s := range r.Running() {
		sessions[s.SessionID] = true
	}
	if len(sessions) != 2 {
		t.Fatalf("two Shifts in %d Sessions", len(sessions))
	}
	waiting := ""
	for _, k := range []string{"WEB-1", "WEB-2", "WEB-3"} {
		if !slices.Contains(running, k) {
			waiting = k
		}
	}
	if d := f.task(waiting); d.Task.Claim != nil {
		t.Fatalf("%s, the third Task, is held while two Shifts run", waiting)
	}

	f.ok("ada", "agent", "set", "builder", "--shifts", "1")
	for _, k := range running {
		if err := r.Stop(k); err != nil {
			t.Fatal(err)
		}
	}
	eventually(t, 20*time.Second, "one Shift once both ended", func() bool { return len(r.Running()) == 1 })
	holds(t, r, 1, f.holdsFor())
}

// With one Shift, as unless set, an agent works one Task at a time.
func TestRunnerRunsOneShiftUnlessSet(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	f.ok("ada", "file", "--project", "WEB", "--title", "Totals")
	r := f.run("builder")

	eventually(t, 20*time.Second, "one Shift", func() bool { return len(r.Running()) == 1 })
	holds(t, r, 1, f.holdsFor())
}

// A raised count takes effect within a Tick: the next loop starts and takes a waiting Task.
func TestRunnerRaisesAnAgentsShifts(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	f.ok("ada", "file", "--project", "WEB", "--title", "Totals")
	r := f.run("builder")
	eventually(t, 20*time.Second, "one Shift", func() bool { return len(r.Running()) == 1 })
	holds(t, r, 1, f.holdsFor())
	f.ok("ada", "agent", "set", "builder", "--shifts", "2")
	eventually(t, 20*time.Second, "two Shifts once the count is raised", func() bool { return len(r.Running()) == 2 })
}

// A paused agent's loops all take no work, and all take it again when it is resumed.
func TestRunnerPausesEveryShift(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "agent", "set", "builder", "--shifts", "2", "--paused")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	f.ok("ada", "file", "--project", "WEB", "--title", "Totals")
	r := f.run("builder")
	holds(t, r, 0, f.holdsFor())
	for _, k := range []string{"WEB-1", "WEB-2"} {
		if f.task(k).Task.Claim != nil {
			t.Fatalf("%s is held while the agent is paused", k)
		}
	}
	f.ok("ada", "agent", "set", "builder", "--paused=false")
	eventually(t, 20*time.Second, "two Shifts once resumed", func() bool { return len(r.Running()) == 2 })
}

// A revoked token stops every loop of the agent: its Shifts end, no loop takes another Task, and
// the runner says so once.
func TestRunnerStopsEveryShiftOfARevokedToken(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "agent", "set", "builder", "--shifts", "2")
	for _, title := range []string{"Cart page", "Totals", "Receipt"} {
		f.ok("ada", "file", "--project", "WEB", "--title", title)
	}
	r := f.run("builder")
	eventually(t, 20*time.Second, "two Shifts", func() bool { return len(r.Running()) == 2 })
	f.ok("ada", "token", "revoke", f.tokenIDs["builder"])
	a := r.agents[0]
	eventually(t, 30*time.Second, "every loop of the agent ended", func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return len(a.loops) == 0 && len(r.Running()) == 0
	})
	holds(t, r, 0, f.holdsFor())
	if n := strings.Count(f.log.String(), "the Install no longer accepts this agent's token"); n != 1 {
		t.Fatalf("the runner said %d times that the token is refused:\n%s", n, f.log)
	}
}

// A count lowered while a loop waits in next: the Task that loop then takes, above the count, is
// released unworked with a Note saying why, and the loop ends; one Shift runs.
func TestRunnerReleasesATaskTakenAboveALoweredCount(t *testing.T) {
	st := storetest.Open(t, store.SQLite)
	f := newFixture(t, st)
	f.timings.Wait = 30 * time.Second // both loops wait in next while the count is lowered
	f.workflow(buildOnly)
	f.agent("builder", "busy", "engineer")
	f.ok("ada", "agent", "set", "builder", "--shifts", "2")
	r := f.run("builder")
	eventually(t, 10*time.Second, "the runner running its agents", func() bool {
		return strings.Contains(f.log.String(), "the runner is running agents")
	})
	a := r.agents[0]
	eventually(t, 20*time.Second, "two loops waiting", func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return len(a.loops) == 2
	})
	// Both loops wait in next: each has dialled its pull Session, which then opens on the Install.
	eventually(t, 10*time.Second, "both loops waiting in next", func() bool {
		return f.openSessions(st, "builder") == 3 // its own, and each loop's pull Session
	})
	f.ok("ada", "agent", "set", "builder", "--shifts", "1")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	f.ok("ada", "file", "--project", "WEB", "--title", "Totals")
	// The loop below the count may take the released Task straight back: the Note says it was
	// released, whoever holds it now.
	eventually(t, 20*time.Second, "one Shift, and a Task released with the Note", func() bool {
		return len(r.Running()) == 1 &&
			(strings.Contains(notesOf(f.task("WEB-1")), shiftsLoweredNote) || strings.Contains(notesOf(f.task("WEB-2")), shiftsLoweredNote))
	})
	holds(t, r, 1, f.holdsFor())
}
