package core_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// workflowText writes a Workflow as its Steps with their Skills, then its Connectors.
func workflowText(skills []core.Skill, w core.Workflow) string {
	skill := map[string]string{}
	for _, s := range skills {
		skill[s.ID] = s.Name
	}
	name := map[string]string{}
	var steps, connectors []string
	for _, st := range w.Steps {
		name[st.ID] = st.Name
		if st.SkillID == nil {
			steps = append(steps, st.Name)
		} else {
			steps = append(steps, st.Name+" ("+skill[*st.SkillID]+")")
		}
	}
	for _, k := range w.Connectors {
		to := "Done"
		if k.ToStepID != nil {
			to = name[*k.ToStepID]
		}
		connectors = append(connectors, name[k.FromStepID]+" -"+k.Name+"-> "+to)
	}
	return strings.Join(steps, " · ") + " | " + strings.Join(connectors, " · ")
}

// defaultWorkflowText is the default Workflow (model-v2-plan.md, "The default Workflow").
const defaultWorkflowText = "Backlog · Plan (breakdown) · Build (engineer) · Review (review) · Retro (retro) · Skill review (skill-review) | " +
	"Plan -done-> Done · Build -pass-> Review · Review -pass-> Done · Review -needs changes-> Build · " +
	"Retro -done-> Done · Retro -propose-> Skill review · Skill review -publish-> Done · Skill review -needs changes-> Retro"

func (f *fixture) workflowText(project string) string {
	f.t.Helper()
	w, err := f.svc.GetWorkflow(f.t.Context(), f.admin, project)
	if err != nil {
		f.t.Fatal(err)
	}
	skills, err := f.svc.ListSkills(f.t.Context(), f.admin, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return workflowText(skills, w.Workflow)
}

// A new Project starts with the default Workflow, laid out compact, unless its creator picks
// Empty (Backlog → Done) or a copy of another Project's, places and all; the default's engineer
// and review Skills are made when an Organisation lacks them. It starts with the Members, default
// Workspace, auto_complete and acceptance its creator names, and without its creator unless named.
func TestNewProjectsWorkflow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		web := f.project("WEB")
		if got := f.workflowText("WEB"); got != defaultWorkflowText {
			t.Fatalf("the default Workflow:\n%s", got)
		}
		w, _ := f.svc.GetWorkflow(ctx, f.admin, "WEB")
		places := [][2]int64{{0, 0}, {0, 128}, {0, 256}, {448, 256}, {0, 384}, {448, 384}}
		for i, s := range w.Steps {
			if s.Position != int64(i+1) || s.X != places[i][0] || s.Y != places[i][1] {
				t.Fatalf("Step %s at %d (%d, %d)", s.Name, s.Position, s.X, s.Y)
			}
		}
		if got := f.kinds(web); got != "project.created workflow.changed" {
			t.Fatalf("Activity: %s", got)
		}

		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "TAX", Name: "Tax", Workflow: core.WorkflowEmpty}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.workflowText("TAX"); got != "Backlog | Backlog -done-> Done" {
			t.Fatalf("the empty Workflow: %s", got)
		}
		if w, _ := f.svc.GetWorkflow(ctx, f.admin, "TAX"); w.Steps[0].X != 0 || w.Steps[0].Y != 0 {
			t.Fatalf("the empty Workflow's Backlog at (%d, %d)", w.Steps[0].X, w.Steps[0].Y)
		}
		f.chain("TAX", [2]string{"Gather", ""}, [2]string{"Prepare", core.SkillEngineer}, [2]string{"Lodged", ""})
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "TAX2", Name: "Tax two", Workflow: core.WorkflowCopy, CopyFrom: ptrStr("TAX")}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if a, b := f.workflowText("TAX"), f.workflowText("TAX2"); a != b {
			t.Fatalf("the copy:\n%s\nof\n%s", b, a)
		}
		tax, _ := f.svc.GetWorkflow(ctx, f.admin, "TAX")
		tax2, _ := f.svc.GetWorkflow(ctx, f.admin, "TAX2")
		if tax.Steps[0].ID == tax2.Steps[0].ID {
			t.Fatal("the copy shares its Steps")
		}
		for i, s := range tax2.Steps {
			if s.X != tax.Steps[i].X || s.Y != tax.Steps[i].Y || s.X != int64(i*448) {
				t.Fatalf("the copy's %s at (%d, %d), the original's at (%d, %d)", s.Name, s.X, s.Y, tax.Steps[i].X, tax.Steps[i].Y)
			}
		}

		// Its Members, default Workspace and defaults, as its creator names them.
		ws := f.workspace("tax")
		bea := f.member("bea", nil, nil)
		ops, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "OPS", Name: "Ops", Members: []string{"bea", bea.MemberID},
			DefaultWorkspace: ptrStr("tax"), AutoComplete: ptrBool(true), Acceptance: ptrBool(true)}, core.Idem{})
		if err != nil || ops.Project.DefaultWorkspaceID == nil || *ops.Project.DefaultWorkspaceID != ws.ID || !ops.Project.AutoComplete || !ops.Project.Acceptance {
			t.Fatalf("created %+v, %v", ops, err)
		}
		// The reply carries the Members it was created with, as the spec's ProjectDetail does.
		if len(ops.Members) != 1 || ops.Members[0].ID != bea.MemberID {
			t.Fatalf("created with Members %+v", ops.Members)
		}
		if d, err := f.svc.GetProject(ctx, f.admin, "OPS"); err != nil || len(d.Members) != 1 || d.Members[0].ID != bea.MemberID {
			t.Fatalf("its Members: %+v, %v", d.Members, err)
		}
		if got := f.kinds(ops.Project.ID); got != "project.created workflow.changed project.member_added" {
			t.Fatalf("Activity: %s", got)
		}
		if d, _ := f.svc.GetProject(ctx, f.admin, "TAX"); len(d.Members) != 0 {
			t.Fatalf("the creator was put in a Project without being named: %+v", d.Members)
		}

		for _, np := range []core.NewProject{
			{Key: "X1", Name: "x1", Workflow: core.WorkflowCopy},
			{Key: "X2", Name: "x2", Workflow: core.WorkflowEmpty, CopyFrom: ptrStr("TAX")},
			{Key: "X3", Name: "x3", Workflow: "jira"},
		} {
			_, err := f.svc.CreateProject(ctx, f.admin, np, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		for _, np := range []core.NewProject{
			{Key: "X4", Name: "x4", Workflow: core.WorkflowCopy, CopyFrom: ptrStr("NOPE")},
			{Key: "X5", Name: "x5", Members: []string{"nobody"}},
			{Key: "X6", Name: "x6", DefaultWorkspace: ptrStr("nowhere")},
		} {
			_, err := f.svc.CreateProject(ctx, f.admin, np, core.Idem{})
			wantCode(t, err, core.CodeNotFound)
		}

		// An Install from before model v2 may lack engineer and review: the default makes them.
		f.exec(`UPDATE skills SET name = name || '-old' WHERE name IN ('engineer', 'review')`)
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "NEW", Name: "New"}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.workflowText("NEW"); got != defaultWorkflowText {
			t.Fatalf("the default Workflow made with new Skills:\n%s", got)
		}
		f.checkActivity()
	})
}

