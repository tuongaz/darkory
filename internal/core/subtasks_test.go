package core_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// actorOf is the actor of the Activity entry of kind about subject, "-" for none.
func (f *fixture) actorOf(kind, subject string) string {
	f.t.Helper()
	var actor *string
	if err := f.st.QueryRow(f.t.Context(), `SELECT actor_id FROM activity WHERE kind = $1 AND subject_id = $2`, kind, subject).Scan(&actor); err != nil {
		f.t.Fatalf("%s on %s: %v", kind, subject, err)
	}
	if actor == nil {
		return "-"
	}
	return *actor
}

// Filing a Task with no Parent: in a Project its filer is in, at the Step named, or by default
// the first Step whose Skill is the Project's own work rather than breakdown, acceptance, retro or
// skill-review (CONTEXT.md, Workflow), else the first Step that carries a Skill, else the first
// Step; aimed at a Member it is at no Step. It goes to the bottom of the Project's Rank, owned by its filer unless
// another is named, and takes the Project's auto_complete and acceptance unless the filer says.
func TestFilingTasks(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		api := f.member("api-dev", []string{"API"}, nil)
		_, err := f.svc.FileTask(ctx, api, core.NewTask{Project: ptrStr("WEB"), Title: "Not mine"}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		first := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "First"})
		if first.Task.Key != "WEB-1" || first.Task.Rank == nil || *first.Task.Rank != 1 || first.Step == nil || first.Step.Name != "Build" ||
			first.Task.OwnerID != lead.MemberID || first.Task.FiledBy == nil || *first.Task.FiledBy != lead.MemberID || first.Task.ParentID != nil ||
			first.Task.AutoComplete || first.Task.Acceptance || first.Task.Breakdown || first.Parent != nil || len(first.Subtasks) != 0 {
			t.Fatalf("filed by default %+v at %+v", first.Task, first.Step)
		}
		second := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Second", Step: ptrStr("build"), Owner: ptrStr("api-dev")})
		if second.Task.Key != "WEB-2" || *second.Task.Rank != 2 || second.Step.Name != "Build" || second.Task.OwnerID != api.MemberID ||
			len(second.Connectors) != 1 || second.Connectors[0].Name != "pass" || !second.Task.StepSince.Equal(epoch) {
			t.Fatalf("filed at Build %+v, ways out %+v", second.Task, second.Connectors)
		}
		q := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Which?", AimedAt: ptrStr("api-dev")})
		if q.Task.StepID != nil || q.Step != nil || q.Task.StepSince != nil || q.Task.AimedAtID == nil || *q.Task.AimedAtID != api.MemberID {
			t.Fatalf("aimed %+v", q.Task)
		}

		// The Project's defaults, and the filer's say over them.
		f.projectDefaults("WEB", core.ProjectChange{AutoComplete: ptrBool(true), Acceptance: ptrBool(true)})
		d := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Defaults", Step: ptrStr("Build")})
		if !d.Task.AutoComplete || !d.Task.Acceptance {
			t.Fatalf("the Project's defaults: %+v", d.Task)
		}
		d = f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Mine", Step: ptrStr("Build"), AutoComplete: ptrBool(false)})
		if d.Task.AutoComplete || !d.Task.Acceptance {
			t.Fatalf("the filer's say: %+v", d.Task)
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE kind = 'task.filed' AND subject_id = $1`, d.Task.ID).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{`"auto_complete":false`, `"acceptance":true`, `"step_id":"` + *d.Task.StepID + `"`, `"project_id":`} {
			if !strings.Contains(payload, want) {
				t.Errorf("task.filed %s lacks %s", payload, want)
			}
		}

		for _, bad := range []core.NewTask{
			{Project: ptrStr("WEB"), Title: ""},
			{Title: "Nowhere"},
			{Project: ptrStr("WEB"), Title: "Both", Step: ptrStr("Build"), AimedAt: ptrStr("lead")},
			{Project: ptrStr("WEB"), Title: "Parent at a Step", Breakdown: true, Step: ptrStr("Build")},
			{Project: ptrStr("WEB"), Title: "Parent aimed", Breakdown: true, AimedAt: ptrStr("lead")},
			{Project: ptrStr("WEB"), Title: "A Note for nothing", Note: ptrStr("x")},
		} {
			_, err := f.svc.FileTask(ctx, lead, bad, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Project: ptrStr("WEB"), Title: "x", Step: ptrStr("Nowhere")}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		// With only Darkory's own Skills, a Task starts at the first Step carrying one; with no Step
		// carrying a Skill, at the first Step; with no Step, nowhere.
		for _, key := range []string{"TAX", "OWN", "NIL"} {
			if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: key, Name: key, Workflow: core.WorkflowEmpty,
				Members: []string{"lead"}}, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		if got := f.fileTask(lead, core.NewTask{Project: ptrStr("TAX"), Title: "Return"}); got.Step == nil || got.Step.Name != "Backlog" {
			t.Fatalf("filed in an empty Workflow at %+v", got.Step)
		}
		f.chain("OWN", [2]string{"Parked", ""}, [2]string{"Retro", core.SkillRetro}, [2]string{"Plan", core.SkillBreakdown})
		if got := f.fileTask(lead, core.NewTask{Project: ptrStr("OWN"), Title: "Look back"}); got.Step == nil || got.Step.Name != "Retro" {
			t.Fatalf("filed among Darkory's own Steps at %+v", got.Step)
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "NIL", core.WorkflowInput{}, core.Idem{}); err != nil {
			t.Fatalf("a Workflow of no Steps: %v", err)
		}
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Project: ptrStr("NIL"), Title: "Lost"}, core.Idem{})
		wantCode(t, err, core.CodeNoStep)

		// Listed by Rank, a page at a time.
		page, err := f.svc.ListTasks(ctx, lead, core.TaskFilter{Project: ptrStr("WEB"), Limit: 1})
		if err != nil || len(page.Items) != 1 || page.Items[0].Key != "WEB-1" || page.NextCursor == "" {
			t.Fatalf("first page %+v, %v", page, err)
		}
		page, err = f.svc.ListTasks(ctx, lead, core.TaskFilter{Project: ptrStr("WEB"), Limit: 1, Cursor: page.NextCursor})
		if err != nil || len(page.Items) != 1 || page.Items[0].Key != "WEB-2" {
			t.Fatalf("second page %+v, %v", page, err)
		}
		f.checkActivity()
	})
}

// Filing a Subtask: one level, under an open Task of the Project, by any Member of the Project or
// the Owner while nobody holds it. It inherits its Parent's Project and Owner and sorts by its
// Parent's Rank. The first Subtask makes the Task a Parent: at no Step, aimed at no one, never
// takeable, recorded as task.became_parent with the Step it left.
func TestFilingSubtasks(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		mate := f.member("mate", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		outsider := f.member("outsider", []string{"API"}, nil)
		owner := f.member("owner", []string{"API"}, nil)
		bug, err := f.svc.CreateLabel(ctx, lead, core.NewLabel{Project: ptrStr("WEB"), Name: "bug", Color: "#AA0000"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		p := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Checkout", Step: ptrStr("Build"), Owner: ptrStr("owner")}).Task
		f.clock.Advance(time.Minute)

		_, err = f.svc.FileTask(ctx, outsider, core.NewTask{Parent: &p.Key, Title: "Not mine"}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		cart := f.fileTask(owner, core.NewTask{Parent: &p.Key, Title: "Cart", Step: ptrStr("Build"), Labels: []string{bug.ID}})
		if cart.Task.ParentID == nil || *cart.Task.ParentID != p.ID || cart.Task.ProjectID != p.ProjectID || cart.Task.OwnerID != owner.MemberID ||
			cart.Task.Rank != nil || cart.Task.AutoComplete || cart.Parent == nil || cart.Parent.Key != p.Key || cart.Parent.Title != "Checkout" ||
			!slices.Equal(cart.Task.Labels, []string{bug.ID}) || len(cart.Labels) != 1 || cart.Labels[0].Color != "#aa0000" {
			t.Fatalf("Subtask %+v under %+v, Labels %+v", cart.Task, cart.Parent, cart.Labels)
		}
		f.subtask(mate, p.Key, "Pay", "Build")

		parent := f.get(p.Key)
		if parent.Task.StepID != nil || parent.Task.StepSince != nil || parent.Step != nil || len(parent.Connectors) != 0 ||
			len(parent.Subtasks) != 2 || parent.Task.SubtaskCounts == nil || parent.Task.SubtaskCounts.Open != 2 {
			t.Fatalf("the Parent %+v at %+v, Subtasks %d", parent.Task, parent.Step, len(parent.Subtasks))
		}
		if got := f.kinds(p.ID); got != "task.filed task.became_parent" {
			t.Fatalf("the Parent's Activity: %s", got)
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE kind = 'task.became_parent' AND subject_id = $1`, p.ID).Scan(&payload); err != nil ||
			!strings.Contains(payload, `"from":"`+f.step("WEB", "Build")+`"`) || !strings.Contains(payload, `"since":`) {
			t.Fatalf("task.became_parent %s, %v", payload, err)
		}
		if f.takeable(builder)[p.ID] || !f.takeable(builder)[cart.Task.ID] {
			t.Fatal("the Parent is takeable, or its Subtask is not")
		}
		_, err = f.svc.Claim(ctx, builder, p.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if !strings.Contains(err.Error(), "Parent") {
			t.Fatalf("the refusal does not say it is a Parent: %v", err)
		}

		// One level only; an ended Task takes none.
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Parent: &cart.Task.Key, Title: "Deeper"}, core.Idem{})
		wantCode(t, err, core.CodeOneLevel)
		done := f.task(lead, "WEB", "Done already", "Build")
		if _, err := f.svc.DropTask(ctx, lead, done.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Parent: &done.Key, Title: "Late"}, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		for _, bad := range []core.NewTask{
			{Parent: &p.Key, Title: "Broken down", Breakdown: true},
			{Parent: &p.Key, Title: "Self-completing", AutoComplete: ptrBool(true)},
			{Parent: &p.Key, Title: "From a retro", FromRetrospective: &cart.Task.Key},
			{Parent: &p.Key, Project: ptrStr("API"), Title: "Elsewhere"},
		} {
			_, err := f.svc.FileTask(ctx, lead, bad, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		f.checkActivity()
	})
}

