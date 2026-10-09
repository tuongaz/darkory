package core_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// workflowText writes a Project's Workflows as their Steps with their Skills, then the
// Connectors. With two Workflows or more, each Workflow's Steps follow its name, and the
// Workflows are apart by " / ": "Triage: Triage (triage) / Bugs: Investigate · Fix | …".
func workflowText(skills []core.Skill, w core.Workflows) string {
	skill := map[string]string{}
	for _, s := range skills {
		skill[s.ID] = s.Name
	}
	name := map[string]string{}
	of := map[string][]string{}
	var steps []string
	for _, st := range w.Steps {
		name[st.ID] = st.Name
		text := st.Name
		if st.SkillID != nil {
			text += " (" + skill[*st.SkillID] + ")"
		}
		steps = append(steps, text)
		of[st.WorkflowID] = append(of[st.WorkflowID], text)
	}
	if len(w.Workflows) > 1 {
		steps = nil
		for _, wf := range w.Workflows {
			steps = append(steps, wf.Name+": "+strings.Join(of[wf.ID], " · "))
		}
		return strings.Join(steps, " / ") + " | " + connectorsText(name, w.Connectors)
	}
	return strings.Join(steps, " · ") + " | " + connectorsText(name, w.Connectors)
}

func connectorsText(name map[string]string, ks []core.Connector) string {
	var connectors []string
	for _, k := range ks {
		to := "Done"
		if k.ToStepID != nil {
			to = name[*k.ToStepID]
		}
		connectors = append(connectors, name[k.FromStepID]+" -"+k.Name+"-> "+to)
	}
	return strings.Join(connectors, " · ")
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
	return workflowText(skills, w.Workflows)
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
		next := core.WorkflowsInput{
			Workflows: []core.WorkflowInput{{Name: "Work", Position: 1}},
			Steps: []core.StepInput{
				{ID: id["Retro"], Workflow: "Work", Name: "Retro", Skill: ptrStr(core.SkillRetro), Position: 50},
				{ID: id["Backlog"], Workflow: "work", Name: "Backlog", Position: 1}, {ID: id["Plan"], Workflow: "Work", Name: "Plan", Skill: ptrStr(core.SkillBreakdown), Position: 2, X: ptrInt(240)},
				{ID: id["Build"], Workflow: "Work", Name: "Make", Skill: ptrStr(core.SkillEngineer), Position: 3, X: ptrInt(480), Y: ptrInt(40)},
				{Workflow: "Work", Name: "QA", Skill: ptrStr("qa"), Position: 4},
				{ID: id["Skill review"], Workflow: before.Steps[0].WorkflowID, Name: "Skill review", Skill: ptrStr(core.SkillSkillReview), Position: 60},
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

		// What the Workflow says on its own, and against the record: each refused by its own rule,
		// its message naming it.
		work := before.Steps[0].WorkflowID
		for _, c := range []struct {
			name   string
			mutate func(w *core.WorkflowsInput)
			want   string
		}{
			{"a Connector from no Step", func(w *core.WorkflowsInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "Nowhere", Name: "x"})
			}, `a Connector names "Nowhere", which is not a Step of the body`},
			{"a Connector into a deleted Step", func(w *core.WorkflowsInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "QA", To: ptrStr("Review"), Name: "x"})
			}, `a Connector names "Review", which is not a Step of the body`},
			{"two outcomes named alike", func(w *core.WorkflowsInput) {
				w.Connectors = append(w.Connectors, core.ConnectorInput{From: "QA", Name: "PASS"})
			}, `two Connectors out of QA are named "PASS"`},
			{"two Steps named alike", func(w *core.WorkflowsInput) { w.Steps = append(w.Steps, core.StepInput{Workflow: "Work", Name: "qa"}) },
				`two Steps are named "qa"`},
			{"a blank Step name", func(w *core.WorkflowsInput) { w.Steps = append(w.Steps, core.StepInput{Workflow: "Work", Name: " "}) },
				"a Step's name is 1 to 50"},
			{"a Step name spelled as an id", func(w *core.WorkflowsInput) {
				w.Steps = append(w.Steps, core.StepInput{Workflow: "Work", Name: id["Plan"]})
			}, "a Step's name cannot be spelled as an id"},
			{"a blank Connector name", func(w *core.WorkflowsInput) { w.Connectors[0].Name = " " }, "a Connector's name is 1 to 50"},
			{"a Step id the Project lacks", func(w *core.WorkflowsInput) {
				w.Steps = append(w.Steps, core.StepInput{ID: store.NewID(), Workflow: "Work", Name: "Ghost"})
			}, "the Project has no Step"},
			{"a Step id given twice", func(w *core.WorkflowsInput) {
				w.Steps = append(w.Steps, core.StepInput{ID: id["Plan"], Workflow: "Work", Name: "Plan again"})
			}, "Step " + id["Plan"] + " is in the body twice"},
			{"a Connector id the Project lacks", func(w *core.WorkflowsInput) { w.Connectors[0].ID = store.NewID() }, "the Project has no Connector"},
			{"a Connector id given twice", func(w *core.WorkflowsInput) { w.Connectors[0].ID, w.Connectors[1].ID = pass.ID, pass.ID },
				"Connector " + pass.ID + " is in the body twice"},
			{"two Steps at one place", func(w *core.WorkflowsInput) { w.Steps[1].Position = 50 }, "two Steps in Work are at position 50"},
			{"two Connectors out of QA at one place", func(w *core.WorkflowsInput) { w.Connectors[2].Position = 3 },
				"two Connectors out of QA are at position 3"},
			{"a Step's place below 1", func(w *core.WorkflowsInput) { w.Steps[1].Position = -1 }, "a position is 1 or more, not -1"},
			{"moves from a kept Step", func(w *core.WorkflowsInput) { w.Moves = map[string]string{id["Plan"]: "QA"} },
				"moves names " + id["Plan"] + ", which is not a Step being deleted"},
			{"moves into no Step", func(w *core.WorkflowsInput) { w.Moves = map[string]string{id["Review"]: "Nowhere"} },
				`moves names "Nowhere", which is not a Step of the body`},
			{"no Workflow at all", func(w *core.WorkflowsInput) { w.Workflows = nil }, "no Workflow at all"},
			{"two Workflows named alike", func(w *core.WorkflowsInput) {
				w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "WORK", Position: 2})
			}, `two Workflows are named "WORK"`},
			{"two Workflows at one place", func(w *core.WorkflowsInput) {
				w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Bugs", Position: 1})
			}, "two Workflows are at position 1"},
			{"a Workflow's place below 1", func(w *core.WorkflowsInput) { w.Workflows[0].Position = -1 }, "a position is 1 or more, not -1"},
			// The Workflow named by its id, and its Steps naming it by id, so a broken name trips
			// only the rule on names.
			{"a blank Workflow name", func(w *core.WorkflowsInput) { byID(w, work); w.Workflows[0].Name = " " }, "a Workflow's name is 1 to 50"},
			{"a Workflow name too long", func(w *core.WorkflowsInput) { byID(w, work); w.Workflows[0].Name = strings.Repeat("w", 51) },
				"a Workflow's name is 1 to 50"},
			{"a Workflow name spelled as an id", func(w *core.WorkflowsInput) { byID(w, work); w.Workflows[0].Name = store.NewID() },
				"a Workflow's name cannot be spelled as an id"},
			{"a Step in no Workflow of the body", func(w *core.WorkflowsInput) { w.Steps[0].Workflow = "Bugs" },
				`a Step names "Bugs", which is not a Workflow of the body`},
			{"a Step naming no Workflow", func(w *core.WorkflowsInput) { w.Steps[0].Workflow = "" },
				`a Step names "", which is not a Workflow of the body`},
			{"a Workflow id the Project lacks", func(w *core.WorkflowsInput) { w.Workflows[0].ID = store.NewID() }, "the Project has no Workflow"},
			{"a Workflow id given twice", func(w *core.WorkflowsInput) {
				w.Workflows[0].ID = work
				w.Workflows = append(w.Workflows, core.WorkflowInput{ID: work, Name: "Bugs", Position: 2})
			}, "Workflow " + work + " is in the body twice"},
		} {
			in := next
			in.Workflows = slices.Clone(next.Workflows)
			in.Steps = slices.Clone(next.Steps)
			in.Connectors = slices.Clone(next.Connectors)
			c.mutate(&in)
			t.Run(c.name, func(t *testing.T) {
				_, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", in, core.Idem{})
				wantCode(t, err, core.CodeInvalid)
				if !strings.Contains(err.Error(), c.want) {
					t.Errorf("refused %q, want %q", err, c.want)
				}
			})
		}
		bad := next
		bad.Steps = append(slices.Clone(next.Steps), core.StepInput{Workflow: "Work", Name: "Ops", Skill: ptrStr("no-such-skill")})
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
		if got := workflowText(skills, after.Workflows); got != want {
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

		// Put back as read, the Workflows unchanged and write nothing: a Workflow sent without its
		// id keeps it by its name, as a Connector does.
		n := f.checkActivity()
		var same core.WorkflowsInput
		for _, wf := range after.Workflows.Workflows {
			same.Workflows = append(same.Workflows, core.WorkflowInput{Name: wf.Name, Position: wf.Position})
		}
		name := map[string]string{}
		for _, s := range after.Steps {
			name[s.ID] = s.Name
			same.Steps = append(same.Steps, core.StepInput{ID: s.ID, Workflow: s.WorkflowID, Name: s.Name, Skill: s.SkillID, Position: s.Position})
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

// byID makes w name its Workflow by the id work, and every Step name it by that id.
func byID(w *core.WorkflowsInput, work string) {
	w.Workflows[0].ID = work
	for i := range w.Steps {
		w.Steps[i].Workflow = work
	}
}

// asSet is a Project's Workflows as SetWorkflow takes them, unchanged.
func asSet(w core.Workflows) core.WorkflowsInput {
	var in core.WorkflowsInput
	for _, wf := range w.Workflows {
		in.Workflows = append(in.Workflows, core.WorkflowInput{ID: wf.ID, Name: wf.Name, Position: wf.Position})
	}
	for _, s := range w.Steps {
		in.Steps = append(in.Steps, core.StepInput{ID: s.ID, Workflow: s.WorkflowID, Name: s.Name, Skill: s.SkillID, Position: s.Position})
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
		in := func() core.WorkflowsInput { return asSet(before.Workflows) }

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
		for code, bad := range map[core.Code]func(w *core.WorkflowsInput){
			core.CodeInvalid: func(w *core.WorkflowsInput) {
				w.Grants = []core.SkillGrant{{Member: "lead", Skill: "review"}}
				w.Revokes = []core.SkillGrant{{Member: "lead", Skill: "review"}}
			},
			core.CodeNotFound: func(w *core.WorkflowsInput) { w.Grants = []core.SkillGrant{{Member: "nobody", Skill: "review"}} },
			core.CodeConflict: func(w *core.WorkflowsInput) { w.Skills = []core.WorkflowSkill{{Name: core.SkillEngineer}} },
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
		w = asSet(after.Workflows)
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

// workflowIDs maps each of the Project's Workflows' names to its id.
func (f *fixture) workflowIDs(project string) map[string]string {
	f.t.Helper()
	d, err := f.svc.GetWorkflow(f.t.Context(), f.admin, project)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]string{}
	for _, wf := range d.Workflows.Workflows {
		out[wf.Name] = wf.ID
	}
	return out
}

// A Project's Steps are grouped into named Workflows (ADR 0019): a new Project has one, Work.
// The Workflows' positions order the Project's Steps before the Steps' own, so a filed Task's
// default entry and the builtin Steps follow the Workflows' order; two Steps of different
// Workflows may share a position; a Connector may lead into a Step of another Workflow, and
// advancing along it takes the Task there. Two Workflows may swap their names in one write.
func TestWorkflowsHaveNamesAndOrder(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		web, err := f.svc.GetWorkflow(ctx, f.admin, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		if wfs := web.Workflows.Workflows; len(wfs) != 1 || wfs[0].Name != core.WorkflowFirstName || wfs[0].Position != 1 {
			t.Fatalf("a new Project's Workflows: %+v", wfs)
		}
		for _, s := range web.Steps {
			if s.WorkflowID != web.Workflows.Workflows[0].ID {
				t.Fatalf("Step %s is in Workflow %s", s.Name, s.WorkflowID)
			}
		}

		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "SUP", Name: "Support", Workflow: core.WorkflowEmpty}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.skill("triage")
		lead := f.member("lead", []string{"SUP"}, nil)
		router := f.member("router", []string{"SUP"}, []string{"triage"})
		in := core.WorkflowsInput{
			Workflows: []core.WorkflowInput{{Name: "Bugs", Position: 2}, {Name: "Triage", Position: 1}},
			Steps: []core.StepInput{
				{Workflow: "Bugs", Name: "Fix", Skill: ptrStr(core.SkillEngineer), Position: 2},
				{Workflow: "Bugs", Name: "Investigate", Skill: ptrStr(core.SkillEngineer), Position: 1},
				{Workflow: "triage", Name: "Triage", Skill: ptrStr("triage"), Position: 1},
			},
			Connectors: []core.ConnectorInput{
				{From: "Triage", To: ptrStr("Investigate"), Name: "bug", Position: 1}, {From: "Triage", Name: "done", Position: 2},
				{From: "Investigate", To: ptrStr("Fix"), Name: "pass"}, {From: "Fix", Name: "pass"},
			},
		}
		sup, err := f.svc.SetWorkflow(ctx, f.admin, "SUP", in, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		const want = "Triage: Triage (triage) / Bugs: Investigate (engineer) · Fix (engineer) | " +
			"Triage -bug-> Investigate · Triage -done-> Done · Investigate -pass-> Fix · Fix -pass-> Done"
		if got := f.workflowText("SUP"); got != want {
			t.Fatalf("two Workflows read back:\n%s", got)
		}
		// Work, left out, is gone with its Backlog.
		if n := f.count(`SELECT COUNT(*) FROM workflows WHERE project_id = $1`, sup.ProjectID); n != 2 {
			t.Fatalf("SUP has %d Workflows", n)
		}
		ids := f.workflowIDs("SUP")
		places := map[string][3]any{"Triage": {ids["Triage"], int64(1), int64(0)}, "Investigate": {ids["Bugs"], int64(1), int64(0)}, "Fix": {ids["Bugs"], int64(2), int64(448)}}
		for _, s := range sup.Steps {
			if p := places[s.Name]; s.WorkflowID != p[0] || s.Position != p[1] || s.X != p[2] {
				t.Fatalf("Step %s in %s at %d (x %d)", s.Name, s.WorkflowID, s.Position, s.X)
			}
		}

		// A filed Task starts at the first Step of the first Workflow; advancing along a
		// Connector into another Workflow takes it there.
		routed := f.fileTask(lead, core.NewTask{Project: ptrStr("SUP"), Title: "Login fails"}).Task
		if got := f.at(routed.Key); got != "Triage" {
			t.Fatalf("filed at %s", got)
		}
		f.claim(router, routed.Key, noTimeout)
		f.advance(router, routed.Key, "bug")
		if d := f.get(routed.Key); d.Step == nil || d.Step.Name != "Investigate" || d.Step.WorkflowID != ids["Bugs"] {
			t.Fatalf("advanced along bug to %+v", d.Step)
		}

		// Swapping the Workflows' positions swaps the Project's order, and where a Task starts.
		w := asSet(f.workflows("SUP"))
		w.Workflows[0].Position, w.Workflows[1].Position = 2, 1
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "SUP", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.workflowText("SUP"); got != "Bugs: Investigate (engineer) · Fix (engineer) / Triage: Triage (triage) | "+
			"Investigate -pass-> Fix · Fix -pass-> Done · Triage -bug-> Investigate · Triage -done-> Done" {
			t.Fatalf("swapped:\n%s", got)
		}
		if got := f.at(f.fileTask(lead, core.NewTask{Project: ptrStr("SUP"), Title: "Slow page"}).Task.Key); got != "Investigate" {
			t.Fatalf("filed at %s once Bugs is first", got)
		}

		// Two Workflows swap their names in one write: each lets go of its name first.
		w = asSet(f.workflows("SUP"))
		w.Workflows[0].Name, w.Workflows[1].Name = w.Workflows[1].Name, w.Workflows[0].Name
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "SUP", w, core.Idem{}); err != nil {
			t.Fatalf("swapping two Workflows' names: %v", err)
		}
		if got := f.workflowIDs("SUP"); got["Triage"] != ids["Bugs"] || got["Bugs"] != ids["Triage"] {
			t.Fatalf("swapped names: %v, were %v", got, ids)
		}

		// The Breakdown and the Acceptance are filed at the first Step carrying their Skill, by
		// the Workflows' order.
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "BRK", Name: "Breaks", Workflow: core.WorkflowEmpty, Members: []string{"lead"},
			Acceptance: ptrBool(true)}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		brk := core.WorkflowsInput{
			Workflows: []core.WorkflowInput{{Name: "Alpha", Position: 1}, {Name: "Beta", Position: 2}},
			Steps: []core.StepInput{
				{Workflow: "Alpha", Name: "Plan A", Skill: ptrStr(core.SkillBreakdown), Position: 1},
				{Workflow: "Alpha", Name: "Accept A", Skill: ptrStr(core.SkillAcceptance), Position: 2},
				{Workflow: "Beta", Name: "Plan B", Skill: ptrStr(core.SkillBreakdown), Position: 1},
				{Workflow: "Beta", Name: "Accept B", Skill: ptrStr(core.SkillAcceptance), Position: 2},
			},
			Connectors: []core.ConnectorInput{
				{From: "Plan A", Name: "done"}, {From: "Accept A", Name: "pass"}, {From: "Plan B", Name: "done"}, {From: "Accept B", Name: "pass"},
			},
		}
		builtins := func(in core.WorkflowsInput, want string) {
			t.Helper()
			if _, err := f.svc.SetWorkflow(ctx, f.admin, "BRK", in, core.Idem{}); err != nil {
				t.Fatal(err)
			}
			d := f.fileTask(lead, core.NewTask{Project: ptrStr("BRK"), Title: "Split " + want, Breakdown: true})
			if got := f.at(d.Subtasks[0].Key); got != "Plan "+want {
				t.Fatalf("the Breakdown is at %s, want Plan %s", got, want)
			}
			f.claim(lead, d.Subtasks[0].Key, noTimeout)
			f.complete(lead, d.Subtasks[0].Key)
			subs := f.get(d.Task.Key).Subtasks
			if len(subs) != 2 || subs[1].Kind != "acceptance" {
				t.Fatalf("Subtasks of %s: %+v", d.Task.Key, subs)
			}
			if got := f.at(subs[1].Key); got != "Accept "+want {
				t.Fatalf("the Acceptance is at %s, want Accept %s", got, want)
			}
		}
		builtins(brk, "A")
		brk = asSet(f.workflows("BRK"))
		brk.Workflows[0].Position, brk.Workflows[1].Position = 2, 1
		builtins(brk, "B")

		// A copy takes the Workflows with their names and order, each Step in its own.
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "SUP2", Name: "Support two", Workflow: core.WorkflowCopy,
			CopyFrom: ptrStr("SUP")}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if a, b := f.workflowText("SUP"), f.workflowText("SUP2"); a != b || !strings.HasPrefix(b, "Triage: Investigate") {
			t.Fatalf("the copy:\n%s\nof\n%s", b, a)
		}
		f.checkActivity()
	})
}