// SetWorkflow replaces a Project's whole Workflow: Steps keep their ids, are renamed, reordered,
// given new Skills; new Steps and Connectors are made; a Connector sent back without its id keeps
// it; an unchanged Workflow writes nothing. Positions, not the order of the lists, place Steps and
// Connectors, numbered 1, 2, 3…; a Step sent without its place keeps it, and a new one is drawn
// in the first row at its position's place. A Step deleted while open Tasks are at it needs moves
// (step_in_use), which carry the Tasks — their Claims too — to a Step of the new Workflow. The
// reply is the Workflow as GetWorkflow reads it, live facts and all.
func TestSetWorkflow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.skill("qa")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer, "qa"})
		before, err := f.svc.GetWorkflow(ctx, f.admin, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		id := map[string]string{}
		for _, s := range before.Steps {
			id[s.Name] = s.ID
		}
		pass := before.Connectors[1] // Build -pass-> Review
		held := f.task(lead, "WEB", "Held at Review", "Review")
		waiting := f.task(lead, "WEB", "Waiting at Review", "Review")
		ended := f.task(lead, "WEB", "Ended at Review", "Review")
		if _, err := f.svc.DropTask(ctx, lead, ended.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.exec(`INSERT INTO member_skills (org_id, member_id, skill_id, granted_at) VALUES ($1, $2, $3, 0)`,
			builder.OrgID, builder.MemberID, f.skillID(core.SkillReview))
		f.claim(builder, held.Key, timeout(time.Hour))

		// Build becomes Make; QA (qa) is new, between Make and Review, which is deleted; Make's
		// connector keeps its id though sent without it. The lists are out of order, and the
		// positions have gaps.
		next := core.WorkflowInput{
			Steps: []core.StepInput{
				{ID: id["Retro"], Name: "Retro", Skill: ptrStr(core.SkillRetro), Position: 50},
				{ID: id["Backlog"], Name: "Backlog", Position: 1}, {ID: id["Plan"], Name: "Plan", Skill: ptrStr(core.SkillBreakdown), Position: 2, X: ptrInt(240)},
				{ID: id["Build"], Name: "Make", Skill: ptrStr(core.SkillEngineer), Position: 3, X: ptrInt(480), Y: ptrInt(40)},
				{Name: "QA", Skill: ptrStr("qa"), Position: 4},
				{ID: id["Skill review"], Name: "Skill review", Skill: ptrStr(core.SkillSkillReview), Position: 60},
			},
			Connectors: []core.ConnectorInput{
				{From: "Plan", Name: "done", Position: 1},
				{From: "make", To: ptrStr("QA"), Name: "pass", Position: 1},
				{From: "QA", To: ptrStr(id["Build"]), Name: "fail", Position: 7}, {From: "QA", Name: "pass", Position: 3},
				{From: "Retro", Name: "done", Position: 1}, {From: "Retro", To: ptrStr("Skill review"), Name: "propose", Position: 2},
				{From: "Skill review", Name: "publish", Position: 1}, {From: "Skill review", To: ptrStr("Retro"), Name: "needs changes", Position: 2},
			},
		}
		_, err = f.svc.SetWorkflow(ctx, f.admin, "WEB", next, core.Idem{})
		wantCode(t, err, core.CodeStepInUse)
		if !strings.Contains(err.Error(), "2 open Tasks are at Review") {
			t.Fatalf("the refusal reads %v", err)
		}

		// What the Workflow says on its own, and against the record.
		for _, bad := range []func(w *core.WorkflowInput){
			func(w *core.WorkflowInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "Nowhere", Name: "x"})
			},
			func(w *core.WorkflowInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "QA", To: ptrStr("Review"), Name: "x"})
			},
			func(w *core.WorkflowInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "QA", Name: "PASS"})
			},
			func(w *core.WorkflowInput) { w.Steps = append(w.Steps, core.StepInput{Name: "qa"}) },
			func(w *core.WorkflowInput) { w.Steps = append(w.Steps, core.StepInput{Name: " "}) },
			func(w *core.WorkflowInput) { w.Steps = append(w.Steps, core.StepInput{Name: id["Plan"]}) },
			func(w *core.WorkflowInput) {
				w.Steps = append(w.Steps, core.StepInput{ID: store.NewID(), Name: "Ghost"})
			},
			func(w *core.WorkflowInput) {
				w.Steps = append(w.Steps, core.StepInput{ID: id["Plan"], Name: "Plan again"})
			},
			func(w *core.WorkflowInput) { w.Connectors[0].ID = store.NewID() },
			// Two Steps at one place; two Connectors out of QA at one place; a place below 1.
			func(w *core.WorkflowInput) { w.Steps[1].Position = 50 },
			func(w *core.WorkflowInput) { w.Connectors[2].Position = 3 },
			func(w *core.WorkflowInput) { w.Steps[1].Position = -1 },
			func(w *core.WorkflowInput) { w.Moves = map[string]string{id["Plan"]: "QA"} },
			func(w *core.WorkflowInput) { w.Moves = map[string]string{id["Review"]: "Nowhere"} },
		} {
			in := next
			in.Steps = slices.Clone(next.Steps)
			in.Connectors = slices.Clone(next.Connectors)
			bad(&in)
			_, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", in, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		bad := next
		bad.Steps = append(slices.Clone(next.Steps), core.StepInput{Name: "Ops", Skill: ptrStr("no-such-skill")})
		_, err = f.svc.SetWorkflow(ctx, f.admin, "WEB", bad, core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		next.Moves = map[string]string{id["Review"]: "qa"}
		f.clock.Advance(time.Minute)
		after, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", next, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		skills, _ := f.svc.ListSkills(ctx, f.admin, nil)
		want := "Backlog · Plan (breakdown) · Make (engineer) · QA (qa) · Retro (retro) · Skill review (skill-review) | " +
			"Plan -done-> Done · Make -pass-> QA · QA -pass-> Done · QA -fail-> Make · " +
			"Retro -done-> Done · Retro -propose-> Skill review · Skill review -publish-> Done · Skill review -needs changes-> Retro"
		if got := workflowText(skills, after.Workflow); got != want {
			t.Fatalf("the Workflow set:\n%s", got)
		}
		if after.Steps[2].ID != id["Build"] || after.Steps[2].Y != 40 || after.Connectors[1].ID != pass.ID {
			t.Fatalf("Make %+v, its pass %+v (was %s)", after.Steps[2], after.Connectors[1], pass.ID)
		}
		// Numbered 1, 2, 3… in the order of the positions sent; placed as sent, kept, or new.
		places := [][2]int64{{0, 0}, {240, 128}, {480, 40}, {3 * 448, 0}, {0, 384}, {448, 384}}
		for i, s := range after.Steps {
			if s.Position != int64(i+1) || s.X != places[i][0] || s.Y != places[i][1] {
				t.Fatalf("Step %s at %d (%d, %d)", s.Name, s.Position, s.X, s.Y)
			}
		}
		for _, k := range after.Connectors[2:4] {
			if want := map[string]int64{"pass": 1, "fail": 2}[k.Name]; k.Position != want {
				t.Fatalf("QA's %s at %d, want %d", k.Name, k.Position, want)
			}
		}
		qa := after.Steps[3].ID
		if fs := after.Facts[3]; fs.StepID != qa || fs.Tasks != 2 || fs.Working != 1 || len(fs.Takers) != 1 {
			t.Fatalf("the reply's facts at QA: %+v", fs)
		}
		for _, task := range []string{held.Key, waiting.Key} {
			d := f.get(task)
			if d.Step == nil || d.Step.ID != qa || !d.Task.StepSince.Equal(f.clock.Now()) {
				t.Fatalf("%s is at %+v since %v", task, d.Step, d.Task.StepSince)
			}
		}
		if d := f.get(held.Key); d.Task.Claim == nil || d.Task.Claim.HolderID != builder.MemberID {
			t.Fatalf("the held Task lost its Claim: %+v", d.Task.Claim)
		}
		if d := f.get(ended.Key); d.Step != nil {
			t.Fatalf("the ended Task is at %+v", d.Step)
		}
		if got := f.kinds(waiting.ID); got != "task.filed task.moved" {
			t.Fatalf("Activity of a Task moved: %s", got)
		}
		changed := f.activity("workflow.changed")
		last := changed[len(changed)-1]
		if last.SubjectID != after.ProjectID || last.Payload["tasks_moved"] != float64(2) || len(last.Payload["steps"].([]any)) != 6 {
			t.Fatalf("workflow.changed %+v", last)
		}

		// Put back as read, the Workflow is unchanged and writes nothing.
		n := f.checkActivity()
		var same core.WorkflowInput
		name := map[string]string{}
		for _, s := range after.Steps {
			name[s.ID] = s.Name
			same.Steps = append(same.Steps, core.StepInput{ID: s.ID, Name: s.Name, Skill: s.SkillID, Position: s.Position})
		}
		for _, k := range after.Connectors {
			ci := core.ConnectorInput{From: k.FromStepID, Name: k.Name, Position: k.Position}
			if k.ToStepID != nil {
				ci.To = ptrStr(name[*k.ToStepID])
			}
			same.Connectors = append(same.Connectors, ci)
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", same, core.Idem{}); err != nil || f.checkActivity() != n {
			t.Fatalf("an unchanged Workflow wrote %d entries (%v)", f.checkActivity()-n, err)
		}

		// A Step's name is free once another lets go of it in the same write: swapped names.
		same.Steps[0].Name, same.Steps[1].Name = "Plan", "Backlog"
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", same, core.Idem{}); err != nil {
			t.Fatalf("swapping two Steps' names: %v", err)
		}
		f.checkActivity()
	})
}