// The holder may split the Task they hold: filing a Subtask under it ends their Claim split, with
// their Note on it, and makes it a Parent. Nobody else may while it is held (held), nor the
// holder through another of their Sessions.
func TestSplit(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		task := f.task(lead, "WEB", "Too big", "Build")
		f.claim(builder, task.Key, timeout(time.Hour))
		sibling := f.session(builder.MemberID, "builder-2")

		_, err := f.svc.FileTask(ctx, lead, core.NewTask{Parent: &task.Key, Title: "Part one", Step: ptrStr("Build")}, core.Idem{})
		wantCode(t, err, core.CodeHeld)
		_, err = f.svc.FileTask(ctx, sibling, core.NewTask{Parent: &task.Key, Title: "Part one", Step: ptrStr("Build")}, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)

		part := f.fileTask(builder, core.NewTask{Parent: &task.Key, Title: "Part one", Step: ptrStr("Build"), Note: ptrStr("two parts: the form and the API")})
		d := f.get(task.Key)
		if d.Task.Claim != nil || d.Task.StepID != nil || len(d.Claims) != 1 || *d.Claims[0].HowEnded != "split" ||
			d.Claims[0].EndedAt == nil || len(d.Notes) != 1 || d.Notes[0].AuthorID != builder.MemberID || d.Notes[0].SkillID == nil ||
			*d.Notes[0].SkillID != f.skillID(core.SkillEngineer) {
			t.Fatalf("after the split %+v, Claims %+v, Notes %+v", d.Task, d.Claims, d.Notes)
		}
		if part.Task.StepID == nil || *part.Task.StepID != f.step("WEB", "Build") {
			t.Fatalf("the Subtask %+v", part.Task)
		}
		if hb, err := f.svc.Heartbeat(ctx, builder, task.Key); err != nil || hb.Status != "ended" {
			t.Fatalf("the holder's Heartbeat after the split: %+v, %v", hb, err)
		}
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.note_added task.split task.became_parent" {
			t.Fatalf("Activity: %s", got)
		}
		// Now a Parent nobody holds: any Member of the Project files more, with no Note to leave.
		f.subtask(builder, task.Key, "Part two", "Build")
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Parent: &task.Key, Title: "Part three", Note: ptrStr("x")}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		f.checkActivity()
	})
}