// workflows reads the Project's Workflows.
func (f *fixture) workflows(project string) core.Workflows {
	f.t.Helper()
	d, err := f.svc.GetWorkflow(f.t.Context(), f.admin, project)
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Workflows
}

// The write puts a Project's whole graph in place, its Workflows with it. A Workflow renamed
// alone records workflow.changed, with the Workflows and each Step's Workflow. A Workflow left
// out is deleted with the Steps the body leaves out; a Step of it the body keeps moves into
// another Workflow; the open Tasks at its deleted Steps need moves (step_in_use), which may carry
// them into a Step of another Workflow. A Workflow sent without an id keeps the id of the one
// with its name unless another entry of the body carries that id; sent back as read without
// their ids, the Workflows are unchanged and write nothing.
func TestSetWorkflows(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)

		// Bugs joins Work: Investigate leads into Work's Build, and both Workflows have a Step at 1.
		w := asSet(f.workflows("WEB"))
		w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Bugs", Position: 2})
		w.Steps = append(w.Steps, core.StepInput{Workflow: "Bugs", Name: "Investigate", Skill: ptrStr(core.SkillEngineer), Position: 1},
			core.StepInput{Workflow: "Bugs", Name: "Verify", Position: 2})
		w.Connectors = append(w.Connectors, core.ConnectorInput{From: "Investigate", To: ptrStr("Build"), Name: "fix it"},
			core.ConnectorInput{From: "Verify", Name: "done"})
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		const two = "Work: Backlog · Plan (breakdown) · Build (engineer) · Review (review) · Retro (retro) · Skill review (skill-review) / " +
			"Bugs: Investigate (engineer) · Verify | " +
			"Plan -done-> Done · Build -pass-> Review · Review -pass-> Done · Review -needs changes-> Build · " +
			"Retro -done-> Done · Retro -propose-> Skill review · Skill review -publish-> Done · Skill review -needs changes-> Retro · " +
			"Investigate -fix it-> Build · Verify -done-> Done"
		if got := f.workflowText("WEB"); got != two {
			t.Fatalf("with Bugs:\n%s", got)
		}
		ids := f.workflowIDs("WEB")

		// Sent back as read without the Workflows' ids, nothing changes.
		n := f.checkActivity()
		w = asSet(f.workflows("WEB"))
		for i := range w.Workflows {
			w.Workflows[i].ID = ""
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil || f.checkActivity() != n {
			t.Fatalf("unchanged Workflows wrote %d entries (%v)", f.checkActivity()-n, err)
		}

		// Renaming a Workflow alone is a change, recorded with the Workflows and each Step's.
		w = asSet(f.workflows("WEB"))
		w.Workflows[1].Name = "Defects"
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		changed := f.activity("workflow.changed")
		last := changed[len(changed)-1].Payload
		wfs, _ := last["workflows"].([]any)
		if len(wfs) != 2 {
			t.Fatalf("workflow.changed's workflows: %+v", last["workflows"])
		}
		if d := wfs[1].(map[string]any); d["id"] != ids["Bugs"] || d["name"] != "Defects" || d["position"] != float64(2) {
			t.Fatalf("workflow.changed's second Workflow: %+v", d)
		}
		for _, s := range last["steps"].([]any) {
			if id, _ := s.(map[string]any)["workflow_id"].(string); id != ids["Work"] && id != ids["Bugs"] {
				t.Fatalf("a Step of workflow.changed without its Workflow: %+v", s)
			}
		}

		// Defects is left out: Investigate goes with it, while Verify is kept and moves into Work.
		// The open Task at Investigate needs moves; moved into Build, it changes Workflow.
		stuck := f.task(lead, "WEB", "Stuck", "Investigate")
		waiting := f.task(lead, "WEB", "Waiting", "Verify")
		investigate, verify := f.step("WEB", "Investigate"), f.step("WEB", "Verify")
		w = asSet(f.workflows("WEB"))
		w.Workflows = w.Workflows[:1]
		w.Steps = slices.DeleteFunc(w.Steps, func(s core.StepInput) bool { return s.ID == investigate })
		for i := range w.Steps {
			if w.Steps[i].ID == verify {
				w.Steps[i].Workflow, w.Steps[i].Position = "Work", 7
			}
		}
		w.Connectors = slices.DeleteFunc(w.Connectors, func(k core.ConnectorInput) bool { return k.From == investigate })
		_, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{})
		wantCode(t, err, core.CodeStepInUse)
		if !strings.Contains(err.Error(), "1 open Tasks are at Investigate") {
			t.Fatalf("the refusal reads %v", err)
		}
		w.Moves = map[string]string{investigate: "Build"}
		after, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if wfs := after.Workflows.Workflows; len(wfs) != 1 || wfs[0].ID != ids["Work"] {
			t.Fatalf("Workflows after Defects left: %+v", wfs)
		}
		if f.count(`SELECT COUNT(*) FROM steps WHERE id = $1`, investigate) != 0 {
			t.Fatal("Investigate outlived its Workflow")
		}
		if d := f.get(stuck.Key); d.Step == nil || d.Step.Name != "Build" || d.Step.WorkflowID != ids["Work"] {
			t.Fatalf("the stuck Task is at %+v", d.Step)
		}
		if d := f.get(waiting.Key); d.Step == nil || d.Step.ID != verify || d.Step.WorkflowID != ids["Work"] || d.Step.Position != 7 {
			t.Fatalf("Verify, kept, is %+v", d.Step)
		}
		moved := f.activity("task.moved")
		if m := moved[len(moved)-1]; m.SubjectID != stuck.ID || m.Payload["workflow_changed"] != true || m.Payload["from"] != investigate {
			t.Fatalf("task.moved %+v", m)
		}

		// Work renamed Main by its id, and a new Workflow named Work: the new one does not take
		// Main's id, which the body carries.
		w = asSet(f.workflows("WEB"))
		w.Workflows[0].Name = "Main"
		w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Work", Position: 2})
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.workflowIDs("WEB"); got["Main"] != ids["Work"] || got["Work"] == "" || got["Work"] == ids["Work"] {
			t.Fatalf("Main and a new Work: %v (Work was %s)", got, ids["Work"])
		}

		// Verify, kept, moves into a new Workflow, Checks, while Work, where it was, is deleted: the
		// Task at it stays, and the Step keeps its id.
		w = asSet(f.workflows("WEB"))
		for i := range w.Steps {
			if w.Steps[i].ID == verify {
				w.Steps[i].Workflow = "Work"
			}
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		oldWork := f.workflowIDs("WEB")["Work"]
		if d := f.get(waiting.Key); d.Step == nil || d.Step.ID != verify || d.Step.WorkflowID != oldWork {
			t.Fatalf("Verify put in the new Work: %+v", d.Step)
		}
		w = asSet(f.workflows("WEB"))
		w.Workflows = slices.DeleteFunc(w.Workflows, func(wf core.WorkflowInput) bool { return wf.ID == oldWork })
		w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Checks", Position: 2})
		for i := range w.Steps {
			if w.Steps[i].ID == verify {
				w.Steps[i].Workflow = "Checks"
			}
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatalf("Verify into a new Workflow as its old one goes: %v", err)
		}
		got := f.workflowIDs("WEB")
		if len(got) != 2 || got["Checks"] == "" || got["Work"] != "" || f.count(`SELECT COUNT(*) FROM workflows WHERE id = $1`, oldWork) != 0 {
			t.Fatalf("Workflows after Work left and Checks came: %v", got)
		}
		if d := f.get(waiting.Key); d.Step == nil || d.Step.ID != verify || d.Step.WorkflowID != got["Checks"] || d.Step.Position != 1 {
			t.Fatalf("Verify, moved into Checks, is %+v", d.Step)
		}

		// Two Steps of different Workflows swap their names in one write; each keeps its id.
		backlog := f.step("WEB", "Backlog")
		w = asSet(f.workflows("WEB"))
		for i := range w.Steps {
			switch w.Steps[i].ID {
			case backlog:
				w.Steps[i].Name = "Verify"
			case verify:
				w.Steps[i].Name = "Backlog"
			}
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatalf("swapping two Steps' names across Workflows: %v", err)
		}
		if f.step("WEB", "Verify") != backlog || f.step("WEB", "Backlog") != verify {
			t.Fatalf("swapped: Verify is %s, Backlog is %s; were %s, %s", f.step("WEB", "Verify"), f.step("WEB", "Backlog"), verify, backlog)
		}

		// One Workflow with no Steps at all: the write takes it, and filing is then refused no_step.
		if _, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "NIL", Name: "Nothing yet", Workflow: core.WorkflowEmpty,
			Members: []string{"lead"}}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		bare, err := f.svc.SetWorkflow(ctx, f.admin, "NIL", core.WorkflowsInput{Workflows: []core.WorkflowInput{{Name: "Work", Position: 1}}}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if len(bare.Workflows.Workflows) != 1 || len(bare.Steps) != 0 || len(bare.Connectors) != 0 {
			t.Fatalf("a Workflow with no Steps: %+v", bare.Workflows)
		}
		_, err = f.svc.FileTask(ctx, lead, core.NewTask{Project: ptrStr("NIL"), Title: "Nowhere to stand"}, core.Idem{})
		wantCode(t, err, core.CodeNoStep)
		f.checkActivity()
	})
}