// asSet is a Workflow as SetWorkflow takes it, unchanged.
func asSet(w core.Workflow) core.WorkflowInput {
	var in core.WorkflowInput
	for _, s := range w.Steps {
		in.Steps = append(in.Steps, core.StepInput{ID: s.ID, Name: s.Name, Skill: s.SkillID, Position: s.Position})
	}
	for _, k := range w.Connectors {
		in.Connectors = append(in.Connectors, core.ConnectorInput{ID: k.ID, From: k.FromStepID, To: k.ToStepID, Name: k.Name, Position: k.Position})
	}
	return in
}

// The Workflow and who takes its Steps are set in one write: new Skills first, so a Step and a
// grant name one; then Members join the Project and Skills are given and taken away. Refused,
// none of it is made; with only who takes changed, the Workflow writes nothing of its own.
func TestSetWorkflowTakers(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		outsider := f.member("outsider", nil, nil)
		before, err := f.svc.GetWorkflow(ctx, f.admin, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		f.task(lead, "WEB", "Waiting at Review", "Review")
		has := func(member, skill string) bool {
			return f.count(`SELECT COUNT(*) FROM member_skills WHERE member_id = $1 AND skill_id = $2`, member, f.skillID(skill)) > 0
		}
		in := func() core.WorkflowInput { return asSet(before.Workflow) }

		// Refused, nothing is made: Review is deleted with a Task at it and nowhere to go.
		gone := in()
		gone.Steps = slices.DeleteFunc(gone.Steps, func(s core.StepInput) bool { return s.Name == "Review" })
		gone.Connectors = slices.DeleteFunc(gone.Connectors, func(k core.ConnectorInput) bool {
			return k.From == before.Steps[3].ID || (k.To != nil && *k.To == before.Steps[3].ID)
		})
		gone.Skills = []core.WorkflowSkill{{Name: "triage", Body: "triage well"}}
		gone.Joins = []string{"outsider"}
		gone.Grants = []core.SkillGrant{{Member: "lead", Skill: core.SkillEngineer}}
		gone.Revokes = []core.SkillGrant{{Member: "builder", Skill: core.SkillEngineer}}
		n := f.checkActivity()
		_, err = f.svc.SetWorkflow(ctx, f.admin, "WEB", gone, core.Idem{})
		wantCode(t, err, core.CodeStepInUse)
		if has(lead.MemberID, core.SkillEngineer) || !has(builder.MemberID, core.SkillEngineer) ||
			f.count(`SELECT COUNT(*) FROM skills WHERE name = 'triage'`) != 0 ||
			f.count(`SELECT COUNT(*) FROM project_members WHERE member_id = $1`, outsider.MemberID) != 0 || f.checkActivity() != n {
			t.Fatal("a refused Save made some of what it carried")
		}

		// What is refused before anything is read.
		for code, bad := range map[core.Code]func(w *core.WorkflowInput){
			core.CodeInvalid: func(w *core.WorkflowInput) {
				w.Grants = []core.SkillGrant{{Member: "lead", Skill: "review"}}
				w.Revokes = []core.SkillGrant{{Member: "lead", Skill: "review"}}
			},
			core.CodeNotFound: func(w *core.WorkflowInput) { w.Grants = []core.SkillGrant{{Member: "nobody", Skill: "review"}} },
			core.CodeConflict: func(w *core.WorkflowInput) { w.Skills = []core.WorkflowSkill{{Name: core.SkillEngineer}} },
		} {
			w := in()
			bad(&w)
			_, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{})
			wantCode(t, err, code)
		}
		for _, name := range []string{"Triage", "a b"} {
			w := in()
			w.Skills = []core.WorkflowSkill{{Name: name}}
			_, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		if f.checkActivity() != n {
			t.Fatal("a refused Save wrote Activity")
		}

		// Backlog takes the new triage Skill, which lead is given by its name; outsider joins and
		// takes Build; builder no longer does.
		w := in()
		w.Steps[0].Skill = ptrStr("triage")
		w.Skills = []core.WorkflowSkill{{Name: "triage", Body: "triage well"}}
		w.Joins = []string{outsider.MemberID}
		w.Grants = []core.SkillGrant{{Member: lead.MemberID, Skill: "triage"}, {Member: "outsider", Skill: core.SkillEngineer}}
		w.Revokes = []core.SkillGrant{{Member: builder.MemberID, Skill: core.SkillEngineer}}
		after, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		takers := func(i int) string {
			var names []string
			for _, tk := range after.Facts[i].Takers {
				names = append(names, tk.Name)
			}
			return strings.Join(names, ", ")
		}
		if takers(0) != "lead" || takers(2) != "outsider" {
			t.Fatalf("Backlog is taken by %q, Build by %q", takers(0), takers(2))
		}
		for kind, want := range map[string]int{"skill.created": 1, "project.member_added": 1, "member.skill_granted": 2, "member.skill_revoked": 1, "workflow.changed": 1} {
			got := 0
			for _, a := range f.activity(kind) {
				if a.Seq > int64(n) {
					got++
				}
			}
			if got != want {
				t.Fatalf("%d %s entries, want %d", got, kind, want)
			}
		}
		n = f.checkActivity()
		changed := len(f.activity("workflow.changed"))

		// Only who takes changes: the Workflow records nothing, the revoke is made.
		w = asSet(after.Workflow)
		w.Revokes = []core.SkillGrant{{Member: "lead", Skill: "triage"}}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if has(lead.MemberID, "triage") || f.checkActivity() != n+1 || len(f.activity("workflow.changed")) != changed {
			t.Fatalf("revoking alone: lead keeps triage %v, %d entries", has(lead.MemberID, "triage"), f.checkActivity()-n)
		}
		if got := f.activity("member.skill_revoked"); got[len(got)-1].SubjectID != lead.MemberID {
			t.Fatalf("the last revoke is %+v", got[len(got)-1])
		}
	})
}

