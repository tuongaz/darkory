package core_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A Task's pull request is recorded by its Owner or any Member of its Project, whoever holds it,
// open or ended, when it names a Workspace in pull_request mode, its own or its Project's
// default. The same values again record nothing; open over merged is refused; the first write of
// open and a write of merged are recorded.
func TestSetPullRequest(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		f.chain("WEB", [2]string{"Build", core.SkillEngineer})
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		stranger := f.member("stranger", []string{"API"}, nil)
		prs, err := f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "web", Path: "/src/web", Mode: "pull_request"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.workspace("docs") // plain

		task := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Ship it", Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		open7 := core.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: core.PullRequestOpen}
		merged7 := open7
		merged7.State = core.PullRequestMerged

		// Nobody outside the Project but its Owner.
		if _, err := f.svc.SetPullRequest(ctx, stranger, task.Key, open7, core.Idem{}); codeOf(err) != core.CodeForbidden {
			t.Fatalf("a stranger records a pull request: %v", err)
		}
		// Bad values.
		for _, bad := range []core.PullRequest{
			{Number: 0, URL: open7.URL, State: "open"},
			{Number: 7, URL: open7.URL, State: "closed"},
			{Number: 7, URL: "javascript:alert(1)", State: "open"},
			{Number: 7, URL: "", State: "open"},
			{Number: 7, URL: "http://github.com/acme/web/pull/7", State: "open"},
			{Number: 7, URL: "https://gitlab.com/acme/web/pull/7", State: "open"},
			{Number: 7, URL: "https://github.com.evil.example/acme/web/pull/7", State: "open"},
			{Number: 7, URL: "https://user@github.com/acme/web/pull/7", State: "open"},
			{Number: -1, URL: "https://github.com/acme/web/pull/7", State: "open"},
			// The address names the number, and nothing else.
			{Number: 7, URL: "https://github.com/acme/web/pull/99", State: "open"},
			{Number: 7, URL: "https://github.com/acme/web/pull/7?x=1", State: "open"},
			{Number: 7, URL: "https://github.com/acme/web/pull/7#top", State: "open"},
			{Number: 7, URL: "https://github.com/acme/web/pull/7/", State: "open"},
			{Number: 7, URL: "https://github.com/acme/web/issues/7", State: "open"},
			{Number: 7, URL: "https://github.com/acme/web/pull/7/files", State: "open"},
			{Number: 7, URL: "https://github.com/acme/pull/7", State: "open"},
			// A browser would resolve a . or .. segment to another page.
			{Number: 7, URL: "https://github.com/../r/pull/7", State: "open"},
			{Number: 7, URL: "https://github.com/o/../pull/7", State: "open"},
		} {
			if _, err := f.svc.SetPullRequest(ctx, lead, task.Key, bad, core.Idem{}); codeOf(err) != core.CodeInvalid {
				t.Errorf("%+v: %v, want invalid", bad, err)
			}
		}

		// A Member of the Project, while another holds the Task.
		f.claim(builder, task.Key, noTimeout)
		got, err := f.svc.SetPullRequest(ctx, lead, task.Key, open7, core.Idem{})
		if err != nil || got.PullRequest == nil || *got.PullRequest != open7 {
			t.Fatalf("a Member records the pull request: %+v, %v", got.PullRequest, err)
		}
		if pr := f.get(task.Key).Task.PullRequest; pr == nil || *pr != open7 {
			t.Fatalf("the Task reads %+v", pr)
		}
		// The same again records nothing.
		before := f.checkActivity()
		if _, err := f.svc.SetPullRequest(ctx, builder, task.Key, open7, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.checkActivity(); n != before {
			t.Fatalf("the same pull request again recorded %d entries", n-before)
		}

		// The Task ends; its Owner records the merge.
		if _, err := f.svc.Complete(ctx, builder, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		got, err = f.svc.SetPullRequest(ctx, lead, task.Key, merged7, core.Idem{})
		if err != nil || got.PullRequest.State != core.PullRequestMerged {
			t.Fatalf("merged on an ended Task: %+v, %v", got.PullRequest, err)
		}
		_, err = f.svc.SetPullRequest(ctx, lead, task.Key, open7, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if err.Error() == "" || !strings.Contains(err.Error(), "#7 is already merged") {
			t.Errorf("open over merged says %q", err)
		}

		opened, mergedEntries := f.activity("task.pull_request_opened"), f.activity("task.pull_request_merged")
		if len(opened) != 1 || len(mergedEntries) != 1 {
			t.Fatalf("recorded %d opened and %d merged, want 1 each", len(opened), len(mergedEntries))
		}
		for _, a := range append(opened, mergedEntries...) {
			if a.SubjectID != task.ID || fmt.Sprint(a.Payload["number"]) != "7" || a.Payload["url"] != open7.URL || a.ActorID == nil || *a.ActorID != lead.MemberID {
				t.Errorf("entry %s: %+v", a.Kind, a)
			}
		}

		// The Owner from outside the Project.
		outsiderOwned := f.fileTask(stranger, core.NewTask{Project: ptrStr("API"), Title: "x", Step: ptrStr("Build"), Workspaces: &[]string{prs.ID}}).Task
		if _, err := f.svc.PassOwnership(ctx, stranger, outsiderOwned.Key, "lead", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.SetPullRequest(ctx, lead, outsiderOwned.Key, open7, core.Idem{}); err != nil {
			t.Fatalf("the Owner, not in the Project: %v", err)
		}

		// No Workspace in pull_request mode: a plain one, or none at all.
		plain := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Docs", Step: ptrStr("Build"), Workspaces: &[]string{"docs"}}).Task
		none := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "None", Step: ptrStr("Build"), Workspaces: &[]string{}}).Task
		for _, k := range []string{plain.Key, none.Key} {
			if _, err := f.svc.SetPullRequest(ctx, lead, k, open7, core.Idem{}); codeOf(err) != core.CodeInvalid {
				t.Errorf("%s with no pull_request Workspace: %v", k, err)
			}
		}
		// A Subtask works in its Parent's Workspaces.
		parent := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "Parent", Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		sub := f.subtask(lead, parent.Key, "Sub", "Build")
		if _, err := f.svc.SetPullRequest(ctx, lead, sub.Key, open7, core.Idem{}); err != nil {
			t.Errorf("a Subtask in its Parent's pull_request Workspace: %v", err)
		}
		// Naming none, the Project's default counts.
		f.projectDefaults("WEB", core.ProjectChange{DefaultWorkspace: ptrStr("web")})
		if _, err := f.svc.SetPullRequest(ctx, lead, none.Key, open7, core.Idem{}); err != nil {
			t.Errorf("naming none, through the Project's default: %v", err)
		}
		if _, err := f.svc.SetPullRequest(ctx, lead, plain.Key, open7, core.Idem{}); codeOf(err) != core.CodeInvalid {
			t.Errorf("naming a plain Workspace, the default does not count: %v", err)
		}
		f.checkActivity()
	})
}

