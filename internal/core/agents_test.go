package core_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
	"github.com/tuongaz/darkory/internal/wake"
)

func (f *fixture) workspace(name string) core.Workspace {
	f.t.Helper()
	w, err := f.svc.CreateWorkspace(f.t.Context(), f.admin, core.NewWorkspace{Name: name, Path: "/src/" + name}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return w
}

func (f *fixture) projectDefaults(project string, ch core.ProjectChange) core.Project {
	f.t.Helper()
	p, err := f.svc.UpdateProject(f.t.Context(), f.admin, project, ch, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return p
}

// activity is the Organisation's entries of kind, oldest first.
func (f *fixture) activity(kind string) []core.Activity {
	f.t.Helper()
	p, err := f.svc.ListActivity(f.t.Context(), f.admin, core.ActivityQuery{Kinds: []string{kind}, Limit: 500})
	if err != nil {
		f.t.Fatal(err)
	}
	return p.Items
}

// done claims and completes a Task as c.
func (f *fixture) done(c *auth.Caller, task string) {
	f.t.Helper()
	ctx := f.t.Context()
	if _, err := f.svc.Claim(ctx, c, task, noTimeout, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.svc.Complete(ctx, c, task, nil, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
}

// Workspaces are added, changed and removed by admins only; names are unique ignoring case and
// never spelled as ids, paths absolute, modes and branches checked; a Workspace a Task names
// cannot be removed, and removing a Project's default leaves the Project without one.
func TestWorkspaces(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)

		_, err := f.svc.CreateWorkspace(ctx, lead, core.NewWorkspace{Name: "web", Path: "/src/web"}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		for _, bad := range []core.NewWorkspace{
			{Name: "", Path: "/src/web"},
			{Name: "-web", Path: "/src/web"},
			{Name: "web app", Path: "/src/web"},
			{Name: "0191d8a2-7c3e-7a1b-8c2d-3e4f5a6b7c8d", Path: "/src/web"},
			{Name: "web", Path: "src/web"},
			{Name: "web", Path: "/src/web", Kind: "svn"},
			{Name: "web", Path: "/src/web", Mode: "merge_queue"},
			{Name: "web", Path: "/src/web", DefaultBranch: "-main"},
			{Name: "web", Path: "/src/web", DefaultBranch: "a..b"},
			{Name: "web", Path: "/src/web", DefaultBranch: "main branch"},
		} {
			_, err := f.svc.CreateWorkspace(ctx, f.admin, bad, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		w, err := f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "web", Path: "/src/web/../web/"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if w.Kind != "git" || w.Mode != "plain" || w.DefaultBranch != "main" || w.Path != "/src/web" {
			t.Fatalf("the defaults: %+v", w)
		}
		_, err = f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "WEB", Path: "/src/other"}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		api := f.workspace("api")

		// Changed: only what differs is recorded; an unchanged request writes nothing.
		before := f.checkActivity()
		pr := "pull_request"
		w2, err := f.svc.UpdateWorkspace(ctx, f.admin, "WEB", core.WorkspaceChange{Mode: &pr, Path: ptrStr("/src/web")}, core.Idem{})
		if err != nil || w2.Mode != "pull_request" || w2.Path != "/src/web" {
			t.Fatalf("changed: %+v %v", w2, err)
		}
		changed := f.activity("workspace.changed")
		if len(changed) != 1 || len(changed[0].Payload) != 1 || changed[0].Payload["mode"] != "pull_request" {
			t.Fatalf("workspace.changed: %+v", changed)
		}
		if _, err := f.svc.UpdateWorkspace(ctx, f.admin, w.ID, core.WorkspaceChange{Mode: &pr}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.checkActivity(); n != before+1 {
			t.Fatalf("%d entries after one change, want %d", n, before+1)
		}
		_, err = f.svc.UpdateWorkspace(ctx, f.admin, "web", core.WorkspaceChange{Name: ptrStr("Api")}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.UpdateWorkspace(ctx, lead, "web", core.WorkspaceChange{Mode: &pr}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		list, err := f.svc.ListWorkspaces(ctx, lead)
		if err != nil || len(list) != 2 || list[0].Name != "api" || list[1].Name != "web" {
			t.Fatalf("listed %+v %v", list, err)
		}

		// A Parent and its Breakdown name web; web is WEB's default, api is no one's.
		f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("web")})
		pd := f.parent(lead, "WEB", "Cart")
		if got := pd.Subtasks[0].WorkspaceIDs; !slices.Equal(got, []string{w.ID}) || !slices.Equal(pd.Task.WorkspaceIDs, got) {
			t.Fatalf("the Parent names %v and its Breakdown %v, want the Project's default", pd.Task.WorkspaceIDs, got)
		}
		err = f.svc.RemoveWorkspace(ctx, f.admin, "web", core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if !strings.HasPrefix(err.Error(), "conflict: 2 Tasks name Workspace web;") {
			t.Fatalf("the refusal reads %q", err)
		}
		err = f.svc.RemoveWorkspace(ctx, lead, "api", core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("api")})
		if err := f.svc.RemoveWorkspace(ctx, f.admin, "api", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		proj, err := f.svc.GetProject(ctx, lead, "WEB")
		if err != nil || proj.Project.DefaultWorkspaceID != nil {
			t.Fatalf("WEB after its default was removed: %+v %v", proj.Project, err)
		}
		if removed := f.activity("workspace.removed"); len(removed) != 1 || removed[0].SubjectID != api.ID {
			t.Fatalf("workspace.removed: %+v", removed)
		}
		projectChanged := f.activity("project.changed")
		if last := projectChanged[len(projectChanged)-1]; last.Payload["default_workspace_id"] != nil || len(last.Payload) != 1 {
			t.Fatalf("the last project.changed: %+v", last)
		}
		f.checkActivity()
	})
}

// A Project's default Workspace and its auto_complete and acceptance defaults are set and cleared
// by admins; a Task names the Workspaces it is filed with, in order and each once, an empty list
// naming none, or else its Project's default, or none when the Project has none.
func TestTaskWorkspaces(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillEngineer})
		web, api := f.workspace("web"), f.workspace("api")

		// No default: a Task names none.
		if task := f.task(lead, "WEB", "Unplaced", "Build"); task.WorkspaceIDs != nil {
			t.Fatalf("named %v with no default", task.WorkspaceIDs)
		}
		_, err := f.svc.UpdateProject(ctx, lead, "WEB", core.ProjectChange{DefaultWorkspace: ptrStr("web")}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.UpdateProject(ctx, f.admin, "WEB", core.ProjectChange{DefaultWorkspace: ptrStr("nowhere")}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		p := f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("WEB"), AutoComplete: ptrBool(true), Acceptance: ptrBool(true)})
		if p.DefaultWorkspaceID == nil || *p.DefaultWorkspaceID != web.ID || !p.AutoComplete || !p.Acceptance {
			t.Fatalf("WEB: %+v", p)
		}
		if changed := f.activity("project.changed"); len(changed) != 1 || changed[0].Payload["default_workspace_id"] != web.ID ||
			changed[0].Payload["auto_complete"] != true || changed[0].Payload["acceptance"] != true {
			t.Fatalf("project.changed: %+v", changed)
		}

		file := func(refs *[]string) (core.TaskDetail, error) {
			return f.svc.FileTask(ctx, lead, core.NewTask{Project: ptrStr("WEB"), Title: "T", Step: ptrStr("Build"), Workspaces: refs}, core.Idem{})
		}
		d, err := file(nil)
		if err != nil || !slices.Equal(d.Task.WorkspaceIDs, []string{web.ID}) || len(d.Workspaces) != 1 || d.Workspaces[0].Name != "web" ||
			!d.Task.AutoComplete || !d.Task.Acceptance {
			t.Fatalf("by default: %+v %+v %v", d.Task, d.Workspaces, err)
		}
		d, err = file(&[]string{"api", web.ID, "API"})
		if err != nil || !slices.Equal(d.Task.WorkspaceIDs, []string{api.ID, web.ID}) || d.Workspaces[0].ID != api.ID || d.Workspaces[1].ID != web.ID {
			t.Fatalf("named: %v %+v %v", d.Task.WorkspaceIDs, d.Workspaces, err)
		}
		got, err := f.svc.GetTask(ctx, lead, d.Task.ID)
		if err != nil || !slices.Equal(got.Task.WorkspaceIDs, []string{api.ID, web.ID}) {
			t.Fatalf("read back: %v %v", got.Task.WorkspaceIDs, err)
		}
		d, err = file(&[]string{})
		if err != nil || d.Task.WorkspaceIDs != nil || len(d.Workspaces) != 0 {
			t.Fatalf("named none: %v %v", d.Task.WorkspaceIDs, err)
		}
		_, err = file(&[]string{"nowhere"})
		wantCode(t, err, core.CodeNotFound)

		page, err := f.svc.ListTasks(ctx, lead, core.TaskFilter{Project: ptrStr("WEB")})
		if err != nil {
			t.Fatal(err)
		}
		var named [][]string
		for _, task := range page.Items {
			named = append(named, task.WorkspaceIDs)
		}
		if len(named) != 4 || named[1] == nil || !slices.Equal(named[2], []string{api.ID, web.ID}) {
			t.Fatalf("listed %v", named)
		}

		// The Project's default changes what later Tasks name, not what earlier ones did.
		f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("")})
		if task := f.task(lead, "WEB", "Unplaced again", "Build"); task.WorkspaceIDs != nil {
			t.Fatalf("named %v after the default was cleared", task.WorkspaceIDs)
		}
		f.checkActivity()
	})
}

