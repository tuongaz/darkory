package core_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// claimFixture is one Project whose Workflow is one Step, Build, carrying the build Skill and
// leading into Done; two builders; and a Task at Build.
type claimFixture struct {
	*fixture
	a, b *auth.Caller
	task core.Task
}

func newClaimFixture(t *testing.T, st *store.Store) claimFixture {
	f := newFixture(t, st)
	f.project("WEB")
	f.skill("build")
	f.chain("WEB", [2]string{"Build", "build"})
	a := f.member("alice", []string{"WEB"}, []string{"build"})
	b := f.member("bob", []string{"WEB"}, []string{"build"})
	return claimFixture{fixture: f, a: a, b: b, task: f.task(a, "WEB", "Build it", "Build")}
}

func (f claimFixture) activityKinds(subject string) []string {
	rows, err := f.st.Query(f.t.Context(), `SELECT kind FROM activity WHERE subject_id = $1 ORDER BY seq`, subject)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			f.t.Fatal(err)
		}
		out = append(out, k)
	}
	return out
}

// A Claim never starts before the Task's previous Claim ended. The e2e soak found a claim read
// before another Member's release committed, and run after it, recorded as starting before the
// release: its time is taken when it reads. Here the clock stands back to that moment; the claim
// is refused rather than recorded overlapping, and a claim at a later time takes the Task.
func TestClaimNeverStartsBeforeThePreviousClaimEnded(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		f.claim(f.a, f.task.Key, noTimeout)
		f.clock.Advance(10 * time.Second)
		if _, err := f.svc.Release(ctx, f.a, f.task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(-5 * time.Second)
		_, err := f.svc.Claim(ctx, f.b, f.task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if _, found, err := f.svc.Next(ctx, f.b, 0, noTimeout, core.Idem{}); err != nil || found {
			t.Fatalf("next at the earlier time: found %v, %v", found, err)
		}
		f.clock.Advance(10 * time.Second)
		d := f.claim(f.b, f.task.Key, noTimeout)
		if len(d.Claims) != 2 || d.Claims[1].StartedAt.Before(*d.Claims[0].EndedAt) {
			t.Fatalf("Claims %+v", d.Claims)
		}
		f.checkActivity()
	})
}

func TestClaimRecordsTheClaim(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		label := "claude-opus-5-5"
		d, err := f.svc.Claim(ctx, f.a, f.task.Key, core.ClaimOptions{Timeout: ptrDur(30 * time.Second), ModelLabel: &label}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		c := d.Task.Claim
		if c == nil || c.HolderID != f.a.MemberID || c.SessionID != "alice-1" || c.SkillVersion == nil || *c.SkillVersion != 1 ||
			*c.ModelLabel != label || c.Timeout != 30*time.Second || !c.ExpiresAt.Equal(epoch.Add(30*time.Second)) {
			t.Fatalf("claim %+v", c)
		}
		// The reply is what a read now shows.
		got, err := f.svc.GetTask(ctx, f.b, f.task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if a, b := mustJSON(t, d), mustJSON(t, got); !bytes.Equal(a, b) {
			t.Fatalf("claim replied\n%s\nbut the Task reads\n%s", a, b)
		}
		_, err = f.svc.Claim(ctx, f.b, f.task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeAlreadyClaimed)
		_, err = f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeAlreadyClaimed)
		if got := f.activityKinds(f.task.ID); len(got) != 2 || got[1] != "task.claimed" {
			t.Fatalf("Activity %v", got)
		}
	})
}