// pull_request filters by the pull request recorded: open, merged, or none.
func TestPullRequestFilter(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		if _, err := f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "web", Path: "/src/web", Mode: "pull_request"}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		lead := f.member("lead", []string{"WEB"}, nil)
		in := func(title string) core.Task {
			return f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: title, Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		}
		open, merged, bare := in("open"), in("merged"), in("bare")
		for task, pr := range map[string]core.PullRequest{
			open.Key:   {Number: 1, URL: "https://github.com/a/b/pull/1", State: core.PullRequestOpen},
			merged.Key: {Number: 2, URL: "https://github.com/a/b/pull/2", State: core.PullRequestMerged},
		} {
			if _, err := f.svc.SetPullRequest(ctx, lead, task, pr, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		for filter, want := range map[string]string{
			"pull_request:is:open":        open.Key,
			"pull_request:is:merged":      merged.Key,
			"pull_request:is:none":        bare.Key,
			"pull_request:not:none":       merged.Key + " " + open.Key,
			"pull_request:not:open":       bare.Key + " " + merged.Key,
			"pull_request:in:open,merged": merged.Key + " " + open.Key,
		} {
			page, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: []string{filter}})
			if err != nil {
				t.Fatalf("%s: %v", filter, err)
			}
			var keys []string
			for _, k := range []string{bare.Key, merged.Key, open.Key} {
				for _, task := range page.Items {
					if task.Key == k {
						keys = append(keys, k)
					}
				}
			}
			if got := fmt.Sprint(keys); got != "["+want+"]" {
				t.Errorf("%s: %s, want [%s]", filter, got, want)
			}
		}
		if _, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Filters: []string{"pull_request:is:closed"}}); codeOf(err) != core.CodeInvalid {
			t.Errorf("an unknown state: %v", err)
		}
	})
}