// Agent settings: admins only, agents only; the first change starts from the defaults and is
// recorded whole, later ones record what changed, env by its names; an unchanged request writes
// nothing; values are bounded.
func TestAgentSettings(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		builder := f.member("builder", nil, nil)
		member, err := f.svc.GetMember(ctx, builder, "builder")
		if err != nil || member.Member.Agent != nil {
			t.Fatalf("a new agent has settings: %+v %v", member.Member.Agent, err)
		}
		_, err = f.svc.SetAgentSettings(ctx, builder, "builder", core.AgentChange{Paused: ptrBool(true)}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.SetAgentSettings(ctx, f.admin, "ada", core.AgentChange{Paused: ptrBool(true)}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		m, err := f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Model: ptrStr("claude-opus-5-5")}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		a := m.Agent
		if a == nil || a.Command != "claude" || !slices.Equal(a.Args, core.DefaultAgentArgs) || a.Model != "claude-opus-5-5" ||
			!a.Unattended || a.Paused || len(a.Env) != 0 || a.ProgressFile != "" {
			t.Fatalf("settings: %+v", a)
		}
		first := f.activity("member.agent_changed")
		if len(first) != 1 || first[0].Payload["command"] != "claude" || first[0].Payload["model"] != "claude-opus-5-5" ||
			first[0].Payload["unattended"] != true {
			t.Fatalf("the first member.agent_changed: %+v", first)
		}

		env := map[string]string{"CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000"}
		m, err = f.svc.SetAgentSettings(ctx, f.admin, m.ID, core.AgentChange{Paused: ptrBool(true), Env: &env,
			Args: &[]string{"-p", "{prompt_file}"}, ProgressFile: ptrStr("{workspace}/.progress")}, core.Idem{})
		if err != nil || !m.Agent.Paused || m.Agent.Model != "claude-opus-5-5" || m.Agent.Env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] != "64000" ||
			!slices.Equal(m.Agent.Args, []string{"-p", "{prompt_file}"}) || m.Agent.ProgressFile != "{workspace}/.progress" {
			t.Fatalf("merged: %+v %v", m.Agent, err)
		}
		changed := f.activity("member.agent_changed")[1].Payload
		b, _ := json.Marshal(changed)
		if string(b) != `{"args":["-p","{prompt_file}"],"env":["CLAUDE_CODE_MAX_OUTPUT_TOKENS"],"paused":true,"progress_file":"{workspace}/.progress"}` {
			t.Fatalf("the second member.agent_changed: %s", b)
		}
		before := f.checkActivity()
		if _, err := f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Paused: ptrBool(true)}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.checkActivity(); n != before {
			t.Fatalf("an unchanged request wrote %d entries", n-before)
		}
		listed, err := f.svc.ListMembers(ctx, builder, nil, ptrStr("agent"))
		if err != nil || listed[0].Agent == nil || !listed[0].Agent.Paused {
			t.Fatalf("listed: %+v %v", listed, err)
		}

		// Cleared: the Runner starts nothing for it; clearing again writes nothing.
		_, err = f.svc.ClearAgentSettings(ctx, builder, "builder", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.ClearAgentSettings(ctx, f.admin, "ada", core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		cleared, err := f.svc.ClearAgentSettings(ctx, f.admin, "builder", core.Idem{})
		if err != nil || cleared.Agent != nil {
			t.Fatalf("cleared: %+v %v", cleared.Agent, err)
		}
		entries := f.activity("member.agent_changed")
		if last := entries[len(entries)-1]; len(last.Payload) != 1 || last.Payload["cleared"] != true || last.SubjectID != m.ID {
			t.Fatalf("the clearing entry: %+v", last)
		}
		before = f.checkActivity()
		if again, err := f.svc.ClearAgentSettings(ctx, f.admin, "builder", core.Idem{}); err != nil || again.Agent != nil {
			t.Fatalf("cleared again: %+v %v", again.Agent, err)
		}
		if n := f.checkActivity(); n != before {
			t.Fatalf("clearing no settings wrote %d entries", n-before)
		}
		// Set again, it starts from the defaults.
		if m, err = f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Paused: ptrBool(true)}, core.Idem{}); err != nil ||
			m.Agent.Model != core.DefaultAgentModel || len(m.Agent.Env) != 0 {
			t.Fatalf("set after clearing: %+v %v", m.Agent, err)
		}

		for _, bad := range []core.AgentChange{
			{Command: ptrStr("")},
			{Command: ptrStr("claude\n--x")},
			{Model: ptrStr(" ")},
			{Env: &map[string]string{"DARKORY_TOKEN": "x"}},
			{Env: &map[string]string{"1BAD": "x"}},
			{Args: &[]string{"a\x00b"}},
		} {
			_, err := f.svc.SetAgentSettings(ctx, f.admin, "builder", bad, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
		f.checkActivity()
	})
}