// A Claim with a timeout lapses at its expiry: the Task is takeable again, a late Heartbeat is
// refused even though nobody re-claimed it, and the lapse is recorded once.
func TestLapseAtExpiry(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, timeout(30*time.Second), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(20 * time.Second)
		hb, err := f.svc.Heartbeat(ctx, f.a, f.task.ID)
		if err != nil || hb.Status != "ok" || !hb.ExpiresAt.Equal(epoch.Add(50*time.Second)) {
			t.Fatalf("heartbeat = %+v, %v", hb, err)
		}
		f.clock.Advance(29 * time.Second)
		if f.takeable(f.b)[f.task.ID] {
			t.Fatal("takeable before the extended expiry")
		}
		f.clock.Advance(time.Second) // exactly at expiry
		if !f.takeable(f.b)[f.task.ID] {
			t.Fatal("not takeable once the Claim lapsed")
		}
		got, err := f.svc.GetTask(ctx, f.b, f.task.Key)
		if err != nil {
			t.Fatal(err)
		}
		if got.Task.Claim != nil || got.Claims[0].HowEnded == nil || *got.Claims[0].HowEnded != "lapsed" {
			t.Fatalf("a lapsed Claim reads %+v / %+v", got.Task.Claim, got.Claims[0])
		}
		for range 2 {
			hb, err = f.svc.Heartbeat(ctx, f.a, f.task.Key)
			if err != nil || hb.Status != "lapsed" {
				t.Fatalf("late heartbeat = %+v, %v", hb, err)
			}
		}
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed' AND subject_id = $1`, f.task.ID); n != 1 {
			t.Fatalf("%d lapse records", n)
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND how_ended = 'lapsed' AND ended_at = $2`,
			f.task.ID, epoch.Add(50*time.Second).UnixMilli()); n != 1 {
			t.Fatal("the Claim is not ended lapsed at its expiry")
		}
		// The lapsed holder may claim again.
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.checkActivity()
	})
}

// Whoever meets an expired Claim first records its lapse: here the next claimer, then the sweeper
// for another, and never twice.
func TestLapseIsRecordedByTheNextClaimerOrTheSweeper(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		other := f.fixture.task(f.a, "WEB", "Style it", "Build")
		for _, id := range []string{f.task.ID, other.ID} {
			if _, err := f.svc.Claim(ctx, f.a, id, timeout(10*time.Second), core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		f.clock.Advance(time.Minute)
		d, err := f.svc.Claim(ctx, f.b, f.task.Key, noTimeout, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if len(d.Claims) != 2 || *d.Claims[0].HowEnded != "lapsed" || d.Claims[1].HolderID != f.b.MemberID {
			t.Fatalf("claims after taking over a lapsed Claim: %+v", d.Claims)
		}
		if got := f.activityKinds(f.task.ID); len(got) != 4 || got[2] != "task.lapsed" || got[3] != "task.claimed" {
			t.Fatalf("Activity %v, want the lapse recorded before the new Claim", got)
		}
		n, err := f.svc.Sweep(ctx)
		if err != nil || n != 1 {
			t.Fatalf("sweep recorded %d, %v; want the one other lapse", n, err)
		}
		if n, err := f.svc.Sweep(ctx); err != nil || n != 0 {
			t.Fatalf("second sweep recorded %d, %v", n, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, f.a, other.Key); err != nil || hb.Status != "lapsed" {
			t.Fatalf("heartbeat after the sweep = %+v, %v", hb, err)
		}
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed'`); n != 2 {
			t.Fatalf("%d lapse records, want 2", n)
		}
		got, err := f.svc.GetTask(ctx, f.a, other.Key)
		if err != nil {
			t.Fatal(err)
		}
		if a, b := mustJSON(t, got.Claims), mustJSON(t, d.Claims[:1]); len(got.Claims) != 1 || *got.Claims[0].HowEnded != "lapsed" {
			t.Fatalf("swept Claim reads %s (claimer saw %s)", a, b)
		}
		f.checkActivity()
	})
}

