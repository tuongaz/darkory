package core_test

import (
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
	"github.com/tuongaz/darkory/internal/wake"
)

// A fresh Install: an empty database takes the migrations, 0001 to 0008, and `darkory init` (the
// roster on) yields the Organisation, its first Member an admin, the builtin Skills breakdown,
// retro, skill-review and acceptance, the generic engineer, review, triage and qa, the roster's
// five agents, and Project MAIN on the default Workflows, Implementation then Bug triage, each
// Step at its decided place on the canvas and taken by the agent holding its Skill.
func TestFreshInit(t *testing.T) {
	for _, engine := range storetest.Engines() {
		t.Run(string(engine), func(t *testing.T) {
			st := storetest.OpenUnmigrated(t, engine)
			ctx := t.Context()
			res, err := st.Migrate(ctx)
			if err != nil || !slices.Equal(res.Applied, []int{1, 2, 3, 4, 5, 6, 7, 8}) {
				t.Fatalf("migrated a fresh database: %+v, %v", res, err)
			}
			f := &fixture{t: t, st: st, clock: clockAt(epoch), secrets: map[string]string{}}
			f.svc = core.New(st, f.clock, wake.New(), nil)
			f.auth = auth.New(st, f.clock)
			out, err := f.svc.InitWith(ctx, "Sacca", "tuongaz", core.InitOptions{Roster: true})
			if err != nil {
				t.Fatal(err)
			}
			f.secrets[out.Member.ID] = out.Token.Secret
			f.admin = f.session(out.Member.ID, "tuongaz-1")

			me, err := f.svc.GetMe(ctx, f.admin)
			if err != nil || me.Organisation.Name != "Sacca" || me.Organisation.ID != out.Organisation.ID || me.Member.Name != "tuongaz" ||
				!me.Member.Admin || me.Member.Kind != "human" || len(me.Projects) != 1 || me.Projects[0].Key != "MAIN" {
				t.Fatalf("me %+v, %v", me, err)
			}

			skills, err := f.svc.ListSkills(ctx, f.admin, nil)
			if err != nil {
				t.Fatal(err)
			}
			builtin := map[string]bool{}
			for _, s := range skills {
				if s.Kind != "generic" || s.CurrentVersion != 1 {
					t.Errorf("seeded Skill %+v", s)
				}
				builtin[s.Name] = s.Builtin
			}
			want := map[string]bool{
				core.SkillBreakdown: true, core.SkillRetro: true, core.SkillSkillReview: true, core.SkillAcceptance: true,
				core.SkillEngineer: false, core.SkillReview: false, core.SkillTriage: false, core.SkillQA: false,
			}
			if len(builtin) != len(want) {
				t.Fatalf("seeded Skills %v", builtin)
			}
			for name, b := range want {
				if got, ok := builtin[name]; !ok || got != b {
					t.Fatalf("Skill %s: seeded %v, builtin %v; want builtin %v", name, ok, got, b)
				}
			}

			// The roster: the first Member and the five agents in MAIN, each with its Skills.
			held := map[string]string{}
			for _, a := range out.Agents {
				held[a.Member.Name] = strings.Join(a.Skills, " ")
			}
			if want := map[string]string{"planner": "breakdown triage", "builder": "engineer", "reviewer": "review skill-review", "tester": "qa", "retro": "retro"}; !maps.Equal(held, want) {
				t.Fatalf("the roster holds %v, want %v", held, want)
			}
			project, err := f.svc.GetProject(ctx, f.admin, "MAIN")
			if err != nil {
				t.Fatal(err)
			}
			var members []string
			for _, m := range project.Members {
				members = append(members, m.Name+"/"+m.Kind)
			}
			if !slices.Equal(members, []string{"builder/agent", "planner/agent", "retro/agent", "reviewer/agent", "tester/agent", "tuongaz/human"}) ||
				project.Project.AutoComplete || project.Project.Acceptance || project.Project.DefaultWorkspaceID != nil {
				t.Fatalf("MAIN %+v holds %v", project.Project, members)
			}

			// MAIN's Workflows are the default two, compact, and each Step's takers are the agents
			// with its Skill; Backlog, a hold, has none.
			w, err := f.svc.GetWorkflow(ctx, f.admin, "MAIN")
			if err != nil {
				t.Fatal(err)
			}
			if got := workflowText(skills, w.Workflows); got != defaultWorkflowText {
				t.Fatalf("MAIN's Workflow:\n%s", got)
			}
			checkDefaultPlaces(t, w.Workflows)
			takers := map[string]string{
				"Backlog": "", "Plan": "planner", "Build": "builder", "Review": "reviewer", "Retro": "retro", "Skill review": "reviewer",
				"Triage": "planner", "Fix": "builder", "Code review": "reviewer", "Verify": "tester",
			}
			for i, s := range w.Steps {
				var names []string
				for _, tk := range w.Facts[i].Takers {
					names = append(names, tk.Name)
				}
				if got := strings.Join(names, ","); got != takers[s.Name] {
					t.Errorf("Step %s is taken by %v, want %q", s.Name, names, takers[s.Name])
				}
			}

			// A Task filed in MAIN starts at Implementation's Build; with Break down, its Breakdown
			// at Plan; a Task filed at Triage is in Bug triage.
			if d := f.fileTask(f.admin, core.NewTask{Project: ptrStr("MAIN"), Title: "Support emoji"}); d.Step == nil || d.Step.Name != "Build" ||
				d.Task.Key != "MAIN-1" || d.Step.WorkflowID != w.Workflows.Workflows[0].ID {
				t.Fatalf("filed %+v at %+v", d.Task, d.Step)
			}
			if d := f.fileTask(f.admin, core.NewTask{Project: ptrStr("MAIN"), Title: "Checkout fails", Step: ptrStr("Triage")}); d.Step == nil ||
				d.Step.Name != "Triage" || d.Step.WorkflowID != w.Workflows.Workflows[1].ID {
				t.Fatalf("filed at Triage: %+v at %+v", d.Task, d.Step)
			}
			if d := f.fileTask(f.admin, core.NewTask{Project: ptrStr("MAIN"), Title: "Cart", Breakdown: true}); len(d.Subtasks) != 1 ||
				f.at(d.Subtasks[0].Key) != "Plan" {
				t.Fatalf("filed with Break down: %+v", d.Subtasks)
			}
			f.checkActivity()
		})
	}
}