// InitWith seeds the roster in Init's one write: Project MAIN on the default Workflow with the
// first Member, the Workspace as its default, and the four agents in MAIN with their Skills,
// reporting to the first Member, with agent settings and a token whose Claims lapse after five
// minutes without a Heartbeat.
func TestInitSeedsTheRoster(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		svc := core.New(st, clockAt(epoch), wake.New(), nil)
		ctx := t.Context()
		out, err := svc.InitWith(ctx, "Acme", "ada", core.InitOptions{Roster: true,
			Workspace: &core.NewWorkspace{Name: "darkory", Path: "/src/darkory", DefaultBranch: "trunk"}})
		if err != nil {
			t.Fatal(err)
		}
		if out.Project == nil || out.Project.Key != "MAIN" || out.Project.Name != "Main" || out.Workspace == nil ||
			out.Workspace.Name != "darkory" || out.Workspace.DefaultBranch != "trunk" || out.Project.DefaultWorkspaceID == nil ||
			*out.Project.DefaultWorkspaceID != out.Workspace.ID || out.Project.AutoComplete || out.Project.Acceptance {
			t.Fatalf("the Project %+v and Workspace %+v", out.Project, out.Workspace)
		}
		a := auth.New(st, clockAt(epoch))
		ada, err := a.Authenticate(ctx, auth.Credentials{Bearer: out.Token.Secret, Session: "ada-1"})
		if err != nil {
			t.Fatal(err)
		}
		project, err := svc.GetProject(ctx, ada, "MAIN")
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, m := range project.Members {
			names = append(names, m.Name)
		}
		if !slices.Equal(names, []string{"ada", "builder", "planner", "retro", "reviewer"}) {
			t.Fatalf("MAIN holds %v", names)
		}
		want := map[string]struct {
			skills []string
			model  string
		}{
			"planner":  {[]string{"breakdown"}, "claude-opus-5-5"},
			"builder":  {[]string{"engineer"}, "claude-sonnet-5-5"},
			"reviewer": {[]string{"review", "skill-review"}, "claude-opus-5-5"},
			"retro":    {[]string{"retro"}, "claude-opus-5-5"},
		}
		if len(out.Agents) != 4 {
			t.Fatalf("%d agents", len(out.Agents))
		}
		for _, sa := range out.Agents {
			w := want[sa.Member.Name]
			d, err := svc.GetMember(ctx, ada, sa.Member.ID)
			if err != nil {
				t.Fatal(err)
			}
			var skills []string
			for _, s := range d.Skills {
				skills = append(skills, s.Name)
			}
			if d.Member.Kind != "agent" || !slices.Equal(skills, w.skills) || d.Member.ManagerID == nil || *d.Member.ManagerID != out.Member.ID ||
				d.Member.Agent == nil || d.Member.Agent.Model != w.model || d.Member.Agent.Command != "claude" || !d.Member.Agent.Unattended {
				t.Fatalf("%s: %+v, Skills %v", sa.Member.Name, d.Member, skills)
			}
			if sa.Token.Secret == "" || sa.Token.Token.Name != "runner" || sa.Token.Token.DefaultTimeout != 5*time.Minute {
				t.Fatalf("%s's token: %+v", sa.Member.Name, sa.Token.Token)
			}
			if _, err := a.Authenticate(ctx, auth.Credentials{Bearer: sa.Token.Secret, Session: sa.Member.Name + "-1"}); err != nil {
				t.Fatalf("%s's token: %v", sa.Member.Name, err)
			}
		}
		skills, err := svc.ListSkills(ctx, ada, nil)
		if err != nil {
			t.Fatal(err)
		}
		var skillNames []string
		for _, s := range skills {
			skillNames = append(skillNames, s.Name)
		}
		if !slices.Equal(skillNames, []string{"acceptance", "breakdown", "engineer", "retro", "review", "skill-review"}) {
			t.Fatalf("Skills %v", skillNames)
		}
		// MAIN is on the default Workflow; filed in it with Break down, the Breakdown is at Plan
		// and names the Workspace.
		w, err := svc.GetWorkflow(ctx, ada, "MAIN")
		if err != nil || workflowText(skills, w.Workflow) != defaultWorkflowText {
			t.Fatalf("MAIN's Workflow %s (%v)", workflowText(skills, w.Workflow), err)
		}
		d, err := svc.FileTask(ctx, ada, core.NewTask{Project: ptrStr("MAIN"), Title: "Cart", Breakdown: true}, core.Idem{})
		if err != nil || !slices.Equal(d.Subtasks[0].WorkspaceIDs, []string{out.Workspace.ID}) {
			t.Fatalf("the Breakdown names %v (%v)", d.Subtasks[0].WorkspaceIDs, err)
		}
	})
}

