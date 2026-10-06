package core_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// statusFixture is one Team with a builder and a reviewer, a lead who files, an outsider in
// another Team, and a Feature the lead owns.
type statusFixture struct {
	*fixture
	builder, reviewer, lead, outsider *auth.Caller
	feature                           string
	ids                               map[string]string // Status name → id
}

func newStatusFixture(t *testing.T, st *store.Store) statusFixture {
	f := newFixture(t, st)
	f.team("WEB")
	f.team("OPS")
	f.skill("build")
	f.skill("review")
	sf := statusFixture{
		fixture:  f,
		builder:  f.member("builder", []string{"WEB"}, []string{"build"}),
		reviewer: f.member("reviewer", []string{"WEB"}, []string{"review"}),
		lead:     f.member("lead", []string{"WEB"}, nil),
		outsider: f.member("outsider", []string{"OPS"}, []string{"build"}),
	}
	sf.feature = f.feature(sf.lead, "WEB", "Checkout").Feature.ID
	sf.ids = map[string]string{}
	list, err := f.svc.ListStatuses(t.Context(), f.admin)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list {
		sf.ids[s.Name] = s.ID
	}
	return sf
}

// in says which Status the Task is in, by name.
func (f statusFixture) in(task string) string {
	f.t.Helper()
	d, err := f.svc.GetTask(f.t.Context(), f.admin, task)
	if err != nil {
		f.t.Fatal(err)
	}
	if d.Status.ID != d.Task.StatusID {
		f.t.Fatalf("Task %s: detail Status %s, Task's %s", d.Task.Key, d.Status.ID, d.Task.StatusID)
	}
	return d.Status.Name
}

func (f statusFixture) wantIn(task, status string) {
	f.t.Helper()
	if got := f.in(task); got != status {
		f.t.Fatalf("Task %s is in %s, want %s", task, got, status)
	}
}

// file files a Task needing build, in status when it is not empty.
func (f statusFixture) file(title, status string) core.Task {
	f.t.Helper()
	nt := core.NewTask{Feature: &f.feature, Title: title, Skill: ptrStr("build")}
	if status != "" {
		nt.Status = &status
	}
	d, err := f.svc.FileTask(f.t.Context(), f.lead, nt, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	if d.Status.ID != d.Task.StatusID {
		f.t.Fatalf("filed %s: detail Status %+v, Task's %s", d.Task.Key, d.Status, d.Task.StatusID)
	}
	return d.Task
}

func TestInitGivesTheDefaultStatuses(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		list, err := f.svc.ListStatuses(t.Context(), f.admin)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for i, s := range list {
			if s.Position != int64(i+1) {
				t.Errorf("%s at position %d, want %d", s.Name, s.Position, i+1)
			}
			got = append(got, s.Name+" "+s.Kind)
		}
		want := []string{"Backlog backlog", "Todo todo", "In progress in_progress", "In review in_progress", "Done done", "Dropped dropped"}
		if !slices.Equal(got, want) {
			t.Fatalf("Statuses %q, want %q", got, want)
		}
	})
}

// A Task is filed in the first todo Status unless it names an open one; Darkory files its Break
// downs and Retrospectives there too. Done and dropped are refused.
func TestFilingInAStatus(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		f.wantIn(f.file("Plain", "").Key, "Todo")
		f.wantIn(f.file("Later", "backlog").Key, "Backlog")
		f.wantIn(f.file("Reviewing", f.ids["In review"]).Key, "In review")
		d, err := f.svc.GetFeature(ctx, f.admin, f.feature)
		if err != nil {
			t.Fatal(err)
		}
		f.wantIn(d.Tasks[0].Key, "Todo") // the Break down
		for status, code := range map[string]core.Code{"Done": core.CodeUseComplete, "dropped": core.CodeUseDrop, "Someday": core.CodeNotFound} {
			_, err := f.svc.FileTask(ctx, f.lead, core.NewTask{Feature: &f.feature, Title: "x", Skill: ptrStr("build"), Status: &status}, core.Idem{})
			wantCode(t, err, code)
		}
	})
}