// A company Skill belongs to a Project, or to the whole Organisation; a Step of one Project
// cannot carry another's, and a copy of a Project's Workflow carries the generic Skill instead.
func TestCompanySkillProject(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		web := f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)

		create := func(ns core.NewSkill) (core.SkillDetail, error) {
			return f.svc.CreateSkill(ctx, f.admin, ns, core.Idem{})
		}
		webQA, err := create(core.NewSkill{Name: "web-qa", Kind: "company", BaseSkill: ptrStr("qa"), Project: ptrStr("WEB"), Body: "WEB's QA"})
		if err != nil || webQA.Skill.ProjectID == nil || *webQA.Skill.ProjectID != web {
			t.Fatalf("a company Skill of WEB: %+v, %v", webQA.Skill, err)
		}
		orgQA, err := create(core.NewSkill{Name: "org-qa", Kind: "company", BaseSkill: ptrStr("qa"), Body: "Acme's QA"})
		if err != nil || orgQA.Skill.ProjectID != nil {
			t.Fatalf("a company Skill of the Organisation: %+v, %v", orgQA.Skill, err)
		}
		if _, err := create(core.NewSkill{Name: "g", Kind: "generic", Project: ptrStr("WEB"), Body: "x"}); codeOf(err) != core.CodeInvalid {
			t.Errorf("a generic Skill naming a Project: %v", err)
		}
		if _, err := create(core.NewSkill{Name: "h", Kind: "company", BaseSkill: ptrStr("qa"), Project: ptrStr("NOPE"), Body: "x"}); codeOf(err) != core.CodeNotFound {
			t.Errorf("no such Project: %v", err)
		}
		if _, err := create(core.NewSkill{Name: "plain", Kind: "generic", Project: ptrStr(""), Body: "x"}); err != nil {
			t.Errorf("a generic Skill whose Project is empty: %v", err)
		}
		created := map[string]any{}
		for _, a := range f.activity("skill.created") {
			if p, ok := a.Payload["project_id"]; ok {
				created[fmt.Sprint(a.Payload["name"])] = p
			} else {
				created[fmt.Sprint(a.Payload["name"])] = "absent"
			}
		}
		if created["web-qa"] != web || created["org-qa"] != nil || created["plain"] != nil {
			t.Errorf("skill.created project_id %v", created)
		}

		// A Step of WEB may carry WEB's and the Organisation's; API's Step may not carry WEB's.
		f.chain("WEB", [2]string{"Verify", "web-qa"}, [2]string{"Check", "org-qa"})
		_, err = f.svc.SetWorkflow(ctx, f.admin, "API", inWork(core.WorkflowsInput{Steps: []core.StepInput{{Name: "Verify", Position: 1, Skill: ptrStr("web-qa")}},
			Connectors: []core.ConnectorInput{{From: "Verify", Name: "pass"}}}), core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		if !strings.Contains(err.Error(), "web-qa is Project WEB's company Skill") {
			t.Errorf("refused with %q", err)
		}

		// A copy of WEB carries qa where WEB carries web-qa.
		cp, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "CPY", Name: "Copy", Workflow: core.WorkflowCopy, CopyFrom: ptrStr("WEB")}, core.Idem{})
		if err != nil {
			t.Fatalf("copying WEB: %v", err)
		}
		w, err := f.svc.GetWorkflow(ctx, f.admin, cp.Project.ID)
		if err != nil {
			t.Fatal(err)
		}
		skills := map[string]string{}
		for _, s := range w.Steps {
			if s.SkillID != nil {
				skills[s.Name] = *s.SkillID
			}
		}
		if skills["Verify"] != f.skillID("qa") || skills["Check"] != orgQA.Skill.ID {
			t.Errorf("the copy's Skills %v", skills)
		}

		// UpdateSkill: admins only, company Skills only, a Project whose Steps alone carry it.
		if _, err := f.svc.UpdateSkill(ctx, lead, "web-qa", "", core.Idem{}); codeOf(err) != core.CodeForbidden {
			t.Errorf("a Member: %v", err)
		}
		if _, err := f.svc.UpdateSkill(ctx, f.admin, "qa", "WEB", core.Idem{}); codeOf(err) != core.CodeInvalid {
			t.Errorf("a generic Skill: %v", err)
		}
		if _, err := f.svc.UpdateSkill(ctx, f.admin, "web-qa", "API", core.Idem{}); codeOf(err) != core.CodeInvalid {
			t.Errorf("to API while WEB's Step carries it: %v", err)
		}
		if _, err := f.svc.UpdateSkill(ctx, f.admin, "org-qa", "API", core.Idem{}); codeOf(err) != core.CodeInvalid {
			t.Errorf("org-qa to API while WEB's and CPY's Steps carry it: %v", err)
		}
		d, err := f.svc.UpdateSkill(ctx, f.admin, "web-qa", "", core.Idem{})
		if err != nil || d.Skill.ProjectID != nil {
			t.Fatalf("to the Organisation: %+v, %v", d.Skill, err)
		}
		before := f.checkActivity()
		if _, err := f.svc.UpdateSkill(ctx, f.admin, "web-qa", "", core.Idem{}); err != nil || f.checkActivity() != before {
			t.Errorf("the same again: %v", err)
		}
		d, err = f.svc.UpdateSkill(ctx, f.admin, d.Skill.ID, "WEB", core.Idem{})
		if err != nil || d.Skill.ProjectID == nil {
			t.Fatalf("back to WEB: %+v, %v", d.Skill, err)
		}
		changed := f.activity("skill.changed")
		if len(changed) != 2 || changed[0].Payload["project_id"] != nil || changed[1].Payload["project_id"] == nil ||
			changed[0].SubjectID != webQA.Skill.ID {
			t.Errorf("skill.changed %+v", changed)
		}
		if listed, err := f.svc.ListSkills(ctx, lead, nil); err == nil {
			for _, s := range listed {
				if s.Name == "web-qa" && (s.ProjectID == nil || *s.ProjectID != *d.Skill.ProjectID) {
					t.Errorf("listed %+v", s)
				}
			}
		} else {
			t.Fatal(err)
		}
		f.checkActivity()
	})
}