// A Claim with a timeout is bound to its Session: a sibling Session of the same Member cannot
// write to it. A Claim without one is bound to the Member: any of their Sessions can.
func TestSessionBinding(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		sibling := f.session(f.a.MemberID, "alice-2")
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, timeout(time.Minute), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err := f.svc.Release(ctx, sibling, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		_, err = f.svc.Complete(ctx, sibling, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		_, err = f.svc.Heartbeat(ctx, sibling, f.task.Key)
		wantCode(t, err, core.CodeNotHolder)
		_, err = f.svc.Release(ctx, f.b, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		note := "handing back"
		if _, err := f.svc.Release(ctx, f.a, f.task.Key, &note, core.Idem{}); err != nil {
			t.Fatal(err)
		}

		// Bound to the Member: the sibling may finish it.
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if hb, err := f.svc.Heartbeat(ctx, sibling, f.task.Key); err != nil || hb.Status != "ok" || hb.ExpiresAt != nil {
			t.Fatalf("heartbeat on a Member-bound Claim = %+v, %v", hb, err)
		}
		done, err := f.svc.Complete(ctx, sibling, f.task.Key, nil, core.Idem{})
		if err != nil || done.State != "done" || done.Claim != nil {
			t.Fatalf("complete = %+v, %v", done, err)
		}
		got, err := f.svc.GetTask(ctx, f.a, f.task.Key)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Notes) != 1 || got.Notes[0].Body != note || len(got.Claims) != 2 ||
			*got.Claims[0].HowEnded != "released" || *got.Claims[1].HowEnded != "completed" {
			t.Fatalf("Task after release and complete: %+v", got)
		}
		if hb, err := f.svc.Heartbeat(ctx, f.a, f.task.Key); err != nil || hb.Status != "ended" {
			t.Fatalf("heartbeat after complete = %+v, %v", hb, err)
		}
		_, err = f.svc.Release(ctx, f.a, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		f.checkActivity()
	})
}

// Revoking a token, or closing a Session, ends the Claims bound to it at once, with Activity.
// Claims bound to the Member survive.
func TestRevokingATokenOrClosingASessionEndsItsClaims(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		memberBound := f.fixture.task(f.a, "WEB", "Member-bound", "Build")
		other := f.fixture.task(f.a, "WEB", "Other Session", "Build")
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, timeout(time.Minute), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Claim(ctx, f.a, memberBound.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		closing := f.session(f.a.MemberID, "alice-closing")
		if _, err := f.svc.Claim(ctx, closing, other.Key, timeout(time.Minute), core.Idem{}); err != nil {
			t.Fatal(err)
		}

		closed, err := f.svc.CloseSession(ctx, f.a, "alice-closing", nil, core.Idem{})
		if err != nil || closed.ClaimsEnded != 1 || closed.Session.ClosedAt == nil {
			t.Fatalf("close = %+v, %v", closed, err)
		}
		if !f.takeable(f.b)[other.ID] {
			t.Fatal("the closed Session's Claim still holds its Task")
		}

		tokens, err := f.svc.ListTokens(ctx, f.a, "alice")
		if err != nil || len(tokens) != 1 {
			t.Fatalf("tokens %v %v", tokens, err)
		}
		if _, err := f.svc.RevokeToken(ctx, f.b, tokens[0].ID, core.Idem{}); codeOf(err) != core.CodeForbidden {
			t.Fatalf("another Member revoked the token: %v", err)
		}
		if _, err := f.svc.RevokeToken(ctx, f.a, tokens[0].ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if !f.takeable(f.b)[f.task.ID] {
			t.Fatal("the revoked token's Claim still holds its Task")
		}
		if f.takeable(f.b)[memberBound.ID] {
			t.Fatal("revoking a token ended a Claim bound to the Member")
		}
		if _, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: f.secrets[f.a.MemberID], Session: "alice-1"}); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("a revoked token still authenticates: %v", err)
		}
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.claim_ended'`); n != 2 {
			t.Fatalf("%d claim-ended entries, want 2", n)
		}
		f.checkActivity()
	})
}

