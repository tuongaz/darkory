package core_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The race suite (ADR 0004): every test runs on SQLite and on Postgres.

// builders makes Project WEB, whose Build Step (build) leads into Done ("pass") and to Parked, a
// hold ("park"), and n Members in it with the build Skill. Tasks are filed at Build in the
// Project it returns.
func builders(t *testing.T, st *store.Store, n int) (*fixture, []*auth.Caller, string) {
	f := newFixture(t, st)
	f.project("WEB")
	f.skill("build")
	if _, err := f.svc.SetWorkflow(t.Context(), f.admin, "WEB", core.WorkflowsInput{
		Steps:      []core.StepInput{{Name: "Build", Skill: ptrStr("build")}, {Name: "Parked"}},
		Connectors: []core.ConnectorInput{{From: "Build", Name: "pass"}, {From: "Build", To: ptrStr("Parked"), Name: "park"}},
	}, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	var out []*auth.Caller
	for i := range n {
		out = append(out, f.member(name("builder", i), []string{"WEB"}, []string{"build"}))
	}
	return f, out, "WEB"
}

// unexpected fails on any error that is not a refusal the domain names: no "database is locked",
// no serialization failure, no busy connection.
func unexpected(t *testing.T, err error) {
	t.Helper()
	var e *core.Error
	var r *core.Replay
	if err != nil && !errors.As(err, &e) && !errors.As(err, &r) {
		t.Errorf("unexpected error: %v", err)
	}
	if err != nil && (strings.Contains(err.Error(), "locked") || strings.Contains(err.Error(), "busy")) {
		t.Errorf("a lock error leaked: %v", err)
	}
}

func TestRaceFiftyClaimOneTask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 50)
		task := f.task(callers[0], project, "Contended", "Build")
		var won, lost atomic.Int64
		var wg sync.WaitGroup
		start := make(chan struct{})
		for _, c := range callers {
			wg.Go(func() {
				<-start
				_, err := f.svc.Claim(t.Context(), c, task.Key, timeout(time.Minute), core.Idem{})
				switch {
				case err == nil:
					won.Add(1)
				case codeOf(err) == core.CodeAlreadyClaimed:
					lost.Add(1)
				default:
					t.Errorf("claim: %v", err)
				}
			})
		}
		close(start)
		wg.Wait()
		if won.Load() != 1 || lost.Load() != 49 {
			t.Fatalf("%d won, %d already_claimed; want 1 and 49", won.Load(), lost.Load())
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1`, task.ID); n != 1 {
			t.Fatalf("%d Claim rows", n)
		}
		f.checkActivity()
	})
}

// Twenty callers of `next` over ten takeable Tasks: each Task is claimed once, ten callers win,
// and no caller comes back empty while a Task it could take remained.
func TestRaceNextHandsEachTaskOnce(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 20)
		for i := range 10 {
			f.task(callers[0], project, name("task", i), "Build")
		}
		var mu sync.Mutex
		claimed := map[string]string{}
		empty := 0
		var wg sync.WaitGroup
		start := make(chan struct{})
		for _, c := range callers {
			wg.Go(func() {
				<-start
				d, ok, err := f.svc.Next(t.Context(), c, 0, timeout(time.Minute), core.Idem{})
				if err != nil {
					t.Errorf("next: %v", err)
					return
				}
				mu.Lock()
				defer mu.Unlock()
				if !ok {
					empty++
					return
				}
				if prev, dup := claimed[d.Task.ID]; dup {
					t.Errorf("%s claimed by %s and %s", d.Task.Key, prev, c.Name)
				}
				claimed[d.Task.ID] = c.Name
			})
		}
		close(start)
		wg.Wait()
		if len(claimed) != 10 || empty != 10 {
			t.Fatalf("%d Tasks claimed, %d callers empty; want 10 and 10", len(claimed), empty)
		}
		for _, c := range callers {
			if left := f.takeable(c); len(left) > 0 {
				t.Fatalf("%s could still take %d Tasks", c.Name, len(left))
			}
		}
		f.checkActivity()
	})
}

// A waiting `next` claims a Task filed while it waits, woken by the write.
func TestNextWakesWhenATaskIsFiled(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 1)
		got := make(chan core.TaskDetail, 1)
		go func() {
			d, ok, err := f.svc.Next(t.Context(), callers[0], 20*time.Second, noTimeout, core.Idem{})
			if err != nil || !ok {
				t.Errorf("next = %v, %v", ok, err)
			}
			got <- d
		}()
		time.Sleep(100 * time.Millisecond)
		filed := f.task(callers[0], project, "Arrives", "Build")
		select {
		case d := <-got:
			if d.Task.ID != filed.ID {
				t.Fatalf("next claimed %s", d.Task.Key)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("next did not wake when a Task was filed")
		}
	})
}

// At a lapse the holder's late Heartbeat, a new claimer and the sweeper all meet the expired
// Claim: the claimer wins, the Heartbeat is refused, and the lapse is recorded exactly once.
func TestRaceClaimAgainstLateHeartbeat(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 2)
		holder, claimer := callers[0], callers[1]
		var tasks []core.Task
		for i := range 10 {
			task := f.task(holder, project, name("task", i), "Build")
			if _, err := f.svc.Claim(t.Context(), holder, task.ID, timeout(10*time.Second), core.Idem{}); err != nil {
				t.Fatal(err)
			}
			tasks = append(tasks, task)
		}
		f.clock.Advance(10 * time.Second)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for _, task := range tasks {
			wg.Go(func() {
				<-start
				hb, err := f.svc.Heartbeat(t.Context(), holder, task.ID)
				if err != nil || hb.Status != "lapsed" {
					t.Errorf("late heartbeat on %s = %+v, %v", task.Key, hb, err)
				}
			})
			wg.Go(func() {
				<-start
				if _, err := f.svc.Claim(t.Context(), claimer, task.ID, noTimeout, core.Idem{}); err != nil {
					t.Errorf("claim of a lapsed Claim on %s: %v", task.Key, err)
				}
			})
		}
		wg.Go(func() {
			<-start
			_, err := f.svc.Sweep(t.Context())
			unexpected(t, err)
		})
		close(start)
		wg.Wait()
		for _, task := range tasks {
			if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed' AND subject_id = $1`, task.ID); n != 1 {
				t.Errorf("%s: %d lapse records", task.Key, n)
			}
			if n := f.count(`SELECT COUNT(*) FROM tasks WHERE id = $1 AND claim_holder_id = $2`, task.ID, claimer.MemberID); n != 1 {
				t.Errorf("%s is not held by the claimer", task.Key)
			}
		}
		f.checkActivity()
	})
}