// Evidence is of kind evidence unless attached as a Shift's log; the kind is in its Activity.
func TestEvidenceKind(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		lead := f.member("lead", []string{"WEB"}, nil)
		task := f.task(lead, "WEB", "x", "Build")
		attach := func(id, kind string) (core.Evidence, error) {
			return f.svc.AttachEvidence(ctx, lead, core.EvidenceTarget{Task: task.Key},
				core.NewEvidence{ID: id, Kind: kind, BlobKey: id, Filename: id + ".txt", ContentType: "text/plain", Size: 1, SHA256: "x"}, core.Idem{})
		}
		ids := map[string]string{}
		for _, c := range []struct{ name, kind, want string }{{"plain", "", "evidence"}, {"report", "evidence", "evidence"}, {"log", "log", "log"}} {
			id := fmt.Sprintf("00000000-0000-4000-8000-00000000000%d", len(ids)+1)
			e, err := attach(id, c.kind)
			if err != nil || e.Kind != c.want {
				t.Fatalf("%s: %+v, %v", c.name, e, err)
			}
			ids[c.name] = e.ID
		}
		if _, err := attach("00000000-0000-4000-8000-000000000009", "screenshot"); codeOf(err) != core.CodeInvalid {
			t.Errorf("an unknown kind: %v", err)
		}
		kinds := map[string]string{}
		for _, e := range f.get(task.Key).Evidence {
			kinds[e.ID] = e.Kind
		}
		if kinds[ids["plain"]] != "evidence" || kinds[ids["log"]] != "log" {
			t.Errorf("the Task's Evidence %v", kinds)
		}
		var got []string
		for _, a := range f.activity("task.evidence_attached") {
			got = append(got, fmt.Sprint(a.Payload["kind"]))
		}
		if fmt.Sprint(got) != "[evidence evidence log]" {
			t.Errorf("payload kinds %v", got)
		}
	})
}