// A retry with the same Idempotency-Key gets the first response and writes nothing; the same key
// on a different request is refused.
func TestIdempotentClaim(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		idem := jsonIdem("k1", "claim-hash")
		first, err := f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, idem)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, idem)
		var replay *core.Replay
		if !errors.As(err, &replay) || !bytes.Equal(replay.Body, mustJSON(t, first)) {
			t.Fatalf("retry = %v, want the first response", err)
		}
		if err := f.svc.Lookup(ctx, f.a, jsonIdem("k1", "other")); codeOf(err) != core.CodeIdempotencyKeyReused {
			t.Fatalf("lookup with another request = %v", err)
		}
		// Keys belong to a Member: bob's k1 is his own.
		if _, err := f.svc.Release(ctx, f.a, f.task.Key, nil, jsonIdem("k2", "release")); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Claim(ctx, f.b, f.task.Key, noTimeout, jsonIdem("k1", "claim-hash")); err != nil {
			t.Fatal(err)
		}
		// Kept 24 hours.
		f.clock.Advance(25 * time.Hour)
		if err := f.svc.Lookup(ctx, f.a, idem); err != nil {
			t.Fatalf("an expired key still answers: %v", err)
		}
		f.checkActivity()
	})
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A waiting `next` stops when its Session is closed or its token revoked, before it claims
// anything; a claim from such a Session is refused even when its caller was read before.
func TestRevocationStopsLongRequestsAndClaims(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		if _, err := f.svc.Claim(ctx, f.a, f.task.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		// bob waits: nothing is takeable for him.
		done := make(chan error, 1)
		go func() {
			_, _, err := f.svc.Next(ctx, f.b, 20*time.Second, noTimeout, core.Idem{})
			done <- err
		}()
		time.Sleep(100 * time.Millisecond)
		if _, err := f.svc.CloseSession(ctx, f.admin, "bob-1", ptrStr("bob"), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			wantCode(t, err, core.CodeUnauthenticated)
		case <-time.After(5 * time.Second):
			t.Fatal("next kept waiting after its Session was closed")
		}
		task := f.fixture.task(f.a, "WEB", "Arrives later", "Build")
		_, err := f.svc.Claim(ctx, f.b, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeUnauthenticated)
		_, _, err = f.svc.Next(ctx, f.b, 0, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeUnauthenticated)
		if ok, err := f.svc.CallerValid(ctx, f.b); err != nil || ok {
			t.Fatalf("a closed Session is still valid: %v %v", ok, err)
		}

		// alice's token is revoked: her Session, read before, can no longer claim.
		tokens, err := f.svc.ListTokens(ctx, f.admin, "alice")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.RevokeToken(ctx, f.admin, tokens[0].ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.Claim(ctx, f.a, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeUnauthenticated)
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1`, task.ID); n != 0 {
			t.Fatalf("%d Claims made by ended Sessions", n)
		}
		f.checkActivity()
	})
}

// A Claim records the Skill of the Task's Step and its version, and moves nothing: the Task stays
// at its Step while held, released, lapsed or taken back, and only advancing moves it on.
func TestClaimRecordsTheStepsSkillAndMovesNothing(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		build := f.step("WEB", "Build")
		d := f.claim(f.a, f.task.Key, timeout(time.Minute))
		if d.Task.Claim.SkillID == nil || *d.Task.Claim.SkillID != f.skillID("build") || d.Task.StepID == nil || *d.Task.StepID != build ||
			d.Step == nil || d.Step.ID != build || len(d.Connectors) != 1 || d.Connectors[0].Name != "pass" {
			t.Fatalf("claimed: %+v at %+v, ways out %+v", d.Task.Claim, d.Step, d.Connectors)
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND skill_id = $2 AND skill_version = 1`, f.task.ID, f.skillID("build")); n != 1 {
			t.Fatal("the Claim's row does not record the Step's Skill")
		}
		since := *d.Task.StepSince
		if _, err := f.svc.Release(ctx, f.a, f.task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.claim(f.b, f.task.Key, timeout(time.Minute))
		f.clock.Advance(2 * time.Minute)
		if _, err := f.svc.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		got := f.get(f.task.Key)
		if got.Task.StepID == nil || *got.Task.StepID != build || !got.Task.StepSince.Equal(since) || got.Task.Claim != nil {
			t.Fatalf("after release and lapse the Task is at %v since %v, held by %+v", got.Task.StepID, got.Task.StepSince, got.Task.Claim)
		}
	})
}

// A lapsed Claim's Task is takeable at once, before anyone records the lapse; in either order —
// the sweeper first, then the claim, or the claim first, which records it, then the sweeper,
// which finds nothing — the lapse is recorded once and the Task stays at its Step.
func TestALapsedTaskInEitherOrder(t *testing.T) {
	for _, order := range []string{"lapse, sweep, claim", "lapse, claim, sweep"} {
		t.Run(order, func(t *testing.T) {
			storetest.Each(t, func(t *testing.T, st *store.Store) {
				f := newClaimFixture(t, st)
				ctx := t.Context()
				f.claim(f.a, f.task.Key, timeout(10*time.Second))
				f.clock.Advance(time.Minute)
				if !f.takeable(f.b)[f.task.ID] {
					t.Fatal("a Task whose Claim lapsed is not takeable before the lapse is recorded")
				}
				if order == "lapse, sweep, claim" {
					if n, err := f.svc.Sweep(ctx); err != nil || n != 1 {
						t.Fatalf("sweep recorded %d, %v", n, err)
					}
					if f.at(f.task.Key) != "Build" {
						t.Fatalf("after the sweep the Task is at %s", f.at(f.task.Key))
					}
					f.claim(f.b, f.task.Key, noTimeout)
				} else {
					d := f.claim(f.b, f.task.Key, noTimeout)
					if len(d.Claims) != 2 || *d.Claims[0].HowEnded != "lapsed" {
						t.Fatalf("the claim of the lapsed Task shows %+v", d.Claims)
					}
					if n, err := f.svc.Sweep(ctx); err != nil || n != 0 {
						t.Fatalf("sweep after the claim recorded %d, %v", n, err)
					}
				}
				if f.at(f.task.Key) != "Build" {
					t.Fatalf("the Task is at %s", f.at(f.task.Key))
				}
				if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed' AND subject_id = $1`, f.task.ID); n != 1 {
					t.Fatalf("%d lapse records", n)
				}
				f.checkActivity()
			})
		})
	}
}