// An ended Task at a deleted Step goes where moves says, as the open ones do: its last_step_id
// becomes the target; with no moves for it, it becomes null.
func TestSetWorkflowMovesEndedTasks(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		w := asSet(f.workflows("WEB"))
		w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Bugs", Position: 2})
		w.Steps = append(w.Steps, core.StepInput{Workflow: "Bugs", Name: "Investigate", Skill: ptrStr(core.SkillEngineer), Position: 1},
			core.StepInput{Workflow: "Bugs", Name: "Verify", Position: 2})
		w.Connectors = append(w.Connectors, core.ConnectorInput{From: "Investigate", Name: "fixed"})
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		lastStep := func(task string) string {
			t.Helper()
			var id *string
			if err := f.st.QueryRow(ctx, `SELECT last_step_id FROM tasks WHERE id = $1`, task).Scan(&id); err != nil {
				t.Fatal(err)
			}
			if id == nil {
				return "-"
			}
			return *id
		}
		moved := f.task(lead, "WEB", "Ended at Investigate", "Investigate")
		dropped := f.task(lead, "WEB", "Ended at Verify", "Verify")
		for _, task := range []core.Task{moved, dropped} {
			if _, err := f.svc.DropTask(ctx, lead, task.Key, nil, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		completed := f.task(lead, "WEB", "Completed at Investigate", "Investigate")
		f.claim(builder, completed.Key, noTimeout)
		f.complete(builder, completed.Key)
		investigate, verify := f.step("WEB", "Investigate"), f.step("WEB", "Verify")
		if lastStep(moved.ID) != investigate || lastStep(dropped.ID) != verify || lastStep(completed.ID) != investigate {
			t.Fatalf("ended at %s, %s and %s", lastStep(moved.ID), lastStep(dropped.ID), lastStep(completed.ID))
		}
		w = asSet(f.workflows("WEB"))
		w.Workflows = w.Workflows[:1]
		w.Steps = slices.DeleteFunc(w.Steps, func(s core.StepInput) bool { return s.ID == investigate || s.ID == verify })
		w.Connectors = slices.DeleteFunc(w.Connectors, func(k core.ConnectorInput) bool { return k.From == investigate })
		w.Moves = map[string]string{investigate: "Build"}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := lastStep(moved.ID); got != f.step("WEB", "Build") {
			t.Fatalf("the ended Task moved off Investigate ended at %s", got)
		}
		if got := lastStep(completed.ID); got != f.step("WEB", "Build") {
			t.Fatalf("the completed Task moved off Investigate ended at %s", got)
		}
		if got := lastStep(dropped.ID); got != "-" {
			t.Fatalf("the ended Task at Verify, which moves did not name, ended at %s", got)
		}
		// Its Workflow went with its last Step: it has none, and workflow:not matches it.
		if wf := f.get(dropped.Key).Task.WorkflowID; wf != nil {
			t.Fatalf("the ended Task whose last Step was deleted is in Workflow %s", *wf)
		}
		if got := f.get(moved.Key).Task.WorkflowID; got == nil || *got != f.workflowIDs("WEB")[core.WorkflowFirstName] {
			t.Fatalf("the ended Task moved onto Build is in Workflow %v", got)
		}
		work := f.workflowIDs("WEB")[core.WorkflowFirstName]
		if got := f.filterKeys(core.TaskFilter{Project: ptrStr("WEB"), Filters: []string{"workflow:not:" + work}}); !slices.Contains(got, dropped.Key) || slices.Contains(got, moved.Key) {
			t.Fatalf("workflow:not:Work lists %v", got)
		}
		f.checkActivity()
	})
}