// A Backlog Task is not takeable: next passes over it and claim says why. Moved to Todo, it is.
func TestBacklogIsNotTakeable(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		later := f.file("Later", "Backlog")
		if f.takeable(f.builder)[later.ID] {
			t.Fatal("a Backlog Task is takeable")
		}
		if _, ok, err := f.svc.Next(ctx, f.builder, 0, noTimeout, core.Idem{}); err != nil || ok {
			t.Fatalf("next found %v, %v in the Backlog", ok, err)
		}
		_, err := f.svc.Claim(ctx, f.builder, later.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if _, err := f.svc.SetTaskStatus(ctx, f.lead, later.Key, "Todo", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, ok, err := f.svc.Next(ctx, f.builder, 0, noTimeout, core.Idem{})
		if err != nil || !ok || d.Task.ID != later.ID {
			t.Fatalf("next after moving to Todo: %v %v %v", d.Task.Key, ok, err)
		}
		if d.Status.Name != "In progress" || d.Task.StatusID != f.ids["In progress"] {
			t.Fatalf("next answered %+v", d.Status)
		}
		f.wantIn(later.Key, "In progress")
	})
}

// Darkory moves the Status on its own acts: a claim from todo to the first in_progress, release
// back to the first todo, complete to the first done, drop to the first dropped; Handover leaves
// it unless the holder names one, and a claim of a Task already in progress leaves it there.
func TestTheStatusFollowsTheWork(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		claim := func(c *auth.Caller, key string) core.TaskDetail {
			t.Helper()
			d, err := f.svc.Claim(ctx, c, key, noTimeout, core.Idem{})
			if err != nil {
				t.Fatal(err)
			}
			return d
		}
		task := f.file("Build", "")
		if d := claim(f.builder, task.Key); d.Status.Name != "In progress" || d.Task.StatusID != f.ids["In progress"] {
			t.Fatalf("claim answered %+v", d.Status)
		}
		f.wantIn(task.Key, "In progress")
		out, err := f.svc.Release(ctx, f.builder, task.Key, nil, core.Idem{})
		if err != nil || out.StatusID != f.ids["Todo"] {
			t.Fatalf("release answered %s, %v", out.StatusID, err)
		}
		f.wantIn(task.Key, "Todo")

		claim(f.builder, task.Key)
		out, err = f.svc.Handover(ctx, f.builder, task.Key, "review", nil, nil, core.Idem{})
		if err != nil || out.StatusID != f.ids["In progress"] {
			t.Fatalf("handover answered %s, %v", out.StatusID, err)
		}
		f.wantIn(task.Key, "In progress")
		claim(f.reviewer, task.Key)
		f.wantIn(task.Key, "In progress")
		inReview := "in review"
		out, err = f.svc.Handover(ctx, f.reviewer, task.Key, "build", &inReview, nil, core.Idem{})
		if err != nil || out.StatusID != f.ids["In review"] {
			t.Fatalf("handover to In review answered %s, %v", out.StatusID, err)
		}
		f.wantIn(task.Key, "In review")
		claim(f.builder, task.Key)
		f.wantIn(task.Key, "In review")
		for status, code := range map[string]core.Code{"Done": core.CodeUseComplete, "Dropped": core.CodeUseDrop} {
			_, err := f.svc.Handover(ctx, f.builder, task.Key, "review", &status, nil, core.Idem{})
			wantCode(t, err, code)
		}
		out, err = f.svc.Complete(ctx, f.builder, task.Key, nil, core.Idem{})
		if err != nil || out.StatusID != f.ids["Done"] {
			t.Fatalf("complete answered %s, %v", out.StatusID, err)
		}
		f.wantIn(task.Key, "Done")

		// The owner drops a held Task, and dropping the Feature drops the rest.
		held, waiting := f.file("Held", ""), f.file("Waiting", "Backlog")
		claim(f.builder, held.Key)
		if _, err := f.svc.DropTask(ctx, f.lead, held.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.wantIn(held.Key, "Dropped")
		d, err := f.svc.DropFeature(ctx, f.lead, f.feature, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.wantIn(waiting.Key, "Dropped")
		for _, tk := range d.Tasks {
			if tk.Kind == "retrospective" {
				f.wantIn(tk.Key, "Todo")
			}
		}
	})
}