// An agent runs one Shift at a time unless its settings say more, at most 8.
func TestAgentShifts(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.member("builder", nil, nil)
		m, err := f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Model: ptrStr("claude-opus-5-5")}, core.Idem{})
		if err != nil || m.Agent.Shifts != 1 {
			t.Fatalf("the default: %+v, %v", m.Agent, err)
		}
		for _, n := range []int{0, -1, 9} {
			if _, err := f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Shifts: &n}, core.Idem{}); codeOf(err) != core.CodeInvalid {
				t.Errorf("shifts %d: %v", n, err)
			}
		}
		three := 3
		m, err = f.svc.SetAgentSettings(ctx, f.admin, "builder", core.AgentChange{Shifts: &three}, core.Idem{})
		if err != nil || m.Agent.Shifts != 3 {
			t.Fatalf("three: %+v, %v", m.Agent, err)
		}
		changed := f.activity("member.agent_changed")
		if last := changed[len(changed)-1]; fmt.Sprint(last.Payload) != "map[shifts:3]" {
			t.Errorf("recorded %v", last.Payload)
		}
		// Settings stored before Shifts existed read as 1.
		f.exec(`UPDATE members SET agent = '{"command":"claude","args":[],"model":"m","env":{},"unattended":true,"paused":false}' WHERE id = $1`, m.ID)
		got, err := f.svc.GetMember(ctx, f.admin, "builder")
		if err != nil || got.Member.Agent.Shifts != 1 {
			t.Fatalf("stored without shifts: %+v, %v", got.Member.Agent, err)
		}
	})
}

// A pull request's address is on github.com, or on the host GH_HOST names when the server's
// environment sets it.
func TestPullRequestOnGHHost(t *testing.T) {
	t.Setenv("GH_HOST", "git.acme.example")
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		if _, err := f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "web", Path: "/src/web", Mode: "pull_request"}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		lead := f.member("lead", []string{"WEB"}, nil)
		task := f.fileTask(lead, core.NewTask{Project: ptrStr("WEB"), Title: "x", Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		on := core.PullRequest{Number: 3, URL: "https://git.acme.example/acme/web/pull/3", State: core.PullRequestOpen}
		got, err := f.svc.SetPullRequest(ctx, lead, task.Key, on, core.Idem{})
		if err != nil || got.PullRequest.URL != on.URL {
			t.Fatalf("on GH_HOST: %+v, %v", got.PullRequest, err)
		}
		off := on
		off.URL = "https://github.com/acme/web/pull/3"
		_, err = f.svc.SetPullRequest(ctx, lead, task.Key, off, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		if !strings.Contains(err.Error(), "not on GitHub") {
			t.Errorf("refused with %q", err)
		}
	})
}