// Break down: a Task filed with it is a Parent from its first moment, with its Breakdown Subtask
// at the Workflow's breakdown Step, filed by nobody and recorded with no actor, owned by the
// Parent's Owner and naming its Workspaces. A Workflow with no breakdown Step offers no Break
// down (no_step).
func TestBreakdown(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		ws := f.workspace("web")
		f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("web")})
		lead := f.member("lead", []string{"WEB"}, nil)
		d := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Checkout", Breakdown: true, Owner: ptrStr("ada")})
		if d.Task.StepID != nil || !d.Task.Breakdown || d.Task.SubtaskCounts == nil || d.Task.SubtaskCounts.Open != 1 || len(d.Subtasks) != 1 {
			t.Fatalf("the Parent %+v with %d Subtasks", d.Task, len(d.Subtasks))
		}
		b := d.Subtasks[0]
		if b.Kind != "breakdown" || b.Title != "Break down: Checkout" || b.StepID == nil || *b.StepID != f.step("WEB", "Plan") ||
			b.FiledBy != nil || b.OwnerID != f.admin.MemberID || !slices.Equal(b.WorkspaceIDs, []string{ws.ID}) || b.Rank != nil {
			t.Fatalf("the Breakdown %+v", b)
		}
		if f.actorOf("task.filed", d.Task.ID) != lead.MemberID || f.actorOf("task.filed", b.ID) != "-" {
			t.Fatal("the Breakdown's filing names an actor, or the Task's does not")
		}
		if got := f.kinds(d.Task.ID); got != "task.filed" {
			t.Fatalf("a Parent from its first moment records %s", got)
		}
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "TAX", Name: "Tax", Workflow: core.WorkflowEmpty}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddProjectMember(ctx, f.admin, "TAX", "lead", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err := f.svc.FileTask(ctx, lead, core.NewTask{Project: ptrStr("TAX"), Title: "Return", Breakdown: true}, core.Idem{})
		wantCode(t, err, core.CodeNoStep)
		f.checkActivity()
	})
}