// Every other end of a Claim returns an in_progress Task to the first todo Status: take-back, a
// revoked token, a closed Session, a deactivated Member. A Task moved elsewhere while held stays.
func TestEndingAClaimReturnsTheTaskToTodo(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		claim := func(c *auth.Caller, key string, o core.ClaimOptions) {
			t.Helper()
			if _, err := f.svc.Claim(ctx, c, key, o, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		taken := f.file("Taken back", "")
		claim(f.builder, taken.Key, noTimeout)
		if _, err := f.svc.TakeBack(ctx, f.lead, taken.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.wantIn(taken.Key, "Todo")

		closed := f.file("Session closed", "")
		claim(f.builder, closed.Key, timeout(time.Minute))
		if _, err := f.svc.CloseSession(ctx, f.builder, "builder-1", nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.wantIn(closed.Key, "Todo")

		builder := f.session(f.builder.MemberID, "builder-2")
		revoked := f.file("Token revoked", "")
		claim(builder, revoked.Key, timeout(time.Minute))
		toks, err := f.svc.ListTokens(ctx, f.admin, "builder")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.RevokeToken(ctx, f.admin, toks[0].ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.wantIn(revoked.Key, "Todo")

		// Another builder holds two: one stays in progress, one a Member moved to the Backlog.
		leaving := f.member("leaving", []string{"WEB"}, []string{"build"})
		gone, parked := f.file("Deactivated", ""), f.file("Parked", "")
		claim(leaving, gone.Key, noTimeout)
		claim(leaving, parked.Key, noTimeout)
		if _, err := f.svc.SetTaskStatus(ctx, f.lead, parked.Key, "Backlog", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.DeactivateMember(ctx, f.admin, "leaving", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.wantIn(gone.Key, "Todo")
		f.wantIn(parked.Key, "Backlog")
		f.checkActivity()
	})
}

// A lapse leaves its Task in progress, and takeable, until it is recorded. Recorded first by the
// sweeper, the Task returns to Todo and the next claim moves it to In progress; claimed first,
// the claim records the lapse, the Task stays in the Status it was in, and the sweeper finds
// nothing left to do.
func TestALapsedTaskInEitherOrder(t *testing.T) {
	for _, order := range []string{"lapse, sweep, claim", "lapse, claim, sweep"} {
		t.Run(order, func(t *testing.T) {
			storetest.Each(t, func(t *testing.T, st *store.Store) {
				ctx := t.Context()
				f := newStatusFixture(t, st)
				task := f.file("Review it", "")
				if _, err := f.svc.Claim(ctx, f.builder, task.Key, noTimeout, core.Idem{}); err != nil {
					t.Fatal(err)
				}
				inReview := "In review"
				if _, err := f.svc.Handover(ctx, f.builder, task.Key, "review", &inReview, nil, core.Idem{}); err != nil {
					t.Fatal(err)
				}
				other := f.member("other-reviewer", []string{"WEB"}, []string{"review"})
				if _, err := f.svc.Claim(ctx, f.reviewer, task.Key, timeout(10*time.Second), core.Idem{}); err != nil {
					t.Fatal(err)
				}
				f.wantIn(task.Key, "In review")
				f.clock.Advance(time.Minute)
				f.wantIn(task.Key, "In review")
				if !f.takeable(other)[task.ID] {
					t.Fatal("a Task whose Claim lapsed is not takeable before the lapse is recorded")
				}

				if order == "lapse, sweep, claim" {
					if n, err := f.svc.Sweep(ctx); err != nil || n != 1 {
						t.Fatalf("sweep recorded %d, %v", n, err)
					}
					f.wantIn(task.Key, "Todo")
					d, err := f.svc.Claim(ctx, other, task.Key, noTimeout, core.Idem{})
					if err != nil || d.Status.Name != "In progress" {
						t.Fatalf("claim after the sweep: %+v, %v", d.Status, err)
					}
					f.wantIn(task.Key, "In progress")
				} else {
					d, err := f.svc.Claim(ctx, other, task.Key, noTimeout, core.Idem{})
					if err != nil || d.Status.Name != "In review" {
						t.Fatalf("claim of the lapsed Task: %+v, %v", d.Status, err)
					}
					if n, err := f.svc.Sweep(ctx); err != nil || n != 0 {
						t.Fatalf("sweep after the claim recorded %d, %v", n, err)
					}
					f.wantIn(task.Key, "In review")
				}
				if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed' AND subject_id = $1`, task.ID); n != 1 {
					t.Fatalf("%d lapse records", n)
				}
				f.checkActivity()
			})
		})
	}
}

// The lapse a refused Heartbeat records returns the Task to Todo too.
func TestALateHeartbeatsLapseReturnsTheTaskToTodo(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		task := f.file("Build", "")
		if _, err := f.svc.Claim(ctx, f.builder, task.Key, timeout(10*time.Second), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		if hb, err := f.svc.Heartbeat(ctx, f.builder, task.Key); err != nil || hb.Status != "lapsed" {
			t.Fatalf("late heartbeat: %+v, %v", hb, err)
		}
		f.wantIn(task.Key, "Todo")
	})
}

// Any Member of the Feature's Team moves an open Task between the open kinds, held or not (ADR
// 0012, D3), and so do the Feature's owner and the Task's holder from outside the Team; nobody
// else may. Done and dropped are refused, an ended Task stays where it is (ended), and naming the
// Status it is in writes nothing.
func TestSettingATasksStatus(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		task := f.file("Build", "")
		if _, err := f.svc.Claim(ctx, f.builder, task.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		before := f.checkActivity()
		out, err := f.svc.SetTaskStatus(ctx, f.reviewer, task.Key, "in review", jsonIdem("move-1", "h"))
		if err != nil || out.StatusID != f.ids["In review"] || out.Claim == nil || out.Claim.HolderID != f.builder.MemberID {
			t.Fatalf("move by a Team Member: %+v, %v", out, err)
		}
		if _, err := f.svc.SetTaskStatus(ctx, f.reviewer, task.Key, "in review", jsonIdem("move-1", "h")); !isReplay(err) {
			t.Fatalf("a retry under the same key: %v", err)
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE kind = 'task.status_set' AND subject_id = $1`, task.ID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if want := `{"from":"` + f.ids["In progress"] + `","to":"` + f.ids["In review"] + `"}`; payload != want {
			t.Fatalf("task.status_set payload %s, want %s", payload, want)
		}
		if n := f.checkActivity(); n != before+1 {
			t.Fatalf("%d entries for one move", n-before)
		}
		if _, err := f.svc.SetTaskStatus(ctx, f.lead, task.Key, f.ids["In review"], core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.checkActivity(); n != before+1 {
			t.Fatal("naming the Status the Task is in wrote")
		}

		_, err = f.svc.SetTaskStatus(ctx, f.outsider, task.Key, "Todo", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.SetTaskStatus(ctx, f.builder, task.Key, "Done", core.Idem{})
		wantCode(t, err, core.CodeUseComplete)
		_, err = f.svc.SetTaskStatus(ctx, f.builder, task.Key, "Dropped", core.Idem{})
		wantCode(t, err, core.CodeUseDrop)
		_, err = f.svc.SetTaskStatus(ctx, f.builder, task.Key, "Someday", core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		// A question aimed at a Member of another Team: they move it while they hold it, not after.
		asked := f.member("asked", []string{"OPS"}, nil)
		question := f.aimed(f.lead, f.feature, "Which index?", "asked")
		_, err = f.svc.SetTaskStatus(ctx, asked, question.Key, "In review", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if _, err := f.svc.Claim(ctx, asked, question.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.SetTaskStatus(ctx, asked, question.Key, "In review", core.Idem{}); err != nil {
			t.Fatalf("the holder from another Team: %v", err)
		}
		if _, err := f.svc.Release(ctx, asked, question.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.SetTaskStatus(ctx, asked, question.Key, "Backlog", core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		// The Feature's owner from another Team moves a Task another Member holds.
		if _, err := f.svc.PassFeatureOwnership(ctx, f.lead, f.feature, "outsider", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.SetTaskStatus(ctx, f.outsider, task.Key, "In progress", core.Idem{}); err != nil {
			t.Fatalf("the owner from another Team: %v", err)
		}

		if _, err := f.svc.Complete(ctx, f.builder, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.SetTaskStatus(ctx, f.lead, task.Key, "Todo", core.Idem{})
		wantCode(t, err, core.CodeEnded)
		f.wantIn(task.Key, "Done")
	})
}

func isReplay(err error) bool {
	var r *core.Replay
	return errors.As(err, &r)
}

// An admin replaces the list: renames, reorders, adds and deletes Statuses, moving the Tasks of a
// deleted one. A list that loses a kind Darkory moves Tasks to, a deleted Status Tasks are in
// without a move, and any change that would move a Task out of how it ended, are refused.
func TestSettingTheStatuses(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		ids := f.ids
		in := func(id, name, kind string) core.StatusInput { return core.StatusInput{ID: id, Name: name, Kind: kind} }
		defaults := []core.StatusInput{
			in(ids["Backlog"], "Backlog", "backlog"), in(ids["Todo"], "Todo", "todo"), in(ids["In progress"], "In progress", "in_progress"),
			in(ids["In review"], "In review", "in_progress"), in(ids["Done"], "Done", "done"), in(ids["Dropped"], "Dropped", "dropped"),
		}
		reviewing := f.file("Reviewing", "In review")
		done := f.file("Done already", "")
		if _, err := f.svc.Claim(ctx, f.builder, done.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Complete(ctx, f.builder, done.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}

		_, err := f.svc.SetStatuses(ctx, f.lead, defaults, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		before := f.checkActivity()
		if _, err := f.svc.SetStatuses(ctx, f.admin, defaults, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.checkActivity() != before {
			t.Fatal("setting the list as it is wrote")
		}

		refusals := []struct {
			name  string
			items []core.StatusInput
			moves map[string]string
			code  core.Code
		}{
			{"no todo", without(defaults, 1), nil, core.CodeInvalid},
			{"no dropped", without(defaults, 5), nil, core.CodeInvalid},
			{"two names alike", append(slices.Clone(defaults), in("", "todo", "todo")), nil, core.CodeInvalid},
			{"an empty name", append(slices.Clone(defaults), in("", " ", "todo")), nil, core.CodeInvalid},
			{"a name spelled as an id", append(slices.Clone(defaults), in("", ids["Todo"], "todo")), nil, core.CodeInvalid},
			{"an unknown kind", append(slices.Clone(defaults), in("", "Someday", "someday")), nil, core.CodeInvalid},
			{"an unknown id", append(slices.Clone(defaults), in("01999999-9999-7999-8999-999999999999", "Ghost", "todo")), nil, core.CodeInvalid},
			{"an id twice", append(slices.Clone(defaults), in(ids["Todo"], "Todo again", "todo")), nil, core.CodeInvalid},
			{"In review deleted with a Task in it", without(defaults, 3), nil, core.CodeStatusInUse},
			{"its Task moved to Done", without(defaults, 3), map[string]string{ids["In review"]: ids["Done"]}, core.CodeInvalid},
			{"a move to a deleted Status", without(defaults, 3), map[string]string{ids["In review"]: ids["In review"]}, core.CodeInvalid},
			{"a move from a kept Status", defaults, map[string]string{ids["Todo"]: ids["Backlog"]}, core.CodeInvalid},
			{"Done, with a Task in it, made todo", replace(defaults, 4, in(ids["Done"], "Done", "todo"), in("", "Finished", "done")), nil, core.CodeStatusInUse},
		}
		for _, r := range refusals {
			_, err := f.svc.SetStatuses(ctx, f.admin, r.items, r.moves, core.Idem{})
			if codeOf(err) != r.code {
				t.Errorf("%s: err = %v, want %s", r.name, err, r.code)
			}
		}
		if f.checkActivity() != before {
			t.Fatal("a refused list wrote")
		}

		// Rename In review to Review, drop it after In progress's rename... in one list: Todo first,
		// Backlog second, In review deleted into a new kept Status, In progress renamed, a QA
		// Status added, and an empty Backlog made todo.
		list := []core.StatusInput{
			in(ids["Todo"], "Todo", "todo"), in(ids["Backlog"], "Ready", "todo"), in(ids["In progress"], "Doing", "in_progress"),
			in("", "QA", "in_progress"), in(ids["Done"], "Done", "done"), in(ids["Dropped"], "Dropped", "dropped"),
		}
		got, err := f.svc.SetStatuses(ctx, f.admin, list, map[string]string{ids["In review"]: ids["In progress"]}, jsonIdem("list-1", "h"))
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for i, s := range got {
			names = append(names, s.Name)
			if s.Position != int64(i+1) {
				t.Errorf("%s at %d", s.Name, s.Position)
			}
		}
		if want := []string{"Todo", "Ready", "Doing", "QA", "Done", "Dropped"}; !slices.Equal(names, want) {
			t.Fatalf("list %q, want %q", names, want)
		}
		f.wantIn(reviewing.Key, "Doing")
		f.wantIn(done.Key, "Done")
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'statuses.changed' AND subject_id = $1`, f.admin.OrgID); n != 1 {
			t.Fatalf("%d statuses.changed entries", n)
		}
		// Swapping two names in one list is not a clash.
		swapped := slices.Clone(list)
		swapped[0].Name, swapped[1].Name = "Ready", "Todo"
		swapped[3].ID = got[3].ID
		if _, err := f.svc.SetStatuses(ctx, f.admin, swapped, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.checkActivity()
	})
}

func without(items []core.StatusInput, i int) []core.StatusInput {
	return slices.Delete(slices.Clone(items), i, i+1)
}

func replace(items []core.StatusInput, i int, with ...core.StatusInput) []core.StatusInput {
	return slices.Insert(without(items, i), i, with...)
}

// Tasks list by Status, by id or name.
func TestListingTasksByStatus(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		later := f.file("Later", "Backlog")
		f.file("Now", "")
		for _, ref := range []string{"backlog", f.ids["Backlog"]} {
			p, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Status: &ref})
			if err != nil || len(p.Items) != 1 || p.Items[0].ID != later.ID {
				t.Fatalf("Tasks in %s: %+v, %v", ref, p.Items, err)
			}
		}
		ref := "Someday"
		_, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Status: &ref})
		wantCode(t, err, core.CodeNotFound)
	})
}