// Merging is a human's act: a human Owner or an admin may have the open pull request merged, an
// agent never, its Owner included; the merge is recorded as the human who asked, with a Note.
func TestMergePullRequest(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		if _, err := f.svc.CreateWorkspace(ctx, f.admin, core.NewWorkspace{Name: "web", Path: "/src/web", Mode: "pull_request"}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		agent := f.member("builder", []string{"WEB"}, nil)
		hm, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: "cy", Kind: "human"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddProjectMember(ctx, f.admin, "WEB", hm.ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		tok, err := f.svc.IssueToken(ctx, f.admin, hm.ID, "main", 0, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.secrets[hm.ID] = tok.Secret
		cy := f.session(hm.ID, "cy-1")

		byAgent := f.fileTask(agent, core.NewTask{Project: ptrStr("WEB"), Title: "agent's", Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		byHuman := f.fileTask(cy, core.NewTask{Project: ptrStr("WEB"), Title: "cy's", Step: ptrStr("Build"), Workspaces: &[]string{"web"}}).Task
		pr := core.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: core.PullRequestOpen}

		// No pull request yet.
		_, _, err = f.svc.MayMergePullRequest(ctx, cy, byHuman.Key)
		wantCode(t, err, core.CodeNotFound)
		for _, k := range []string{byAgent.Key, byHuman.Key} {
			if _, err := f.svc.SetPullRequest(ctx, agent, k, pr, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		// The agent is its Owner, and still refused.
		_, _, err = f.svc.MayMergePullRequest(ctx, agent, byAgent.Key)
		wantCode(t, err, core.CodeForbidden)
		if !strings.Contains(err.Error(), "human's act") {
			t.Errorf("refused with %q", err)
		}
		_, err = f.svc.RecordMerge(ctx, agent, byAgent.ID, 7, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		// A human neither its Owner nor an admin.
		_, _, err = f.svc.MayMergePullRequest(ctx, cy, byAgent.Key)
		wantCode(t, err, core.CodeForbidden)
		// The human Owner, and an admin.
		if _, got, err := f.svc.MayMergePullRequest(ctx, cy, byHuman.Key); err != nil || got != pr {
			t.Fatalf("the human Owner: %+v, %v", got, err)
		}
		merged, err := f.svc.RecordMerge(ctx, f.admin, byAgent.ID, 7, core.Idem{})
		if err != nil || merged.PullRequest.State != core.PullRequestMerged || merged.PullRequest.URL != pr.URL {
			t.Fatalf("an admin's merge: %+v, %v", merged.PullRequest, err)
		}
		entries := f.activity("task.pull_request_merged")
		if len(entries) != 1 || entries[0].ActorID == nil || *entries[0].ActorID != f.admin.MemberID || entries[0].SubjectID != byAgent.ID {
			t.Fatalf("task.pull_request_merged %+v", entries)
		}
		notes := f.get(byAgent.Key).Notes
		if len(notes) != 1 || notes[0].Body != "web: #7 merged" || notes[0].AuthorID != f.admin.MemberID {
			t.Fatalf("Notes %+v", notes)
		}
		// Merged, there is nothing open to merge.
		_, _, err = f.svc.MayMergePullRequest(ctx, f.admin, byAgent.Key)
		wantCode(t, err, core.CodeNotFound)
		// A second recorder of the same merge is not an error: its entry credits who asked, with no
		// second Note.
		again, err := f.svc.RecordMerge(ctx, f.admin, byAgent.ID, 7, core.Idem{})
		if err != nil || again.PullRequest.State != core.PullRequestMerged {
			t.Fatalf("recording #7's merge again: %+v, %v", again.PullRequest, err)
		}
		if n := len(f.activity("task.pull_request_merged")); n != 2 {
			t.Errorf("%d task.pull_request_merged entries, want 2", n)
		}
		if n := len(f.get(byAgent.Key).Notes); n != 1 {
			t.Errorf("%d Notes, want 1", n)
		}
		// The Task's pull request is another now: the merge of #7 is refused.
		pr8 := core.PullRequest{Number: 8, URL: "https://github.com/acme/web/pull/8", State: core.PullRequestOpen}
		if _, err := f.svc.SetPullRequest(ctx, cy, byHuman.Key, pr8, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.RecordMerge(ctx, cy, byHuman.ID, 7, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if !strings.Contains(err.Error(), "#8 is the Task's pull request now, not #7") {
			t.Errorf("refused with %q", err)
		}
		if pr := f.get(byHuman.Key).Task.PullRequest; pr.Number != 8 || pr.State != core.PullRequestOpen {
			t.Errorf("after the refusal %+v", pr)
		}
		// The human Owner records the merge of #8.
		if got, err := f.svc.RecordMerge(ctx, cy, byHuman.ID, 8, core.Idem{}); err != nil || got.PullRequest.State != core.PullRequestMerged {
			t.Fatalf("the human Owner's merge: %+v, %v", got.PullRequest, err)
		}
		f.checkActivity()
	})
}

// GH_HOST may be written with a scheme, a port or a trailing slash: the address is compared with
// the host part it carries, port included when GH_HOST has one.
func TestGitHubHostForms(t *testing.T) {
	for _, c := range []struct {
		env, addr string
		ok        bool
	}{
		{"", "https://github.com/a/b/pull/7", true},
		{"", "https://GitHub.com/a/b/pull/7", true},
		{"https://ghe.example.com", "https://ghe.example.com/a/b/pull/7", true},
		{"https://ghe.example.com/", "https://ghe.example.com/a/b/pull/7", true},
		{"ghe.example.com:8443", "https://ghe.example.com:8443/a/b/pull/7", true},
		{"ghe.example.com:8443", "https://ghe.example.com/a/b/pull/7", false},
		{"https://ghe.example.com:8443", "https://ghe.example.com:8443/a/b/pull/7", true},
		{"ghe.example.com", "https://github.com/a/b/pull/7", false},
		{"ghe.example.com", "https://ghe.example.com:8443/a/b/pull/7", false},
	} {
		t.Run(c.env+" "+c.addr, func(t *testing.T) {
			t.Setenv("GH_HOST", c.env)
			err := core.PullRequest{Number: 7, URL: c.addr, State: core.PullRequestOpen}.Validate()
			if (err == nil) != c.ok {
				t.Errorf("GH_HOST %q, %s: %v", c.env, c.addr, err)
			}
		})
	}
	t.Setenv("GH_HOST", "")
	err := core.PullRequest{Number: 7, URL: "https://github.com/a/b/pull/99", State: core.PullRequestOpen}.Validate()
	if codeOf(err) != core.CodeInvalid || !strings.Contains(err.Error(), "not pull request #7's") {
		t.Errorf("another number's address: %v", err)
	}
}

// An owner or repository segment of . or .. is refused: a browser would resolve the address to
// another page than the one written. An owner is letters, digits and hyphens, starting with a
// letter or digit; a repository may carry dots. A port on github.com is never GitHub's own address.
func TestPullRequestAddressSegments(t *testing.T) {
	t.Setenv("GH_HOST", "")
	for _, c := range []struct {
		addr string
		ok   bool
	}{
		{"https://github.com/acme/web/pull/7", true},
		{"https://github.com/acme/a.b/pull/7", true},
		{"https://github.com/acme-co/web_2-x/pull/7", true},
		{"https://github.com/../web/pull/7", false},
		{"https://github.com/./web/pull/7", false},
		{"https://github.com/acme/../pull/7", false},
		{"https://github.com/acme/./pull/7", false},
		{"https://github.com/acme/%2e%2e/pull/7", false},
		{"https://github.com/ac.me/web/pull/7", false},
		{"https://github.com/ac_me/web/pull/7", false},
		{"https://github.com/-acme/web/pull/7", false},
		{"https://github.com:443/acme/web/pull/7", false},
	} {
		t.Run(c.addr, func(t *testing.T) {
			err := core.PullRequest{Number: 7, URL: c.addr, State: core.PullRequestOpen}.Validate()
			if (err == nil) != c.ok {
				t.Errorf("%s: %v", c.addr, err)
			}
		})
	}
}