// newAcceptanceFixture is Project WEB with Plan (breakdown) → Done and Build (engineer) → Done,
// and, withStep, Acceptance (acceptance) → Done "pass" and → Build "fail"; acceptance is on for
// its Tasks.
func newAcceptanceFixture(t *testing.T, st *store.Store, withStep bool) *fixture {
	f := newFixture(t, st)
	f.project("WEB")
	in := core.WorkflowInput{
		Steps:      []core.StepInput{{Name: "Plan", Skill: ptrStr(core.SkillBreakdown)}, {Name: "Build", Skill: ptrStr(core.SkillEngineer)}},
		Connectors: []core.ConnectorInput{{From: "Plan", Name: "done"}, {From: "Build", Name: "pass"}},
	}
	if withStep {
		in.Steps = append(in.Steps, core.StepInput{Name: "Acceptance", Skill: ptrStr(core.SkillAcceptance)})
		in.Connectors = append(in.Connectors, core.ConnectorInput{From: "Acceptance", Name: "pass"},
			core.ConnectorInput{From: "Acceptance", To: ptrStr("Build"), Name: "fail"})
	}
	if _, err := f.svc.SetWorkflow(t.Context(), f.admin, "WEB", in, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	f.projectDefaults("WEB", core.ProjectChange{Acceptance: ptrBool(true)})
	return f
}

// broken files a Parent in WEB as lead with nt's switches, breaks it down into titles at Build,
// and completes the Breakdown; it returns the Parent and its Subtasks' keys.
func (f *fixture) broken(lead *auth.Caller, nt core.NewTask, titles ...string) (core.Task, []string) {
	f.t.Helper()
	nt.Project, nt.Breakdown = ptrStr("WEB"), true
	d := f.fileTask(lead, nt)
	f.claim(lead, d.Subtasks[0].Key, noTimeout)
	var keys []string
	for _, title := range titles {
		keys = append(keys, f.subtask(lead, d.Task.Key, title, "Build").Key)
	}
	f.complete(lead, d.Subtasks[0].Key)
	return d.Task, keys
}

// subtaskKinds lists the Parent's Subtasks as kind/state, in the order filed.
func (f *fixture) subtaskKinds(parent string) string {
	f.t.Helper()
	var out []string
	for _, s := range f.get(parent).Subtasks {
		out = append(out, s.Kind+"/"+s.State)
	}
	return strings.Join(out, " ")
}

// Acceptance: when the last other Subtask of a Parent still open, with acceptance on, ends done,
// Darkory files an Acceptance at the Workflow's acceptance Step — by nobody, with no actor, owned
// by the Parent's Owner — unless the Subtask that ended is itself an Acceptance that ended done.
// Its completion lets the Parent complete; Subtasks filed instead have another filed when they
// end; one that ends dropped files nothing more; and a Parent with acceptance off, or a Workflow
// with no acceptance Step, files none.
func TestAcceptance(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newAcceptanceFixture(t, st, true)
		ctx := t.Context()
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		checker := f.member("checker", []string{"WEB"}, []string{core.SkillAcceptance})

		p, subs := f.broken(lead, core.NewTask{Title: "Checkout"}, "Cart", "Pay")
		if !p.Acceptance || f.subtaskKinds(p.Key) != "breakdown/done work/open work/open" {
			t.Fatalf("the Parent %+v: %s", p, f.subtaskKinds(p.Key))
		}
		f.claim(builder, subs[0], noTimeout)
		f.complete(builder, subs[0])
		if got := f.subtaskKinds(p.Key); got != "breakdown/done work/done work/open" {
			t.Fatalf("an Acceptance was filed with a Subtask open: %s", got)
		}
		f.claim(builder, subs[1], noTimeout)
		f.complete(builder, subs[1])
		d := f.get(p.Key)
		acc := d.Subtasks[3]
		if acc.Kind != "acceptance" || acc.Title != "Acceptance: Checkout" || acc.State != "open" || acc.FiledBy != nil ||
			acc.OwnerID != lead.MemberID || acc.StepID == nil || *acc.StepID != f.step("WEB", "Acceptance") || d.Task.State != "open" {
			t.Fatalf("the Acceptance %+v under %+v", acc, d.Task)
		}
		if f.actorOf("task.filed", acc.ID) != "-" {
			t.Fatal("the Acceptance's filing names an actor")
		}
		_, err := f.svc.Complete(ctx, lead, p.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeTasksOpen)

		// Failed back to Build, built again and done: an Acceptance that ends done files no other.
		f.claim(checker, acc.Key, noTimeout)
		f.advance(checker, acc.Key, "fail")
		f.claim(builder, acc.Key, noTimeout)
		f.complete(builder, acc.Key)
		if got := f.subtaskKinds(p.Key); got != "breakdown/done work/done work/done acceptance/done" {
			t.Fatalf("after the Acceptance ended done: %s", got)
		}
		if f.get(p.Key).Task.State != "open" {
			t.Fatal("a Parent without auto_complete completed itself")
		}
		f.complete(lead, p.Key)

		// Subtasks filed instead of passing: the Acceptance ends done, and another is filed once
		// they end; it ends done, and the Parent, with auto_complete, completes itself.
		p2, subs2 := f.broken(lead, core.NewTask{Title: "Wishlist", AutoComplete: ptrBool(true)}, "List")
		f.claim(builder, subs2[0], noTimeout)
		f.complete(builder, subs2[0])
		acc2 := f.get(p2.Key).Subtasks[2]
		f.claim(checker, acc2.Key, noTimeout)
		fix := f.subtask(checker, p2.Key, "Fix the empty list", "Build")
		f.complete(checker, acc2.Key)
		if got, state := f.subtaskKinds(p2.Key), f.get(p2.Key).Task.State; got != "breakdown/done work/done acceptance/done work/open" || state != "open" {
			t.Fatalf("with a fix filed: %s, the Parent %s", got, state)
		}
		f.claim(builder, fix.Key, noTimeout)
		f.complete(builder, fix.Key)
		all2 := f.get(p2.Key).Subtasks
		acc3 := all2[len(all2)-1]
		if acc3.Kind != "acceptance" || acc3.State != "open" || f.get(p2.Key).Task.State != "open" {
			t.Fatalf("no new Acceptance once the fix ended: %s", f.subtaskKinds(p2.Key))
		}
		f.claim(checker, acc3.Key, noTimeout)
		f.complete(checker, acc3.Key)
		if done := f.get(p2.Key).Task; done.State != "done" {
			t.Fatalf("the Parent after its Acceptance: %+v", done)
		}

		// An Acceptance dropped by the Owner files nothing more; the Owner completes the Parent.
		p3, subs3 := f.broken(lead, core.NewTask{Title: "Search", AutoComplete: ptrBool(true)}, "Index")
		f.claim(builder, subs3[0], noTimeout)
		f.complete(builder, subs3[0])
		acc4 := f.get(p3.Key).Subtasks[2]
		if _, err := f.svc.DropTask(ctx, lead, acc4.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got, state := f.subtaskKinds(p3.Key), f.get(p3.Key).Task.State; got != "breakdown/done work/done acceptance/dropped" || state != "open" {
			t.Fatalf("after the Acceptance was dropped: %s, the Parent %s", got, state)
		}
		f.complete(lead, p3.Key)

		// With acceptance off, the last Subtask ending files none.
		p4, subs4 := f.broken(lead, core.NewTask{Title: "Reviews", Acceptance: ptrBool(false)}, "Stars")
		f.claim(builder, subs4[0], noTimeout)
		f.complete(builder, subs4[0])
		if got := f.subtaskKinds(p4.Key); got != "breakdown/done work/done" {
			t.Fatalf("an Acceptance for a Parent with acceptance off: %s", got)
		}
		f.checkActivity()
	})
}

