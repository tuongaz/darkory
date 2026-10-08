package core_test

import (
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Helpers for the flow tests.

func (f *fixture) complete(c *auth.Caller, ref string) core.Task {
	f.t.Helper()
	t, err := f.svc.Complete(f.t.Context(), c, ref, nil, core.Idem{})
	if err != nil {
		f.t.Fatalf("%s completes %s: %v", c.Name, ref, err)
	}
	return t
}

// kinds lists the kinds of the Activity entries about subject, in order.
func (f *fixture) kinds(subject string) string {
	f.t.Helper()
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
	return strings.Join(out, " ")
}

func (f *fixture) manager(member, manager string) {
	f.t.Helper()
	if err := f.svc.SetManager(f.t.Context(), f.admin, member, manager, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
}

// qaFlow is Project WEB with Build (build) → QA (qa) → Done, and QA → Build "fail".
func qaFlow(f *fixture) {
	f.project("WEB")
	f.skill("build")
	f.skill("qa")
	if _, err := f.svc.SetWorkflow(f.t.Context(), f.admin, "WEB", core.WorkflowInput{
		Steps: []core.StepInput{{Name: "Build", Skill: ptrStr("build")}, {Name: "QA", Skill: ptrStr("qa")}},
		Connectors: []core.ConnectorInput{
			{From: "Build", To: ptrStr("QA"), Name: "pass"},
			{From: "QA", Name: "pass"}, {From: "QA", To: ptrStr("Build"), Name: "fail"},
		},
	}, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
}

// Advance: the holder ends their work along the Connector named by the outcome, or the only one
// when they name none; the Claim ends advanced and the Task waits at the next Step for its Skill.
// A builder who also has qa cannot take the QA Step of their own Task, but takes it back under
// build when QA fails it: no one judges their own work (ADR 0001).
func TestAdvanceKeepsNoSelfReview(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		qaFlow(f)
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build", "qa"})
		tester := f.member("tester", []string{"WEB"}, []string{"qa"})
		task := f.task(lead, "WEB", "Build the form", "Build")

		f.claim(builder, task.Key, noTimeout)
		if _, err := f.svc.AddNote(ctx, builder, task.Key, "the form posts to /signup", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		// Only the holder advances, and only along a way out of its Step.
		_, err := f.svc.Advance(ctx, tester, task.Key, "pass", nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		_, err = f.svc.Advance(ctx, builder, task.Key, "ship it", nil, core.Idem{})
		wantCode(t, err, core.CodeNoConnector)
		if !strings.Contains(err.Error(), `"pass"`) {
			t.Fatalf("the refusal does not name the outcomes: %v", err)
		}
		wantDetail(t, err, "outcomes", "[pass]")

		f.clock.Advance(time.Hour)
		note := "ready for qa"
		out, err := f.svc.Advance(ctx, builder, task.Key, "", &note, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		qaStep, qa := f.step("WEB", "QA"), f.skillID("qa")
		if out.Claim != nil || out.StepID == nil || *out.StepID != qaStep || out.SkillID == nil || *out.SkillID != qa ||
			!out.WaitingSince.Equal(f.clock.Now()) || !out.StepSince.Equal(f.clock.Now()) {
			t.Fatalf("advanced %+v", out)
		}
		d := f.get(task.Key)
		if a, b := mustJSON(t, out), mustJSON(t, d.Task); string(a) != string(b) {
			t.Fatalf("advance replied\n%s\nbut the Task reads\n%s", a, b)
		}
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "advanced" || len(d.Notes) != 2 || d.Notes[1].Body != note {
			t.Fatalf("claims %+v notes %+v", d.Claims, d.Notes)
		}
		if len(d.Connectors) != 2 || d.Connectors[0].Name != "pass" || d.Connectors[1].Name != "fail" {
			t.Fatalf("the ways out of QA: %+v", d.Connectors)
		}

		// The builder has qa but held the Task under build: the QA Step is not theirs to take. An
		// hour on, their next request comes in a new Session: the one above has gone idle.
		builder = f.session(builder.MemberID, builder.ChosenID)
		if f.takeable(builder)[task.ID] {
			t.Fatal("the builder can take the QA Step of their own Task")
		}
		_, err = f.svc.Claim(ctx, builder, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if !f.takeable(tester)[task.ID] {
			t.Fatal("qa cannot take the Task")
		}
		f.claim(tester, task.Key, noTimeout)
		// Two ways out: an empty outcome names neither.
		_, err = f.svc.Advance(ctx, tester, task.Key, "", nil, core.Idem{})
		wantCode(t, err, core.CodeNoConnector)
		wantDetail(t, err, "outcomes", "[pass fail]")
		if back := f.advance(tester, task.Key, "FAIL"); back.StepID == nil || *back.StepID != f.step("WEB", "Build") {
			t.Fatalf("failed back to %v", back.StepID)
		}

		// Back at Build, the builder takes it again; the tester, who held it under qa, cannot.
		if f.takeable(tester)[task.ID] {
			t.Fatal("the tester can take the Build Step after reviewing it")
		}
		f.claim(builder, task.Key, noTimeout)
		d = f.get(task.Key)
		if len(d.Claims) != 3 || len(d.Notes) != 2 {
			t.Fatalf("claims %d notes %d", len(d.Claims), len(d.Notes))
		}
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.note_added task.advanced task.claimed task.advanced task.claimed" {
			t.Fatalf("Activity: %s", got)
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE subject_id = $1 AND kind = 'task.advanced' ORDER BY seq LIMIT 1`, task.ID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`"from":"` + f.step("WEB", "Build") + `"`, `"to":"` + qaStep + `"`, `"outcome":"pass"`, `"since":`} {
			if !strings.Contains(payload, want) {
				t.Errorf("task.advanced %s lacks %s", payload, want)
			}
		}
		f.checkActivity()
	})
}

// Complete is advancing along the one Connector into Done: refused use_advance from a Step with
// none or several, naming the outcomes. A Task aimed at a Member, at no Step, has no outcomes to
// advance along and completes as it is, whether completed or advanced.
func TestCompleteIsTheOneWayIntoDone(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		qaFlow(f)
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		tester := f.member("tester", []string{"WEB"}, []string{"qa"})
		task := f.task(lead, "WEB", "Build the form", "Build")
		f.claim(builder, task.Key, noTimeout)
		_, err := f.svc.Complete(ctx, builder, task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeUseAdvance)
		if !strings.Contains(err.Error(), `"pass"`) {
			t.Fatalf("the refusal does not name the outcomes: %v", err)
		}
		wantDetail(t, err, "outcomes", "[pass]")
		f.advance(builder, task.Key, "pass")
		f.claim(tester, task.Key, noTimeout)
		done := f.complete(tester, task.Key)
		if done.State != "done" || done.StepID != nil || done.StepSince != nil || done.EndedAt == nil || done.Claim != nil {
			t.Fatalf("completed %+v", done)
		}
		d := f.get(task.Key)
		if *d.Claims[1].HowEnded != "completed" || d.Step != nil || len(d.Connectors) != 0 {
			t.Fatalf("after Complete: claims %+v, step %+v", d.Claims, d.Step)
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE subject_id = $1 AND kind = 'task.completed'`, task.ID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(payload, `"from":"`+f.step("WEB", "QA")+`"`) || !strings.Contains(payload, `"outcome":"pass"`) {
			t.Fatalf("task.completed %s", payload)
		}

		// A question aimed at the lead has no outcomes to advance along: Complete ends it, and so
		// does advancing it, with an outcome or without.
		q := f.aimed(builder, "WEB", "Which provider?", "lead")
		if q.StepID != nil {
			t.Fatalf("an aimed Task is at Step %v", *q.StepID)
		}
		f.claim(lead, q.Key, noTimeout)
		if out := f.complete(lead, q.Key); out.State != "done" {
			t.Fatalf("the question %+v", out)
		}
		for _, outcome := range []string{"", "answered"} {
			q := f.aimed(builder, "WEB", "Which carrier? "+outcome, "lead")
			f.claim(lead, q.Key, noTimeout)
			out, err := f.svc.Advance(ctx, lead, q.Key, outcome, ptrStr("Use the cheaper one."), core.Idem{})
			if err != nil || out.State != "done" || out.Claim != nil || out.StepID != nil {
				t.Fatalf("advanced the question with %q: %+v, %v", outcome, out, err)
			}
			if d := f.get(q.Key); *d.Claims[0].HowEnded != "completed" || d.Notes[len(d.Notes)-1].Body != "Use the cheaper one." {
				t.Fatalf("after advancing with %q: claims %+v, notes %+v", outcome, d.Claims, d.Notes)
			}
		}
		f.checkActivity()
	})
}

// On a held Task, Notes and Observations are written only by the Member holding it, through the
// Session that holds it when the Claim has a timeout, and record the Skill they were made under.
// Observations always need the Claim; Notes on a Task nobody holds are TestNotesOnATaskNobodyHolds.
func TestNotesAndObservationsNeedTheClaim(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		_, err := f.svc.Observe(ctx, f.a, f.task.Key, "worked", "nobody holds it", core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		f.claim(f.a, f.task.Key, timeout(time.Minute))
		sibling := f.session(f.a.MemberID, "alice-2")
		for _, c := range []*auth.Caller{f.b, sibling} {
			_, err = f.svc.AddNote(ctx, c, f.task.Key, "not mine", core.Idem{})
			wantCode(t, err, core.CodeNotHolder)
			_, err = f.svc.Observe(ctx, c, f.task.Key, "worked", "not mine", core.Idem{})
			wantCode(t, err, core.CodeNotHolder)
		}
		_, err = f.svc.AddNote(ctx, f.a, f.task.Key, " ", core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.Observe(ctx, f.a, f.task.Key, "great", "x", core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		n, err := f.svc.AddNote(ctx, f.a, f.task.Key, "started", core.Idem{})
		if err != nil || n.AuthorID != f.a.MemberID || n.SkillID == nil || *n.SkillID != f.skillID("build") {
			t.Fatalf("note %+v, %v", n, err)
		}
		o, err := f.svc.Observe(ctx, f.a, f.task.Key, "didnt_work", "the build script needs a flag", core.Idem{})
		if err != nil || o.AuthorID != f.a.MemberID || o.SkillID == nil || *o.SkillID != f.skillID("build") || o.Outcome != "didnt_work" ||
			o.TaskID != f.task.ID || o.ReviewedByTaskID != nil {
			t.Fatalf("observation %+v, %v", o, err)
		}
		d := f.get(f.task.Key)
		if len(d.Notes) != 1 || len(d.Observations) != 1 || d.Observations[0].ID != o.ID {
			t.Fatalf("notes %+v observations %+v", d.Notes, d.Observations)
		}
		// A lapsed Claim writes no more Observations.
		f.clock.Advance(2 * time.Minute)
		_, err = f.svc.Observe(ctx, f.a, f.task.Key, "worked", "too late", core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		if got := f.kinds(f.task.ID); got != "task.filed task.claimed task.note_added task.observed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Anyone above the holder on their Reporting line, or the Task's Owner, takes a Claim back; the
// holder's next Heartbeat says so, and the Task stays at its Step. Nobody else may.
func TestTakeBack(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		f.skill("build")
		f.chain("WEB", [2]string{"Build", "build"})
		owner := f.member("owner", []string{"WEB"}, nil)
		holder := f.member("holder", []string{"WEB"}, []string{"build"})
		peer := f.member("peer", []string{"WEB"}, []string{"build"})
		f.member("lead", []string{"API"}, nil)
		head := f.member("head", []string{"API"}, nil)
		f.manager("holder", "lead")
		f.manager("lead", "head")
		task := f.task(owner, "WEB", "Build it", "Build")

		_, err := f.svc.TakeBack(ctx, head, task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		f.claim(holder, task.Key, timeout(time.Minute))
		_, err = f.svc.TakeBack(ctx, peer, task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		// Two steps up the Reporting line, from another Project.
		reason := "needed elsewhere"
		out, err := f.svc.TakeBack(ctx, head, task.Key, &reason, core.Idem{})
		if err != nil || out.Claim != nil || out.StepID == nil || *out.StepID != f.step("WEB", "Build") {
			t.Fatalf("take-back %+v, %v", out, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, holder, task.Key); err != nil || hb.Status != "taken_back" {
			t.Fatalf("heartbeat after take-back: %+v, %v", hb, err)
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND how_ended = 'taken_back' AND ended_by = $2`, task.ID, head.MemberID); n != 1 {
			t.Fatalf("%d Claims ended taken_back by head", n)
		}
		if !f.takeable(peer)[task.ID] {
			t.Fatal("the Task is not takeable after the take-back")
		}
		// The Task's Owner, who is on nobody's line.
		f.claim(peer, task.Key, noTimeout)
		if _, err := f.svc.TakeBack(ctx, owner, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.taken_back task.claimed task.taken_back" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Only the Task's Owner drops it, held or not; any Claim on it ends, it leaves its Step, and the
// Tasks it blocked are freed.
func TestDropTask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		owner := f.a // alice filed the Task, and owns it
		blocked := f.fixture.task(owner, "WEB", "After it", "Build")
		if err := f.svc.AddBlocker(ctx, owner, blocked.Key, f.task.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.claim(f.b, f.task.Key, timeout(time.Minute))
		_, err := f.svc.DropTask(ctx, f.b, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		out, err := f.svc.DropTask(ctx, owner, f.task.Key, ptrStr("not needed"), core.Idem{})
		if err != nil || out.State != "dropped" || out.Claim != nil || out.EndedAt == nil || out.StepID != nil {
			t.Fatalf("dropped %+v, %v", out, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, f.b, f.task.Key); err != nil || hb.Status != "ended" {
			t.Fatalf("heartbeat after drop: %+v, %v", hb, err)
		}
		d := f.get(f.task.Key)
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "dropped" {
			t.Fatalf("claims %+v", d.Claims)
		}
		_, err = f.svc.DropTask(ctx, owner, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		if !f.takeable(f.b)[blocked.ID] {
			t.Fatal("a Task blocked by a dropped Task is still blocked")
		}

		// A Claim that had run out unrecorded is recorded as lapsed, not dropped.
		f.claim(f.b, blocked.Key, timeout(time.Minute))
		f.clock.Advance(2 * time.Minute)
		if _, err := f.svc.DropTask(ctx, owner, blocked.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d = f.get(blocked.Key)
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "lapsed" {
			t.Fatalf("claims %+v", d.Claims)
		}
		if got := f.kinds(blocked.ID); got != "task.filed task.blocker_added task.claimed task.lapsed task.dropped" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// A human moves a Task to any Step of its Workflow by hand, which is the only way out of a hold:
// any Member of its Project or its Owner while nobody holds it; while it is held, only whoever
// may take it back, and the move ends the Claim taken_back first; anyone else in the Project is
// refused held, anyone outside it forbidden. The mover's Note goes with it. A Parent and an ended Task are
// at no Step to move from; a Task aimed at a Member waits at the Step instead.
func TestMove(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		peer := f.member("peer", []string{"WEB"}, []string{core.SkillEngineer})
		outsider := f.member("outsider", []string{"API"}, nil)
		task := f.task(lead, "WEB", "Later", "Backlog")
		if f.takeable(builder)[task.ID] {
			t.Fatal("a Task at a hold is offered to someone")
		}
		_, err := f.svc.Claim(ctx, builder, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if !strings.Contains(err.Error(), "hold") {
			t.Fatalf("the refusal does not say the Task is at a hold: %v", err)
		}
		_, err = f.svc.MoveTask(ctx, outsider, task.Key, "Build", nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.MoveTask(ctx, peer, task.Key, "Nowhere", nil, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		f.clock.Advance(time.Minute)
		out, err := f.svc.MoveTask(ctx, peer, task.Key, "build", nil, core.Idem{})
		if err != nil || out.StepID == nil || *out.StepID != f.step("WEB", "Build") || !out.StepSince.Equal(f.clock.Now()) {
			t.Fatalf("moved %+v, %v", out, err)
		}
		if again, err := f.svc.MoveTask(ctx, peer, task.Key, "Build", nil, core.Idem{}); err != nil || !again.StepSince.Equal(*out.StepSince) {
			t.Fatalf("moving it where it is: %+v, %v", again, err)
		}
		if !f.takeable(builder)[task.ID] {
			t.Fatal("the Task moved out of the hold is not takeable")
		}

		// Held: neither the holder's peer nor the holder may move it; its Owner may, and the Claim
		// ends taken_back.
		f.claim(builder, task.Key, timeout(time.Minute))
		_, err = f.svc.MoveTask(ctx, peer, task.Key, "Review", nil, core.Idem{})
		wantCode(t, err, core.CodeHeld)
		_, err = f.svc.MoveTask(ctx, builder, task.Key, "Review", nil, core.Idem{})
		wantCode(t, err, core.CodeHeld)
		_, err = f.svc.MoveTask(ctx, outsider, task.Key, "Review", nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		out, err = f.svc.MoveTask(ctx, lead, task.Key, "Review", ptrStr("the build is done; review it"), core.Idem{})
		if err != nil || out.Claim != nil || *out.StepID != f.step("WEB", "Review") {
			t.Fatalf("moved while held %+v, %v", out, err)
		}
		// The mover's Note goes with it, under no Skill.
		if d, err := f.svc.GetTask(ctx, lead, task.Key); err != nil || len(d.Notes) != 1 || d.Notes[0].AuthorID != lead.MemberID ||
			d.Notes[0].SkillID != nil || d.Notes[0].Body != "the build is done; review it" {
			t.Fatalf("the move's Note: %+v, %v", d.Notes, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, builder, task.Key); err != nil || hb.Status != "taken_back" {
			t.Fatalf("heartbeat after the move: %+v, %v", hb, err)
		}
		if got := f.kinds(task.ID); got != "task.filed task.moved task.claimed task.taken_back task.note_added task.moved" {
			t.Fatalf("Activity: %s", got)
		}

		// A question waits with the Member it is aimed at; moved to a Step, it waits there instead.
		q := f.aimed(lead, "WEB", "Which provider?", "lead")
		if out, err := f.svc.MoveTask(ctx, lead, q.Key, "Build", nil, core.Idem{}); err != nil || out.AimedAtID != nil || out.StepID == nil {
			t.Fatalf("moved the question %+v, %v", out, err)
		}
		p := f.parent(lead, "WEB", "Checkout").Task
		_, err = f.svc.MoveTask(ctx, lead, p.Key, "Build", nil, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if _, err := f.svc.DropTask(ctx, lead, q.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.MoveTask(ctx, lead, q.Key, "Build", nil, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		f.checkActivity()
	})
}