// Without the roster (`darkory init --no-agents`) InitWith still seeds Project MAIN on the default
// Workflow, holding the first Member alone: no agents, no Workspace.
func TestInitSeedsProjectMainWithoutTheRoster(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := &fixture{t: t, st: st, clock: clockAt(epoch), secrets: map[string]string{}}
		f.svc = core.New(st, f.clock, wake.New(), nil)
		f.auth = auth.New(st, f.clock)
		ctx := t.Context()
		out, err := f.svc.InitWith(ctx, "Acme", "ada", core.InitOptions{Project: true})
		if err != nil {
			t.Fatal(err)
		}
		if out.Project == nil || out.Project.Key != "MAIN" || out.Project.Name != "Main" || out.Workspace != nil || len(out.Agents) != 0 {
			t.Fatalf("seeded %+v, Workspace %+v, %d agents", out.Project, out.Workspace, len(out.Agents))
		}
		f.secrets[out.Member.ID] = out.Token.Secret
		f.admin = f.session(out.Member.ID, "ada-1")
		p, err := f.svc.GetProject(ctx, f.admin, "MAIN")
		if err != nil || len(p.Members) != 1 || p.Members[0].Name != "ada" || p.Project.DefaultWorkspaceID != nil {
			t.Fatalf("MAIN %+v holds %+v, %v", p.Project, p.Members, err)
		}
		agents, err := f.svc.ListMembers(ctx, f.admin, nil, ptrStr("agent"))
		if err != nil || len(agents) != 0 {
			t.Fatalf("agents %+v, %v", agents, err)
		}
		skills, err := f.svc.ListSkills(ctx, f.admin, nil)
		if err != nil {
			t.Fatal(err)
		}
		w, err := f.svc.GetWorkflow(ctx, f.admin, "MAIN")
		if err != nil {
			t.Fatal(err)
		}
		if got := workflowText(skills, w.Workflows); got != defaultWorkflowText {
			t.Fatalf("MAIN's Workflow:\n%s", got)
		}
		f.checkActivity()
	})
}