// Activity filters: a Member's entries include the lapses and take-backs that ended their Claims;
// a Team's are those about its Features and their Tasks; kinds pick exactly.
func TestFilteringActivity(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		ops := f.fixture.feature(f.outsider, "OPS", "Pager").Feature
		task := f.file("Build", "")
		if _, err := f.svc.Claim(ctx, f.builder, task.Key, timeout(10*time.Second), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		if _, err := f.svc.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Claim(ctx, f.builder, task.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.TakeBack(ctx, f.lead, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		kinds := func(q core.ActivityQuery) []string {
			t.Helper()
			q.Limit = 500
			p, err := f.svc.ListActivity(ctx, f.admin, q)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, a := range p.Items {
				out = append(out, a.Kind)
			}
			return out
		}
		got := kinds(core.ActivityQuery{Member: "builder"})
		for _, want := range []string{"task.claimed", "task.lapsed", "task.taken_back"} {
			if !slices.Contains(got, want) {
				t.Errorf("builder's Activity %v lacks %s", got, want)
			}
		}
		if slices.Contains(got, "feature.filed") {
			t.Errorf("builder's Activity %v holds the lead's filing", got)
		}
		if got := kinds(core.ActivityQuery{Kinds: []string{"task.lapsed", "task.taken_back"}}); !slices.Equal(got, []string{"task.lapsed", "task.taken_back"}) {
			t.Errorf("by kind: %v", got)
		}
		if got := kinds(core.ActivityQuery{Team: "OPS"}); !slices.Equal(got, []string{"feature.filed", "task.filed"}) {
			t.Errorf("OPS's Activity %v, want its Feature and Break down filed", got)
		}
		web := kinds(core.ActivityQuery{Team: "WEB", Member: "lead", Kinds: []string{"task.filed"}})
		if len(web) != 2 { // the Break down and Build
			t.Errorf("the lead's Task filings in WEB: %v", web)
		}
		// Paging backwards over a filter: the page is the matching entries just below before.
		p, err := f.svc.ListActivity(ctx, f.admin, core.ActivityQuery{Before: 1 << 53, Limit: 1, Kinds: []string{"task.claimed"}})
		if err != nil || len(p.Items) != 1 {
			t.Fatalf("latest claim: %+v, %v", p, err)
		}
		p, err = f.svc.ListActivity(ctx, f.admin, core.ActivityQuery{Before: p.FirstSeq, Limit: 1, Kinds: []string{"task.claimed"}})
		if err != nil || len(p.Items) != 1 || p.Items[0].Kind != "task.claimed" {
			t.Fatalf("the claim before it: %+v, %v", p, err)
		}
		_, err = f.svc.ListActivity(ctx, f.admin, core.ActivityQuery{Kinds: []string{"task.exploded"}})
		wantCode(t, err, core.CodeInvalid)
		_ = ops
	})
}

// A release races a Team Member moving the Task to the Backlog. Whichever commits first, the
// release answers with the Status it left the Task in: Todo when it ran first or the Task was in
// progress, Backlog when the move came first. Activity's order says which came first.
func TestRaceReleaseAgainstAStatusMove(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newStatusFixture(t, st)
		ctx := t.Context()
		task := f.file("Build", "")
		for i := range 20 {
			if _, err := f.svc.Claim(ctx, f.builder, task.Key, noTimeout, core.Idem{}); err != nil {
				t.Fatal(err)
			}
			var claimed int64
			if err := st.QueryRow(ctx, `SELECT MAX(seq) FROM activity WHERE subject_id = $1`, task.ID).Scan(&claimed); err != nil {
				t.Fatal(err)
			}
			moved := make(chan error, 1)
			go func() {
				_, err := f.svc.SetTaskStatus(ctx, f.lead, task.Key, "Backlog", core.Idem{})
				moved <- err
			}()
			out, err := f.svc.Release(ctx, f.builder, task.Key, nil, core.Idem{})
			if err != nil {
				t.Fatal(err)
			}
			if err := <-moved; err != nil {
				t.Fatal(err)
			}
			var released, move int64
			if err := st.QueryRow(ctx, `SELECT MAX(seq) FROM activity WHERE subject_id = $1 AND kind = 'task.released'`, task.ID).Scan(&released); err != nil {
				t.Fatal(err)
			}
			if err := st.QueryRow(ctx, `SELECT MAX(seq) FROM activity WHERE subject_id = $1 AND kind = 'task.status_set' AND seq > $2`, task.ID, claimed).
				Scan(&move); err != nil {
				t.Fatal(err)
			}
			want := "Todo"
			if move < released {
				want = "Backlog"
			}
			if out.StatusID != f.ids[want] {
				t.Fatalf("round %d: release answered %s; the move came %s it, so want %s", i, out.StatusID,
					map[bool]string{true: "before", false: "after"}[move < released], want)
			}
			if _, err := f.svc.SetTaskStatus(ctx, f.lead, task.Key, "Todo", core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		f.checkActivity()
	})
}