// The live Workflow tells, per Step, how many open Tasks are at it and how many of them are being
// worked, who could take them by its Skill — the Project's Members, or for skill-review the
// Organisation's — and the median time Tasks spent there before leaving it in the last 30 days.
func TestWorkflowFacts(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("OPS")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		f.member("idle", []string{"WEB"}, []string{core.SkillEngineer})
		f.member("elsewhere", []string{"OPS"}, []string{core.SkillEngineer})
		f.member("reviewer", []string{"OPS"}, []string{core.SkillSkillReview})
		gone := f.member("gone", []string{"WEB"}, []string{core.SkillEngineer})
		if _, err := f.svc.DeactivateMember(ctx, f.admin, gone.MemberID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		// Two Tasks leave Build after 10 and 20 minutes; a third is moved off it after 40.
		var tasks []core.Task
		for i := range 3 {
			tasks = append(tasks, f.task(lead, "WEB", name("t", i), "Build"))
		}
		for i, wait := range []time.Duration{10 * time.Minute, 10 * time.Minute} {
			f.clock.Advance(wait)
			f.claim(builder, tasks[i].Key, noTimeout)
			f.advance(builder, tasks[i].Key, "pass")
		}
		f.clock.Advance(20 * time.Minute)
		if _, err := f.svc.MoveTask(ctx, lead, tasks[2].Key, "Backlog", nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.task(lead, "WEB", "Still building", "Build")
		f.claim(builder, f.task(lead, "WEB", "Being built", "Build").Key, noTimeout)

		d, err := f.svc.GetWorkflow(ctx, lead, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		facts := map[string]core.StepFacts{}
		for i, s := range d.Steps {
			facts[s.Name] = d.Facts[i]
		}
		takers := func(fs core.StepFacts) string {
			var names []string
			for _, tk := range fs.Takers {
				names = append(names, tk.Name+"/"+tk.Kind)
			}
			return strings.Join(names, " ")
		}
		build := facts["Build"]
		if build.Tasks != 2 || build.Working != 1 || takers(build) != "builder/agent idle/agent" || build.MedianMS == nil ||
			*build.MedianMS != (20*time.Minute).Milliseconds() {
			t.Fatalf("Build: %+v, takers %s, median %v", build, takers(build), build.MedianMS)
		}
		if r := facts["Review"]; r.Tasks != 2 || r.Working != 0 || len(r.Takers) != 0 || r.MedianMS != nil {
			t.Fatalf("Review, which nobody holds: %+v", r)
		}
		if b := facts["Backlog"]; b.Tasks != 1 || len(b.Takers) != 0 {
			t.Fatalf("Backlog: %+v", b)
		}
		if sr := facts["Skill review"]; takers(sr) != "reviewer/agent" {
			t.Fatalf("Skill review, which any Project's reviewer takes: %s", takers(sr))
		}
		// After 30 days the dwells are too old to count.
		f.clock.Advance(31 * 24 * time.Hour)
		if d, err := f.svc.GetWorkflow(ctx, lead, "WEB"); err != nil || d.Facts[2].MedianMS != nil {
			t.Fatalf("a month on: %+v %v", d.Facts[2], err)
		}
	})
}