// A Workflow with no acceptance Step files no Acceptance: a Parent with acceptance on is done when
// its Subtasks are, and with auto_complete completes itself.
func TestAcceptanceNeedsAnAcceptanceStep(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newAcceptanceFixture(t, st, false)
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		p, subs := f.broken(lead, core.NewTask{Title: "Checkout", AutoComplete: ptrBool(true)}, "Cart")
		f.claim(builder, subs[0], noTimeout)
		f.complete(builder, subs[0])
		if got, state := f.subtaskKinds(p.Key), f.get(p.Key).Task.State; got != "breakdown/done work/done" || state != "done" {
			t.Fatalf("Subtasks %s, the Parent %s", got, state)
		}
	})
}

// Auto-complete: when the last open Subtask of a Parent still open, with auto_complete, ends done
// and no Acceptance is due, the Parent completes in the same write — task.completed with
// auto_complete, by the Member whose Subtask ended — and files its Retrospective. A Parent
// without it waits for its Owner, and one whose last Subtask is dropped, or that still has one
// open, waits too.
func TestAutoComplete(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.chainBuildIntoDone("WEB")
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})

		p, subs := f.broken(lead, core.NewTask{Title: "Checkout", AutoComplete: ptrBool(true)}, "Cart", "Pay")
		f.claim(builder, subs[0], noTimeout)
		f.complete(builder, subs[0])
		if f.get(p.Key).Task.State != "open" {
			t.Fatal("the Parent completed with a Subtask open")
		}
		// A question under it is a Subtask too: while it is open, nothing completes.
		q := f.fileTask(builder, core.NewTask{Parent: &p.Key, Title: "Which card types?", AimedAt: ptrStr("lead")}).Task
		f.claim(builder, subs[1], noTimeout)
		f.complete(builder, subs[1])
		if f.get(p.Key).Task.State != "open" {
			t.Fatal("the Parent completed with a question open")
		}
		f.claim(lead, q.Key, noTimeout)
		f.complete(lead, q.Key)
		d := f.get(p.Key)
		if d.Task.State != "done" || d.Task.EndedAt == nil {
			t.Fatalf("the Parent after its last Subtask: %+v", d.Task)
		}
		retro := d.Subtasks[len(d.Subtasks)-1]
		if retro.Kind != "retrospective" || retro.StepID == nil || *retro.StepID != f.step("WEB", "Retro") || retro.FiledBy != nil ||
			f.actorOf("task.filed", retro.ID) != "-" {
			t.Fatalf("the Retrospective %+v", retro)
		}
		if got := f.kinds(p.ID); got != "task.filed task.completed" || f.actorOf("task.completed", p.ID) != lead.MemberID {
			t.Fatalf("the Parent's Activity: %s by %s", got, f.actorOf("task.completed", p.ID))
		}
		var payload string
		if err := st.QueryRow(ctx, `SELECT payload FROM activity WHERE kind = 'task.completed' AND subject_id = $1`, p.ID).Scan(&payload); err != nil ||
			payload != `{"auto_complete":true}` {
			t.Fatalf("task.completed %s, %v", payload, err)
		}

		// Without auto_complete the Parent waits for its Owner; with its last Subtask dropped, too.
		manual, msubs := f.broken(lead, core.NewTask{Title: "Search"}, "Index")
		f.claim(builder, msubs[0], noTimeout)
		f.complete(builder, msubs[0])
		dropped, dsubs := f.broken(lead, core.NewTask{Title: "Chat", AutoComplete: ptrBool(true)}, "Rooms")
		if _, err := f.svc.DropTask(ctx, lead, dsubs[0], nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{manual.Key, dropped.Key} {
			if s := f.get(k).Task.State; s != "open" {
				t.Fatalf("%s is %s", k, s)
			}
		}
		f.checkActivity()
	})
}

// The Retrospective is filed only where the Workflow has a retro Step, and only for a Parent.
func TestRetrospectiveNeedsARetroStep(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newAcceptanceFixture(t, st, false)
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillBreakdown})
		p, _ := f.broken(lead, core.NewTask{Title: "Checkout"})
		f.complete(lead, p.Key)
		if got := f.subtaskKinds(p.Key); got != "breakdown/done" {
			t.Fatalf("a Retrospective filed with no retro Step: %s", got)
		}
	})
}
