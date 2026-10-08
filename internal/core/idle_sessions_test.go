package core_test

import (
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// sessions lists a Member's Sessions in state ("" or "open", or "ended") as the admin.
func (f *fixture) sessions(member, state string) core.SessionPage {
	f.t.Helper()
	p, err := f.svc.ListSessions(f.t.Context(), f.admin, member, state, 0, "")
	if err != nil {
		f.t.Fatal(err)
	}
	return p
}

func sessionIDs(p core.SessionPage) []string {
	ids := make([]string, len(p.Items))
	for i, s := range p.Items {
		ids[i] = s.ID
	}
	return ids
}

// A token Session nothing has come through for the idle limit (15 minutes) has ended: it is no
// longer listed open, a long request in it stops, and its id starts a new Session. The owner's
// Install had every agent with 6–8 Sessions open hours after the Runners that opened them stopped.
func TestTokenSessionsEndWhenIdle(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		bob := f.member("bob", []string{"WEB"}, nil)
		started := f.clock.Now()

		f.clock.Advance(auth.DefaultTokenIdle - time.Second)
		if p := f.sessions("bob", ""); len(p.Items) != 1 || p.Open != 1 || p.Ended != 0 {
			t.Fatalf("within the limit: %+v", p)
		}
		if ok, err := f.svc.CallerValid(ctx, bob); err != nil || !ok {
			t.Fatalf("a Session within the idle limit is not valid: %v, %v", ok, err)
		}

		f.clock.Advance(2 * time.Second)
		if p := f.sessions("bob", ""); len(p.Items) != 0 || p.Open != 0 || p.Ended != 1 {
			t.Fatalf("past the limit, open: %+v", p)
		}
		ended := f.sessions("bob", "ended")
		if len(ended.Items) != 1 || ended.Items[0].ID != "bob-1" || ended.Items[0].ClosedAt != nil ||
			ended.Items[0].EndedAt == nil || !ended.Items[0].EndedAt.Equal(started.Add(auth.DefaultTokenIdle)) {
			t.Fatalf("past the limit, ended: %+v", ended.Items)
		}
		if ok, _ := f.svc.CallerValid(ctx, bob); ok {
			t.Fatal("a long request goes on in an idle Session")
		}

		// The same id comes back: the idle row is closed and a new Session starts.
		again := f.session(bob.MemberID, "bob-1")
		if again.SessionID == bob.SessionID {
			t.Fatal("an idle Session was revived")
		}
		if n := f.count(`SELECT COUNT(*) FROM sessions WHERE id = $1 AND closed_at = $2`, bob.SessionID, f.clock.Now().UnixMilli()); n != 1 {
			t.Fatal("the idle Session was not closed when its id came back")
		}
		if p := f.sessions("bob", ""); len(p.Items) != 1 || p.Items[0].ID != "bob-1" || p.Open != 1 || p.Ended != 1 {
			t.Fatalf("after the id came back: %+v", p)
		}
		if ended := f.sessions("bob", "ended"); len(ended.Items) != 1 || ended.Items[0].ClosedAt == nil || !ended.Items[0].EndedAt.Equal(*ended.Items[0].ClosedAt) {
			t.Fatalf("the closed idle Session lists as %+v", ended.Items)
		}

		// The sweep closes the rest, recording no Activity: no Claim ends with them.
		f.session(bob.MemberID, "bob-2")
		before := f.checkActivity()
		f.clock.Advance(auth.DefaultTokenIdle + time.Minute)
		// bob's two, and the admin's own.
		n, err := f.svc.SweepSessions(ctx)
		if err != nil || n != 3 {
			t.Fatalf("sweep closed %d, %v", n, err)
		}
		if n, err := f.svc.SweepSessions(ctx); err != nil || n != 0 {
			t.Fatalf("a second sweep closed %d, %v", n, err)
		}
		if p := f.sessions("bob", ""); p.Open != 0 || p.Ended != 3 {
			t.Fatalf("after the sweep: %+v", p)
		}
		if got := sessionIDs(f.sessions("bob", "ended")); len(got) != 3 || got[2] != "bob-1" {
			t.Fatalf("ended, most recently ended first: %v", got)
		}
		if f.checkActivity() != before {
			t.Fatal("closing idle Sessions recorded Activity")
		}
	})
}

// A token Session holding a live Claim with a long heartbeat timeout does not end while the
// Claim is live, however long it is quiet; once the Claim lapses, it does.
func TestAnIdleSessionHoldingALiveClaimStaysOpen(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		f.claim(f.a, f.task.Key, timeout(time.Hour))
		f.clock.Advance(50 * time.Minute)
		if ok, err := f.svc.CallerValid(ctx, f.a); err != nil || !ok {
			t.Fatalf("the Session of a live Claim ended while idle: %v, %v", ok, err)
		}
		// bob's and the admin's Sessions, idle, close; alice's holds a live Claim.
		if n, err := f.svc.SweepSessions(ctx); err != nil || n != 2 {
			t.Fatalf("the sweep closed %d, %v", n, err)
		}
		if p := f.sessions("alice", ""); len(p.Items) != 1 || p.Items[0].ID != f.a.ChosenID {
			t.Fatalf("open: %+v", p)
		}
		// A Heartbeat keeps the Claim; it is still the Session's.
		if hb, err := f.svc.Heartbeat(ctx, f.a, f.task.Key); err != nil || hb.Status != "ok" {
			t.Fatalf("heartbeat = %+v, %v", hb, err)
		}

		f.clock.Advance(time.Hour + time.Second)
		if _, err := f.svc.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if n, err := f.svc.SweepSessions(ctx); err != nil || n != 1 {
			t.Fatalf("after the lapse the sweep closed %d, %v", n, err)
		}
		if ok, _ := f.svc.CallerValid(ctx, f.a); ok {
			t.Fatal("the Session outlived its Claim's lapse by the idle limit")
		}
	})
}

// A Session kept busy only by a long request — an Activity stream — is touched as it goes, and
// so never goes idle.
func TestTouchingASessionKeepsItOpen(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		bob := f.member("bob", []string{"WEB"}, nil)
		for range 4 {
			f.clock.Advance(auth.DefaultTokenIdle - time.Minute)
			if err := f.svc.TouchSession(ctx, bob); err != nil {
				t.Fatal(err)
			}
		}
		if ok, err := f.svc.CallerValid(ctx, bob); err != nil || !ok {
			t.Fatalf("a touched Session ended: %v, %v", ok, err)
		}
		if n := f.count(`SELECT COUNT(*) FROM sessions WHERE id = $1 AND last_seen_at = $2`, bob.SessionID, f.clock.Now().UnixMilli()); n != 1 {
			t.Fatal("the touch was not recorded")
		}
	})
}

// listSessions refuses a state it does not know.
func TestListSessionsState(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		_, err := f.svc.ListSessions(t.Context(), f.admin, "ada", "closed", 0, "")
		wantCode(t, err, core.CodeInvalid)
	})
}