// A Step's id and a Connector's id are read in either form (ADR 0017): sent short, they name the
// same Step and Connector, so the Workflows put back are unchanged and write nothing.
func TestSetWorkflowReadsShortIDs(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		w := asSet(f.workflows("WEB"))
		for i := range w.Steps {
			w.Steps[i].ID = shortid.Short(w.Steps[i].ID)
		}
		for i := range w.Connectors {
			w.Connectors[i].ID = shortid.Short(w.Connectors[i].ID)
		}
		if w.Steps[0].ID == f.step("WEB", "Backlog") || len(w.Connectors) == 0 || w.Connectors[0].ID == f.workflows("WEB").Connectors[0].ID {
			t.Fatalf("the ids are not short: Step %s, Connector %s", w.Steps[0].ID, w.Connectors[0].ID)
		}
		n := f.checkActivity()
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.checkActivity(); got != n || len(f.activity("workflow.changed")) != 1 {
			t.Fatalf("short ids wrote %d entries", got-n)
		}
	})
}

// An ended Task keeps the Step it ended at, set by the write that ends it: advanced into Done,
// completed, dropped, or dropped with its Parent. Its Workflow is that of its Step, or of the
// Step it ended at; a Parent and a Task aimed at a Member have neither. ListTasks' workflow (by
// id, or by name with the project) and the workflow filter read the same.
func TestEndedTaskKeepsItsLastStep(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		w := asSet(f.workflows("WEB"))
		w.Workflows = append(w.Workflows, core.WorkflowInput{Name: "Bugs", Position: 2})
		w.Steps = append(w.Steps, core.StepInput{Workflow: "Bugs", Name: "Investigate", Skill: ptrStr(core.SkillEngineer), Position: 1},
			core.StepInput{Workflow: "Bugs", Name: "Verify", Position: 2})
		w.Connectors = append(w.Connectors, core.ConnectorInput{From: "Investigate", Name: "fixed"},
			core.ConnectorInput{From: "Investigate", To: ptrStr("Verify"), Name: "check"},
			core.ConnectorInput{From: "Build", To: ptrStr("Investigate"), Name: "bug"})
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", w, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.chainBuildIntoDone("WEB")
		ids := f.workflowIDs("WEB")
		work, bugs := ids[core.WorkflowFirstName], ids["Bugs"]
		build, investigate, verify := f.step("WEB", "Build"), f.step("WEB", "Investigate"), f.step("WEB", "Verify")
		str := func(p *string) string {
			if p == nil {
				return "-"
			}
			return *p
		}
		check := func(what string, task core.Task, last, wf string) {
			t.Helper()
			if str(task.LastStepID) != last || str(task.WorkflowID) != wf {
				t.Errorf("%s: last Step %s, Workflow %s; want %s, %s", what, str(task.LastStepID), str(task.WorkflowID), last, wf)
			}
			read := f.get(task.Key).Task
			if str(read.LastStepID) != last || str(read.WorkflowID) != wf {
				t.Errorf("%s read back: last Step %s, Workflow %s; want %s, %s", what, str(read.LastStepID), str(read.WorkflowID), last, wf)
			}
		}

		// Open at a Step: no last Step, its Step's Workflow; across a Connector into Bugs, Bugs.
		open := f.task(lead, "WEB", "Open", "Build")
		check("open", open, "-", work)
		crossed := f.task(lead, "WEB", "Crossed", "Build")
		f.claim(builder, crossed.Key, noTimeout)
		check("crossed into Bugs", f.advance(builder, crossed.Key, "bug"), "-", bugs)

		// Advanced into Done, completed, dropped: the Step it ended at, and that Step's Workflow.
		fixed := f.task(lead, "WEB", "Fixed", "Investigate")
		f.claim(builder, fixed.Key, noTimeout)
		ended := f.advance(builder, fixed.Key, "fixed")
		if ended.State != "done" || ended.StepID != nil {
			t.Fatalf("advanced into Done: %s at %s", ended.State, str(ended.StepID))
		}
		check("advanced into Done", ended, investigate, bugs)
		built := f.task(lead, "WEB", "Built", "Build")
		f.claim(builder, built.Key, noTimeout)
		check("completed", f.complete(builder, built.Key), build, work)
		gone := f.task(lead, "WEB", "Gone", "Verify")
		dropped, err := f.svc.DropTask(ctx, lead, gone.Key, nil, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		check("dropped", dropped, verify, bugs)

		// A Parent and a Task aimed at a Member are at no Step and in no Workflow; dropping the
		// Parent ends each open Subtask at its Step, in the same write.
		pd := f.parent(lead, "WEB", "Chat")
		sub := f.subtask(lead, pd.Task.ID, "Sub", "Verify")
		aimed := f.aimed(lead, "WEB", "Which provider?", "builder")
		check("Parent", pd.Task, "-", "-")
		check("aimed", aimed, "-", "-")
		breakdown := f.get(pd.Task.Key).Subtasks[0]
		if breakdown.Kind != "breakdown" || breakdown.StepID == nil {
			t.Fatalf("the Parent's first Subtask is %s at %s", breakdown.Kind, str(breakdown.StepID))
		}
		breakdownAt := *breakdown.StepID
		parentDropped, err := f.svc.DropTask(ctx, lead, pd.Task.Key, nil, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		check("dropped Parent", parentDropped, "-", "-")
		check("Subtask dropped with its Parent", f.get(sub.Key).Task, verify, bugs)
		check("Breakdown dropped with its Parent", f.get(breakdown.Key).Task, breakdownAt, work)

		// ListTasks' workflow: the Tasks at its Steps and those that ended at one.
		inBugs := sortedKeys(crossed.Key, fixed.Key, gone.Key, sub.Key)
		for _, tf := range []core.TaskFilter{
			{Project: ptrStr("WEB"), Workflow: ptrStr("bugs")},
			{Project: ptrStr("WEB"), Workflow: ptrStr(bugs)},
			{Workflow: ptrStr(bugs)},
			{Filters: []string{"workflow:is:" + bugs}},
		} {
			if got := f.filterKeys(tf); !slices.Equal(got, inBugs) {
				t.Errorf("%v %q lists %v, want %v", str(tf.Workflow), tf.Filters, got, inBugs)
			}
		}
		_, err = f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Workflow: ptrStr("Bugs")})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Project: ptrStr("WEB"), Workflow: ptrStr("Triage")})
		wantCode(t, err, core.CodeNotFound)

		all := f.filterKeys(core.TaskFilter{Project: ptrStr("WEB")})
		without := func(keys ...string) []string {
			return slices.DeleteFunc(slices.Clone(all), func(k string) bool { return slices.Contains(keys, k) })
		}
		if got, want := f.filterKeys(core.TaskFilter{Filters: []string{"workflow:in:" + work + "," + bugs}}), without(pd.Task.Key, aimed.Key); !slices.Equal(got, want) {
			t.Errorf("workflow:in:Work,Bugs lists %v, want %v", got, want)
		}
		// not and nin also match a Task in no Workflow: the Parent and the aimed Task.
		for _, tok := range []string{"workflow:nin:" + bugs, "workflow:not:" + bugs} {
			got, want := f.filterKeys(core.TaskFilter{Filters: []string{tok}}), without(inBugs...)
			if !slices.Equal(got, want) || !slices.Contains(got, pd.Task.Key) || !slices.Contains(got, aimed.Key) {
				t.Errorf("%s lists %v, want %v", tok, got, want)
			}
		}
		f.checkActivity()
	})
}