// Under concurrent writers of every kind, Activity is numbered without gaps in commit order: a
// reader that always asks for what follows the last number it saw misses nothing.
func TestRaceActivityIsGaplessInCommitOrder(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 8)
		ctx := t.Context()
		var tasks []core.Task
		for i := range 8 {
			tasks = append(tasks, f.task(callers[0], project, name("task", i), "Build"))
		}
		stop := make(chan struct{})
		var seen []int64
		readerDone := make(chan struct{})
		go func() {
			defer close(readerDone)
			var after int64
			for {
				// Look at stop before reading: an empty page read after every writer finished
				// means there is nothing left, but one read before may miss the last commit.
				stopped := false
				select {
				case <-stop:
					stopped = true
				default:
				}
				page, err := f.svc.ListActivity(ctx, f.admin, core.ActivityQuery{After: after, Limit: 50})
				if err != nil {
					t.Error(err)
					return
				}
				for _, a := range page.Items {
					seen = append(seen, a.Seq)
				}
				after = page.LastSeq
				if stopped && len(page.Items) == 0 {
					return
				}
			}
		}()
		var wg sync.WaitGroup
		for i, c := range callers {
			wg.Go(func() {
				for round := range 6 {
					task := tasks[(i+round)%len(tasks)]
					if _, err := f.svc.Claim(ctx, c, task.ID, timeout(time.Minute), core.Idem{}); err == nil {
						_, err := f.svc.Heartbeat(ctx, c, task.ID)
						unexpected(t, err)
						_, err = f.svc.Release(ctx, c, task.ID, nil, core.Idem{})
						unexpected(t, err)
					} else {
						unexpected(t, err)
					}
					_, err := f.svc.FileTask(ctx, c, core.NewTask{Project: &project, Title: "more", Step: ptrStr("Build")}, core.Idem{})
					unexpected(t, err)
				}
			})
		}
		wg.Wait()
		close(stop)
		<-readerDone
		n := f.checkActivity()
		if len(seen) != n {
			t.Fatalf("the reader saw %d entries of %d", len(seen), n)
		}
		for i, seq := range seen {
			if seq != int64(i+1) {
				t.Fatalf("the reader saw %d at position %d: an entry committed out of order", seq, i+1)
			}
		}
	})
}