func clockAt(t time.Time) *clock.Fake { return clock.NewFake(t) }

// A Task nobody holds, open or ended, takes Notes from its Owner, wherever they are, and from any
// Member of its Project, under no Skill; anyone else is forbidden. A held Task takes them from its
// holder alone, the Owner and the Project included. A retry under its key adds nothing more.
func TestNotesOnATaskNobodyHolds(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("OPS")
		f.skill("build")
		f.chain("WEB", [2]string{"Build", "build"})
		owner := f.member("owner", []string{"OPS"}, nil)
		mate := f.member("mate", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		reviewer := f.member("reviewer", []string{"OPS"}, nil)
		d, err := f.svc.FileTask(ctx, mate, core.NewTask{Project: ptrStr("WEB"), Title: "Cart", Owner: ptrStr("owner"), Step: ptrStr("Build")}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		task := f.subtask(mate, d.Task.ID, "Pay", "Build")

		for _, c := range []*auth.Caller{owner, mate} {
			n, err := f.svc.AddNote(ctx, c, task.Key, "context for whoever takes it", core.Idem{})
			if err != nil || n.SkillID != nil || n.AuthorID != c.MemberID || n.TaskID != task.ID {
				t.Fatalf("a Note on an open Task nobody holds: %+v %v", n, err)
			}
		}
		_, err = f.svc.AddNote(ctx, reviewer, task.Key, "not mine", core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		// Held: the holder alone, under their Claim's Skill.
		f.claim(builder, task.Key, noTimeout)
		for _, c := range []*auth.Caller{owner, mate} {
			_, err := f.svc.AddNote(ctx, c, task.Key, "while held", core.Idem{})
			wantCode(t, err, core.CodeNotHolder)
		}
		if n, err := f.svc.AddNote(ctx, builder, task.Key, "building", core.Idem{}); err != nil || n.SkillID == nil {
			t.Fatalf("the holder's Note: %+v %v", n, err)
		}
		if _, err := f.svc.Complete(ctx, builder, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}

		// Ended: someone from OPS still may not; the Project and the Owner still write.
		_, err = f.svc.AddNote(ctx, reviewer, task.Key, "one more thing", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		key := jsonIdem("merged-"+task.ID, "h")
		n, err := f.svc.AddNote(ctx, mate, task.Key, "Merged web-2-pay into web-1 at 1a2b3c", key)
		if err != nil {
			t.Fatal(err)
		}
		again, err := f.svc.AddNote(ctx, mate, task.Key, "Merged web-2-pay into web-1 at 1a2b3c", key)
		var replay *core.Replay
		if err == nil || !errors.As(err, &replay) {
			t.Fatalf("the retry: %+v %v", again, err)
		}
		got, err := f.svc.GetTask(ctx, mate, task.Key)
		if err != nil || len(got.Notes) != 4 || got.Notes[3].ID != n.ID || got.Notes[3].SkillID != nil {
			t.Fatalf("Notes %+v %v", got.Notes, err)
		}
		if notes := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'task.note_added' AND subject_id = $1`, task.ID); notes != 4 {
			t.Fatalf("%d task.note_added entries", notes)
		}
		f.checkActivity()
	})
}
