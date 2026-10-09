package core_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/wake"
)

var epoch = time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)

// fixture is an initialised Install with a fake clock, and helpers to add Members.
type fixture struct {
	t       *testing.T
	st      *store.Store
	svc     *core.Service
	clock   *clock.Fake
	auth    *auth.Authenticator
	admin   *auth.Caller
	secrets map[string]string // Member id → token secret
}

func newFixture(t *testing.T, st *store.Store) *fixture {
	t.Helper()
	f := &fixture{t: t, st: st, clock: clock.NewFake(epoch), secrets: map[string]string{}}
	f.svc = core.New(st, f.clock, wake.New(), nil)
	f.auth = auth.New(st, f.clock)
	init, err := f.svc.Init(t.Context(), "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	f.secrets[init.Member.ID] = init.Token.Secret
	f.admin = f.session(init.Member.ID, "ada-1")
	return f
}

// session returns a Caller for the Member through the Session id chosen.
func (f *fixture) session(memberID, chosen string) *auth.Caller {
	f.t.Helper()
	c, err := f.auth.Authenticate(f.t.Context(), auth.Credentials{Bearer: f.secrets[memberID], Session: chosen})
	if err != nil {
		f.t.Fatalf("authenticate %s: %v", chosen, err)
	}
	return c
}

// skillID is the id of the Skill named name.
func (f *fixture) skillID(name string) string {
	f.t.Helper()
	d, err := f.svc.GetSkill(f.t.Context(), f.admin, name)
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Skill.ID
}

// project creates a Project on the default Workflows and returns its id: Implementation —
// Backlog (hold), Plan (breakdown), Build (engineer), Review (review), Retro (retro), Skill review
// (skill-review) — then Bug triage — Triage (triage), Fix (engineer), Code review (review),
// Verify (qa).
func (f *fixture) project(key string) string {
	f.t.Helper()
	p, err := f.svc.CreateProject(f.t.Context(), f.admin, core.NewProject{Key: key, Name: "Project " + key}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return p.Project.ID
}

// workProject creates a Project of one Workflow, Work, holding the Steps of a default Project's
// Implementation with their Skills, Connectors and places, and returns its id: a graph for the
// tests of SetWorkflow to change that does not follow what a new Project starts with.
func (f *fixture) workProject(key string) string {
	f.t.Helper()
	ctx := f.t.Context()
	p, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: key, Name: "Project " + key, Workflow: core.WorkflowEmpty}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	in := core.WorkflowsInput{Workflows: []core.WorkflowInput{{Name: core.WorkflowFirstName, Position: 1}}}
	for i, s := range []struct {
		name, skill string
		x, y        int64
	}{
		{"Backlog", "", 0, 0}, {"Plan", core.SkillBreakdown, 0, 128}, {"Build", core.SkillEngineer, 0, 256},
		{"Review", core.SkillReview, 448, 256}, {"Retro", core.SkillRetro, 0, 384}, {"Skill review", core.SkillSkillReview, 448, 384},
	} {
		si := core.StepInput{Workflow: core.WorkflowFirstName, Name: s.name, Position: int64(i + 1), X: ptrInt(s.x), Y: ptrInt(s.y)}
		if s.skill != "" {
			si.Skill = ptrStr(s.skill)
		}
		in.Steps = append(in.Steps, si)
	}
	for _, k := range [][3]string{
		{"Plan", "", "done"}, {"Build", "Review", "pass"}, {"Review", "", "pass"}, {"Review", "Build", "needs changes"},
		{"Retro", "", "done"}, {"Retro", "Skill review", "propose"}, {"Skill review", "", "publish"}, {"Skill review", "Retro", "needs changes"},
	} {
		ci := core.ConnectorInput{From: k[0], Name: k[2]}
		if k[1] != "" {
			ci.To = ptrStr(k[1])
		}
		in.Connectors = append(in.Connectors, ci)
	}
	if _, err := f.svc.SetWorkflow(ctx, f.admin, key, in, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
	return p.Project.ID
}

// inWork is in with one Workflow, Work, holding every Step of it.
func inWork(in core.WorkflowsInput) core.WorkflowsInput {
	in.Workflows = []core.WorkflowInput{{Name: core.WorkflowFirstName, Position: 1}}
	in.Steps = slices.Clone(in.Steps)
	for i := range in.Steps {
		in.Steps[i].Workflow = core.WorkflowFirstName
	}
	return in
}

// chain replaces the Project's Workflows with one, Work, of steps, each a name and a Skill (""
// for a hold), in order, each leading to the next ("pass") and the last into Done ("pass").
func (f *fixture) chain(project string, steps ...[2]string) core.Workflows {
	f.t.Helper()
	in := core.WorkflowsInput{Workflows: []core.WorkflowInput{{Name: core.WorkflowFirstName, Position: 1}}}
	for i, st := range steps {
		si := core.StepInput{Workflow: core.WorkflowFirstName, Name: st[0], Position: int64(i + 1)}
		if st[1] != "" {
			si.Skill = ptrStr(st[1])
		}
		in.Steps = append(in.Steps, si)
		ci := core.ConnectorInput{From: st[0], Name: "pass"}
		if i+1 < len(steps) {
			ci.To = ptrStr(steps[i+1][0])
		}
		in.Connectors = append(in.Connectors, ci)
	}
	w, err := f.svc.SetWorkflow(f.t.Context(), f.admin, project, in, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return w.Workflows
}

// step is the id of the Project's Step named name.
func (f *fixture) step(project, name string) string {
	f.t.Helper()
	d, err := f.svc.GetWorkflow(f.t.Context(), f.admin, project)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, st := range d.Steps {
		if st.Name == name {
			return st.ID
		}
	}
	f.t.Fatalf("Project %s has no Step %s", project, name)
	return ""
}

func (f *fixture) skill(name string) string {
	f.t.Helper()
	d, err := f.svc.CreateSkill(f.t.Context(), f.admin, core.NewSkill{Name: name, Kind: "generic", Body: name + " well"}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Skill.ID
}

// member creates an agent Member in projects with skills, a token, and returns a Caller through
// a Session named after it.
func (f *fixture) member(name string, projects, skills []string) *auth.Caller {
	f.t.Helper()
	ctx := f.t.Context()
	m, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: name, Kind: "agent"}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	for _, p := range projects {
		if err := f.svc.AddProjectMember(ctx, f.admin, p, m.ID, core.Idem{}); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, sk := range skills {
		if err := f.svc.GrantSkill(ctx, f.admin, m.ID, sk, core.Idem{}); err != nil {
			f.t.Fatal(err)
		}
	}
	tok, err := f.svc.IssueToken(ctx, f.admin, m.ID, "main", 0, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	f.secrets[m.ID] = tok.Secret
	return f.session(m.ID, name+"-1")
}

// fileTask files nt as c and returns the Task's detail.
func (f *fixture) fileTask(c *auth.Caller, nt core.NewTask) core.TaskDetail {
	f.t.Helper()
	d, err := f.svc.FileTask(f.t.Context(), c, nt, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d
}

// task files a Task in project as c at step.
func (f *fixture) task(c *auth.Caller, project, title, step string) core.Task {
	f.t.Helper()
	return f.fileTask(c, core.NewTask{Project: &project, Title: title, Step: &step}).Task
}

// subtask files a Subtask under parent as c at step.
func (f *fixture) subtask(c *auth.Caller, parent, title, step string) core.Task {
	f.t.Helper()
	return f.fileTask(c, core.NewTask{Parent: &parent, Title: title, Step: &step}).Task
}

// parent files a Task in project as c with Break down on: a Parent with its Breakdown Subtask.
func (f *fixture) parent(c *auth.Caller, project, title string) core.TaskDetail {
	f.t.Helper()
	return f.fileTask(c, core.NewTask{Project: &project, Title: title, Breakdown: true})
}

// aimed files a Task in project as c aimed at member.
func (f *fixture) aimed(c *auth.Caller, project, title, member string) core.Task {
	f.t.Helper()
	return f.fileTask(c, core.NewTask{Project: &project, Title: title, AimedAt: &member}).Task
}

// claim claims the Task as c, failing the test when it cannot.
func (f *fixture) claim(c *auth.Caller, task string, o core.ClaimOptions) core.TaskDetail {
	f.t.Helper()
	d, err := f.svc.Claim(f.t.Context(), c, task, o, core.Idem{})
	if err != nil {
		f.t.Fatalf("claim %s: %v", task, err)
	}
	return d
}

// advance advances the Task c holds along outcome.
func (f *fixture) advance(c *auth.Caller, task, outcome string) core.Task {
	f.t.Helper()
	t, err := f.svc.Advance(f.t.Context(), c, task, outcome, nil, core.Idem{})
	if err != nil {
		f.t.Fatalf("advance %s %q: %v", task, outcome, err)
	}
	return t
}

// get reads the Task.
func (f *fixture) get(task string) core.TaskDetail {
	f.t.Helper()
	d, err := f.svc.GetTask(f.t.Context(), f.admin, task)
	if err != nil {
		f.t.Fatal(err)
	}
	return d
}

// at names the Step the Task is at, "-" for none.
func (f *fixture) at(task string) string {
	f.t.Helper()
	d := f.get(task)
	if d.Step == nil {
		return "-"
	}
	return d.Step.Name
}

func (f *fixture) exec(query string, args ...any) {
	f.t.Helper()
	if err := f.st.WriteBatchNoSeq(f.t.Context(), store.Stmt{SQL: query, Args: args}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.st.QueryRow(f.t.Context(), query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) takeable(c *auth.Caller) map[string]bool {
	f.t.Helper()
	ts, err := f.svc.ListTakeable(f.t.Context(), c, 0)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]bool{}
	for _, t := range ts {
		out[t.ID] = true
	}
	return out
}

func timeout(d time.Duration) core.ClaimOptions { return core.ClaimOptions{Timeout: &d} }

var noTimeout = timeout(0)

func codeOf(err error) core.Code {
	var e *core.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// wantDetail checks a refusal's Details[key], as fmt prints it.
func wantDetail(t *testing.T, err error, key, want string) {
	t.Helper()
	var e *core.Error
	if !errors.As(err, &e) || fmt.Sprint(e.Details[key]) != want {
		t.Fatalf("the refusal %v carries %s %v, want %s", err, key, e.Details[key], want)
	}
}

func wantCode(t *testing.T, err error, code core.Code) {
	t.Helper()
	if codeOf(err) != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

// jsonIdem keeps results and refusals as their JSON, as the server does.
func jsonIdem(key, hash string) core.Idem {
	return core.Idem{Key: key, Hash: hash, Render: func(v any) (int, []byte, error) {
		b, err := json.Marshal(v)
		return 200, b, err
	}, RenderRefusal: func(e *core.Error) (int, []byte, error) {
		b, err := json.Marshal(map[string]string{"code": string(e.Code), "message": e.Message})
		return 409, b, err
	}}
}

// answer is what the server sends for a write's outcome.
type answer struct {
	status int
	body   []byte
}

// answerOf is the answer to a write under idem: its result, the response kept under the key, or
// its refusal. It may run on any goroutine.
func answerOf(t *testing.T, idem core.Idem, result any, err error) answer {
	t.Helper()
	var replay *core.Replay
	var refusal *core.Error
	switch {
	case err == nil:
		b, err := json.Marshal(result)
		if err != nil {
			t.Error(err)
		}
		return answer{200, b}
	case errors.As(err, &replay):
		return answer{replay.Status, replay.Body}
	case errors.As(err, &refusal):
		status, b, err := idem.RenderRefusal(refusal)
		if err != nil {
			t.Error(err)
		}
		return answer{status, b}
	}
	t.Errorf("unexpected error: %v", err)
	return answer{}
}

// checkActivity checks that the Organisation's Activity is numbered 1…n without gaps and that the
// counter agrees.
func (f *fixture) checkActivity() int {
	f.t.Helper()
	rows, err := f.st.Query(f.t.Context(), `SELECT seq FROM activity WHERE org_id = $1 ORDER BY seq`, f.admin.OrgID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			f.t.Fatal(err)
		}
		n++
		if seq != int64(n) {
			f.t.Fatalf("Activity has a gap: entry %d is numbered %d", n, seq)
		}
	}
	if c := f.count(`SELECT seq FROM organisations WHERE id = $1`, f.admin.OrgID); c != n {
		f.t.Fatalf("counter is %d with %d Activity entries", c, n)
	}
	return n
}

func name(prefix string, i int) string { return fmt.Sprintf("%s%02d", prefix, i) }

func ptrStr(s string) *string { return &s }

func ptrBool(b bool) *bool { return &b }

func ptrInt(n int64) *int64 { return &n }

func ptrDur(d time.Duration) *time.Duration { return &d }