// Concurrent retries under one Idempotency-Key make one write and all get its response.
func TestRaceIdempotentRetries(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 1)
		c := callers[0]
		task := f.task(c, project, "Once", "Build")
		for i := range 3 {
			f.task(c, project, name("spare", i), "Build")
		}
		for _, op := range []struct {
			name string
			run  func(core.Idem) (any, error)
		}{
			{"claim", func(idem core.Idem) (any, error) {
				return f.svc.Claim(t.Context(), c, task.ID, noTimeout, idem)
			}},
			{"next", func(idem core.Idem) (any, error) {
				d, _, err := f.svc.Next(t.Context(), c, 0, noTimeout, idem)
				return d, err
			}},
		} {
			idem := jsonIdem("retry-"+op.name, op.name)
			var mu sync.Mutex
			var bodies [][]byte
			firsts := 0
			var wg sync.WaitGroup
			start := make(chan struct{})
			for range 10 {
				wg.Go(func() {
					<-start
					res, err := op.run(idem)
					var replay *core.Replay
					mu.Lock()
					defer mu.Unlock()
					switch {
					case err == nil:
						firsts++
						bodies = append(bodies, mustJSON(t, res))
					case errors.As(err, &replay):
						bodies = append(bodies, replay.Body)
					default:
						t.Errorf("%s: %v", op.name, err)
					}
				})
			}
			close(start)
			wg.Wait()
			if firsts != 1 || len(bodies) != 10 {
				t.Fatalf("%s: %d first responses and %d bodies, want 1 and 10", op.name, firsts, len(bodies))
			}
			for _, b := range bodies[1:] {
				if !bytes.Equal(b, bodies[0]) {
					t.Fatalf("%s: retries got different responses:\n%s\n%s", op.name, bodies[0], b)
				}
			}
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE holder_id = $1`, c.MemberID); n != 2 {
			t.Fatalf("%d Claims, want one each for claim and next", n)
		}
		f.checkActivity()
	})
}

// Concurrent retries of a write on a held Task under one Idempotency-Key all get the first one's
// response, even when a retry reads the Task only after the first has ended the Claim: the e2e
// soak found the late retry refused not_holder instead.
func TestRaceIdempotentRetriesOfHeldWrites(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 1)
		c := callers[0]
		ctx := t.Context()
		for _, op := range []struct {
			name string
			run  func(task string, idem core.Idem) (any, error)
		}{
			{"release", func(task string, idem core.Idem) (any, error) { return f.svc.Release(ctx, c, task, nil, idem) }},
			{"advance", func(task string, idem core.Idem) (any, error) {
				return f.svc.Advance(ctx, c, task, "park", nil, idem)
			}},
			{"complete", func(task string, idem core.Idem) (any, error) { return f.svc.Complete(ctx, c, task, nil, idem) }},
		} {
			task := f.task(c, project, op.name, "Build")
			f.claim(c, task.Key, noTimeout)
			idem := jsonIdem("retry-"+op.name, op.name)
			var mu sync.Mutex
			var bodies [][]byte
			firsts := 0
			var wg sync.WaitGroup
			start := make(chan struct{})
			for range 10 {
				wg.Go(func() {
					<-start
					res, err := op.run(task.ID, idem)
					var replay *core.Replay
					mu.Lock()
					defer mu.Unlock()
					switch {
					case err == nil:
						firsts++
						bodies = append(bodies, mustJSON(t, res))
					case errors.As(err, &replay):
						bodies = append(bodies, replay.Body)
					default:
						t.Errorf("%s: %v", op.name, err)
					}
				})
			}
			close(start)
			wg.Wait()
			if firsts != 1 || len(bodies) != 10 {
				t.Fatalf("%s: %d first responses and %d bodies, want 1 and 10", op.name, firsts, len(bodies))
			}
			for _, b := range bodies[1:] {
				if !bytes.Equal(b, bodies[0]) {
					t.Fatalf("%s: retries got different responses:\n%s\n%s", op.name, bodies[0], b)
				}
			}
		}
		f.checkActivity()
	})
}

// One Idempotency-Key gives one answer, a rule's refusal included. A claim refused
// already_claimed, sent again under its key after the holder let go, gets the refusal back, not
// the Task. Two claims sent at once under one key while the holder releases get the same answer
// between them, and the one that wins lists the Claims as its write left them: the e2e soak found
// one refused and the other succeeding, with the released Claim shown lapsed.
func TestRaceIdempotentClaimsAgainstARelease(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f, callers, project := builders(t, st, 2)
		holder, claimer := callers[0], callers[1]
		ctx := t.Context()

		task := f.task(holder, project, "One after the other", "Build")
		f.claim(holder, task.ID, noTimeout)
		idem := jsonIdem("after-release", "claim "+task.ID)
		_, err := f.svc.Claim(ctx, claimer, task.ID, noTimeout, idem)
		wantCode(t, err, core.CodeAlreadyClaimed)
		refused := answerOf(t, idem, nil, err)
		if _, err := f.svc.Release(ctx, holder, task.ID, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, err := f.svc.Claim(ctx, claimer, task.ID, noTimeout, idem)
		if again := answerOf(t, idem, d, err); again.status != refused.status || !bytes.Equal(again.body, refused.body) {
			t.Errorf("a claim refused, sent again under its key once the Task was free, answered\n%d %s\nnot\n%d %s",
				again.status, again.body, refused.status, refused.body)
		}

		const n = 30
		var tasks []core.Task
		for i := range n {
			task := f.task(holder, project, name("task", i), "Build")
			f.claim(holder, task.ID, noTimeout)
			tasks = append(tasks, task)
		}
		answers := make([][2]answer, n)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i, task := range tasks {
			idem := jsonIdem(name("twins", i), "claim "+task.ID)
			for j := range answers[i] {
				wg.Go(func() {
					<-start
					d, err := f.svc.Claim(ctx, claimer, task.ID, noTimeout, idem)
					answers[i][j] = answerOf(t, idem, d, err)
				})
			}
			wg.Go(func() {
				<-start
				if _, err := f.svc.Release(ctx, holder, task.ID, nil, core.Idem{}); err != nil {
					t.Errorf("release %s: %v", task.Key, err)
				}
			})
		}
		close(start)
		wg.Wait()
		won := 0
		for i, task := range tasks {
			a, b := answers[i][0], answers[i][1]
			if a.status != b.status || !bytes.Equal(a.body, b.body) {
				t.Errorf("%s: two claims under one key answered differently:\n%d %s\n%d %s", task.Key, a.status, a.body, b.status, b.body)
				continue
			}
			held := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND holder_id = $2`, task.ID, claimer.MemberID)
			if a.status != 200 {
				if held != 0 {
					t.Errorf("%s: both claims were refused, and the claimer has %d Claims on it", task.Key, held)
				}
				continue
			}
			won++
			if held != 1 {
				t.Errorf("%s: the claimer has %d Claims on it", task.Key, held)
			}
			var claimed core.TaskDetail
			if err := json.Unmarshal(a.body, &claimed); err != nil {
				t.Fatal(err)
			}
			record, err := f.svc.GetTask(ctx, claimer, task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := claimEnds(claimed.Claims), claimEnds(record.Claims); got != want {
				t.Errorf("%s: the claim answered with the Claims\n%s\nbut its write left\n%s", task.Key, got, want)
			}
		}
		t.Logf("%d of %d Tasks claimed under their key, the rest refused under it", won, n)
		f.checkActivity()
	})
}

// claimEnds lists each Claim and how it ended.
func claimEnds(cs []core.Claim) string {
	var b strings.Builder
	for _, c := range cs {
		how := "open"
		if c.HowEnded != nil {
			how = *c.HowEnded
		}
		fmt.Fprintf(&b, "%s %s; ", c.ID, how)
	}
	return b.String()
}
