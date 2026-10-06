package core_test

import (
	"encoding/json"
	"strings"
	"errors"
	"slices"
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

func (f *fixture) teamDefaults(team string, ch core.TeamChange) core.Team {
	f.t.Helper()
	tm, err := f.svc.UpdateTeam(f.t.Context(), f.admin, team, ch, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return tm
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
// cannot be removed, and removing a Team's default leaves the Team without one.
func TestWorkspaces(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
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

		// A Task names web; web is WEB's default, api is no one's.
		f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("web")})
		feature := f.feature(lead, "WEB", "Cart")
		if got := feature.Tasks[0].WorkspaceIDs; !slices.Equal(got, []string{w.ID}) {
			t.Fatalf("the Break down names %v, want the Team's default", got)
		}
		err = f.svc.RemoveWorkspace(ctx, f.admin, "web", core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if !strings.HasPrefix(err.Error(), "conflict: 1 Task names Workspace web;") {
			t.Fatalf("the refusal reads %q", err)
		}
		err = f.svc.RemoveWorkspace(ctx, lead, "api", core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("api")})
		if err := f.svc.RemoveWorkspace(ctx, f.admin, "api", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		tm, err := f.svc.GetTeam(ctx, lead, "WEB")
		if err != nil || tm.Team.DefaultWorkspaceID != nil {
			t.Fatalf("WEB after its default was removed: %+v %v", tm.Team, err)
		}
		if removed := f.activity("workspace.removed"); len(removed) != 1 || removed[0].SubjectID != api.ID {
			t.Fatalf("workspace.removed: %+v", removed)
		}
		teamChanged := f.activity("team.changed")
		if last := teamChanged[len(teamChanged)-1]; last.Payload["default_workspace_id"] != nil || len(last.Payload) != 1 {
			t.Fatalf("the last team.changed: %+v", last)
		}
		f.checkActivity()
	})
}

// A Team's default Workspace and Ship-when-done default are set and cleared by admins; a Task
// names the Workspaces it is filed with, in order and each once, an empty list naming none, or
// else its Team's default, or none when the Team has none.
func TestTaskWorkspaces(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		lead := f.member("lead", []string{"WEB"}, []string{"build"})
		web, api := f.workspace("web"), f.workspace("api")
		feature := f.feature(lead, "WEB", "Cart").Feature.ID

		// No default: a Task names none.
		if task := f.task(lead, feature, "Unplaced", "build"); task.WorkspaceIDs != nil {
			t.Fatalf("named %v with no default", task.WorkspaceIDs)
		}
		_, err := f.svc.UpdateTeam(ctx, lead, "WEB", core.TeamChange{DefaultWorkspace: ptrStr("web")}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.UpdateTeam(ctx, f.admin, "WEB", core.TeamChange{DefaultWorkspace: ptrStr("nowhere")}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		tm := f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("WEB"), ShipWhenDone: ptrBool(true)})
		if tm.DefaultWorkspaceID == nil || *tm.DefaultWorkspaceID != web.ID || !tm.ShipWhenDone {
			t.Fatalf("WEB: %+v", tm)
		}
		if changed := f.activity("team.changed"); len(changed) != 1 || changed[0].Payload["default_workspace_id"] != web.ID ||
			changed[0].Payload["ship_when_done"] != true {
			t.Fatalf("team.changed: %+v", changed)
		}

		file := func(refs *[]string) (core.TaskDetail, error) {
			skill := "build"
			return f.svc.FileTask(ctx, lead, core.NewTask{Feature: &feature, Title: "T", Skill: &skill, Workspaces: refs}, core.Idem{})
		}
		d, err := file(nil)
		if err != nil || !slices.Equal(d.Task.WorkspaceIDs, []string{web.ID}) || len(d.Workspaces) != 1 || d.Workspaces[0].Name != "web" {
			t.Fatalf("by default: %v %+v %v", d.Task.WorkspaceIDs, d.Workspaces, err)
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

		page, err := f.svc.ListTasks(ctx, lead, core.TaskFilter{Feature: &feature})
		if err != nil {
			t.Fatal(err)
		}
		var named [][]string
		for _, task := range page.Items {
			named = append(named, task.WorkspaceIDs)
		}
		if len(named) != 5 || named[2] == nil || !slices.Equal(named[3], []string{api.ID, web.ID}) {
			t.Fatalf("listed %v", named)
		}

		// The Team's default changes what later Tasks name, not what earlier ones did.
		f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("")})
		if task := f.task(lead, feature, "Unplaced again", "build"); task.WorkspaceIDs != nil {
			t.Fatalf("named %v after the default was cleared", task.WorkspaceIDs)
		}
		f.checkActivity()
	})
}

// A quick Feature is filed with its one work Task — the Feature's title and description, the
// Skill named, the Team's default Workspace — and no Break down. It always ships when done, the
// Task's completion ships it in the same write, and it has no Retrospective.
func TestQuickFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		f.skill("review")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		reviewer := f.member("reviewer", []string{"WEB"}, []string{"review"})

		quick := func(nf core.NewFeature) (core.FeatureDetail, error) {
			nf.Team, nf.Quick = "WEB", true
			if nf.Title == "" {
				nf.Title = "Fix the footer"
			}
			return f.svc.FileFeature(ctx, lead, nf, core.Idem{})
		}
		_, err := quick(core.NewFeature{})
		wantCode(t, err, core.CodeInvalid)
		_, err = quick(core.NewFeature{Skill: ptrStr("build"), ShipWhenDone: ptrBool(false)})
		wantCode(t, err, core.CodeInvalid)
		_, err = quick(core.NewFeature{Skill: ptrStr("build"), FromRetrospective: ptrStr("WEB-1")})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.FileFeature(ctx, lead, core.NewFeature{Team: "WEB", Title: "Big", Skill: ptrStr("build")}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.FileFeature(ctx, lead, core.NewFeature{Team: "WEB", Title: "Big", Workspaces: &[]string{}}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		// The Team has no default Workspace, and none is named.
		_, err = quick(core.NewFeature{Skill: ptrStr("build")})
		wantCode(t, err, core.CodeInvalid)
		_, err = quick(core.NewFeature{Skill: ptrStr("nothing"), Workspaces: &[]string{}})
		wantCode(t, err, core.CodeNotFound)

		web := f.workspace("web")
		other := f.workspace("other")
		f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("web")})
		d, err := quick(core.NewFeature{Description: "It overlaps on phones.", Skill: ptrStr("build")})
		if err != nil {
			t.Fatal(err)
		}
		if !d.Feature.Quick || !d.Feature.ShipWhenDone || len(d.Tasks) != 1 {
			t.Fatalf("the quick Feature: %+v with %d Tasks", d.Feature, len(d.Tasks))
		}
		task := d.Tasks[0]
		if task.Kind != "work" || task.Title != "Fix the footer" || task.Description != "It overlaps on phones." ||
			task.SkillID == nil || !slices.Equal(task.WorkspaceIDs, []string{web.ID}) || task.Key != "WEB-2" {
			t.Fatalf("its Task: %+v", task)
		}
		if filed := f.activity("feature.filed"); filed[len(filed)-1].Payload["quick"] != true {
			t.Fatalf("feature.filed: %+v", filed[len(filed)-1])
		}
		named, err := quick(core.NewFeature{Title: "Elsewhere", Skill: ptrStr("build"), Workspaces: &[]string{"other"}})
		if err != nil || !slices.Equal(named.Tasks[0].WorkspaceIDs, []string{other.ID}) {
			t.Fatalf("a quick Feature naming its Workspace: %v %v", named.Tasks, err)
		}

		// Built, handed over to review, reviewed: the review's completion ships it.
		if _, err := f.svc.Claim(ctx, builder, task.ID, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.Handover(ctx, builder, task.ID, "review", nil, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.done(reviewer, task.ID)
		got, err := f.svc.GetFeature(ctx, lead, d.Feature.ID)
		if err != nil || got.Feature.State != "shipped" || len(got.Tasks) != 1 {
			t.Fatalf("after the review: %+v with %d Tasks, %v", got.Feature, len(got.Tasks), err)
		}
		shipped := f.activity("feature.shipped")
		if len(shipped) != 1 || *shipped[0].ActorID != reviewer.MemberID || shipped[0].Payload["ship_when_done"] != true ||
			shipped[0].Payload["quick"] != true {
			t.Fatalf("feature.shipped: %+v", shipped)
		}
		completed := f.activity("task.completed")
		if shipped[0].Seq != completed[len(completed)-1].Seq+1 {
			t.Fatalf("shipped at %d, the completion at %d: not the same write", shipped[0].Seq, completed[len(completed)-1].Seq)
		}

		// Dropping a quick Feature files no Retrospective either.
		dropped, err := f.svc.DropFeature(ctx, lead, named.Feature.ID, core.Idem{})
		if err != nil || len(dropped.Tasks) != 1 || dropped.Tasks[0].State != "dropped" {
			t.Fatalf("dropped: %+v %v", dropped.Tasks, err)
		}
		if n := f.count(`SELECT COUNT(*) FROM tasks WHERE kind = 'retrospective'`); n != 0 {
			t.Fatalf("%d Retrospectives for quick Features", n)
		}
		f.checkActivity()
	})
}

// A Feature with ship_when_done — its own, or its Team's at filing — ships in the write that
// completes its last open Task, filing its Retrospective in the same write; one whose last Task
// is dropped, or that still has open Tasks, waits for its owner.
func TestShipWhenDone(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		lead := f.member("lead", []string{"WEB"}, []string{"build"})
		planner := f.member("planner", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		web := f.workspace("web")

		file := func(title string, ship *bool) core.FeatureDetail {
			t.Helper()
			d, err := f.svc.FileFeature(ctx, lead, core.NewFeature{Team: "WEB", Title: title, ShipWhenDone: ship}, core.Idem{})
			if err != nil {
				t.Fatal(err)
			}
			return d
		}
		state := func(id string) string {
			t.Helper()
			d, err := f.svc.GetFeature(ctx, lead, id)
			if err != nil {
				t.Fatal(err)
			}
			return d.Feature.State
		}

		// The Team's default is off; the Feature says on.
		cart := file("Cart \"v2\"", ptrBool(true))
		if !cart.Feature.ShipWhenDone {
			t.Fatal("ship_when_done not kept")
		}
		a := f.task(lead, cart.Feature.ID, "A", "build")
		b := f.task(lead, cart.Feature.ID, "B", "build")
		f.done(planner, cart.Tasks[0].ID)
		f.done(builder, a.ID)
		if s := state(cart.Feature.ID); s != "open" {
			t.Fatalf("shipped with B open: %s", s)
		}
		f.teamDefaults("WEB", core.TeamChange{DefaultWorkspace: ptrStr("web")})
		f.done(builder, b.ID)
		d, err := f.svc.GetFeature(ctx, lead, cart.Feature.ID)
		if err != nil || d.Feature.State != "shipped" || d.Feature.EndedAt == nil {
			t.Fatalf("after B: %+v %v", d.Feature, err)
		}
		retro := d.Tasks[len(d.Tasks)-1]
		if retro.Kind != "retrospective" || retro.Title != "Retrospective: Cart \"v2\"" || retro.State != "open" || retro.Key != "WEB-5" ||
			!slices.Equal(retro.WorkspaceIDs, []string{web.ID}) {
			t.Fatalf("the Retrospective: %+v", retro)
		}
		todo, _ := f.svc.ListStatuses(ctx, lead)
		if retro.StatusID != todo[1].ID {
			t.Fatalf("the Retrospective is in %s, want %s", retro.StatusID, todo[1].Name)
		}
		// The trail: completed, shipped, Retrospective filed, one after another in one write.
		p, err := f.svc.ListActivity(ctx, f.admin, core.ActivityQuery{Before: 1 << 53, Limit: 3})
		if err != nil {
			t.Fatal(err)
		}
		var kinds []string
		for _, e := range p.Items {
			kinds = append(kinds, e.Kind)
		}
		if !slices.Equal(kinds, []string{"task.completed", "feature.shipped", "task.filed"}) {
			t.Fatalf("the trail ends %v", kinds)
		}
		if p.Items[1].Payload["ship_when_done"] != true || *p.Items[1].ActorID != builder.MemberID {
			t.Fatalf("feature.shipped: %+v", p.Items[1])
		}
		filed := p.Items[2]
		if filed.SubjectID != retro.ID || filed.Payload["key"] != "WEB-5" || filed.Payload["title"] != retro.Title ||
			filed.Payload["kind"] != "retrospective" || filed.Payload["feature_id"] != cart.Feature.ID || filed.Payload["status_id"] != retro.StatusID {
			t.Fatalf("task.filed for the Retrospective: %+v", filed)
		}
		// Its Retrospective completing changes nothing more: the Feature has ended.
		retroer := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		f.done(retroer, retro.ID)
		if n := len(f.activity("feature.shipped")); n != 1 {
			t.Fatalf("%d feature.shipped entries", n)
		}

		// The Team's default on, taken at filing; a Feature saying off keeps off.
		f.teamDefaults("WEB", core.TeamChange{ShipWhenDone: ptrBool(true)})
		auto := file("Auto", nil)
		manual := file("Manual", ptrBool(false))
		f.teamDefaults("WEB", core.TeamChange{ShipWhenDone: ptrBool(false)})
		if !auto.Feature.ShipWhenDone || manual.Feature.ShipWhenDone {
			t.Fatalf("auto %v, manual %v", auto.Feature.ShipWhenDone, manual.Feature.ShipWhenDone)
		}
		f.done(planner, manual.Tasks[0].ID)
		if s := state(manual.Feature.ID); s != "open" {
			t.Fatalf("Manual %s", s)
		}

		// The last open Task dropped: it waits for its owner.
		c := f.task(lead, auto.Feature.ID, "C", "build")
		f.done(planner, auto.Tasks[0].ID)
		if _, err := f.svc.DropTask(ctx, lead, c.ID, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if s := state(auto.Feature.ID); s != "open" {
			t.Fatalf("Auto shipped on a drop: %s", s)
		}
		if _, err := f.svc.ShipFeature(ctx, lead, auto.Feature.ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.checkActivity()
	})
}

// Completing a question on a Feature that has ended ships nothing, though the Feature shipped
// when done.
func TestShipWhenDoneOnAnEndedFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		lead := f.member("lead", []string{"WEB"}, []string{core.SkillBreakdown, core.SkillRetro})
		d, err := f.svc.FileFeature(ctx, lead, core.NewFeature{Team: "WEB", Title: "Cart", ShipWhenDone: ptrBool(true)}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.done(lead, d.Tasks[0].ID)
		got, _ := f.svc.GetFeature(ctx, lead, d.Feature.ID)
		retro := got.Tasks[len(got.Tasks)-1]
		if got.Feature.State != "shipped" || retro.Kind != "retrospective" {
			t.Fatalf("after the Break down: %s, %s", got.Feature.State, retro.Kind)
		}
		// The Retrospective asks the lead a question, which the lead answers.
		if _, err := f.svc.Claim(ctx, lead, retro.ID, noTimeout, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		q, err := f.svc.FileTask(ctx, lead, core.NewTask{Blocks: &retro.ID, Title: "Why?", AimedAt: ptrStr("lead")}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		f.done(lead, q.Task.ID)
		if n := len(f.activity("feature.shipped")); n != 1 {
			t.Fatalf("%d feature.shipped entries", n)
		}
		if n := f.count(`SELECT COUNT(*) FROM tasks WHERE kind = 'retrospective'`); n != 1 {
			t.Fatalf("%d Retrospectives", n)
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

// InitWith seeds the roster in Init's one write: Team MAIN with the first Member, the Workspace as
// its default, the Skills engineer and review, and the four agents in MAIN with their Skills,
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
		if out.Team == nil || out.Team.Key != "MAIN" || out.Team.Name != "Main" || out.Workspace == nil ||
			out.Workspace.Name != "darkory" || out.Workspace.DefaultBranch != "trunk" || out.Team.DefaultWorkspaceID == nil ||
			*out.Team.DefaultWorkspaceID != out.Workspace.ID {
			t.Fatalf("the Team %+v and Workspace %+v", out.Team, out.Workspace)
		}
		a := auth.New(st, clockAt(epoch))
		ada, err := a.Authenticate(ctx, auth.Credentials{Bearer: out.Token.Secret, Session: "ada-1"})
		if err != nil {
			t.Fatal(err)
		}
		team, err := svc.GetTeam(ctx, ada, "MAIN")
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, m := range team.Members {
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
		if !slices.Equal(skillNames, []string{"breakdown", "engineer", "retro", "review", "skill-review"}) {
			t.Fatalf("Skills %v", skillNames)
		}
		// Filed in MAIN, the Break down names the Workspace.
		d, err := svc.FileFeature(ctx, ada, core.NewFeature{Team: "MAIN", Title: "Cart"}, core.Idem{})
		if err != nil || !slices.Equal(d.Tasks[0].WorkspaceIDs, []string{out.Workspace.ID}) {
			t.Fatalf("the Break down names %v (%v)", d.Tasks[0].WorkspaceIDs, err)
		}
	})
}

func clockAt(t time.Time) *clock.Fake { return clock.NewFake(t) }

// A Task nobody holds, open or ended, takes Notes from its Feature's owner, wherever they are, and
// from any Member of its Feature's Team, under no Skill; anyone else is forbidden. A held Task
// takes them from its holder alone, the owner and the Team included. A retry under its key adds
// nothing more.
func TestNotesOnATaskNobodyHolds(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.team("OPS")
		f.skill("build")
		owner := f.member("owner", []string{"OPS"}, nil)
		mate := f.member("mate", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		reviewer := f.member("reviewer", []string{"OPS"}, nil)
		d, err := f.svc.FileFeature(ctx, mate, core.NewFeature{Team: "WEB", Title: "Cart", Owner: ptrStr("owner")}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		task := f.task(mate, d.Feature.ID, "Pay", "build")

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

		// Ended: someone from OPS still may not; the Team and the owner still write.
		_, err = f.svc.AddNote(ctx, reviewer, task.Key, "one more thing", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		key := jsonIdem("merged-"+task.ID, "h")
		n, err := f.svc.AddNote(ctx, mate, task.Key, "Merged WEB-3/pay into feature/WEB-1 at 1a2b3c", key)
		if err != nil {
			t.Fatal(err)
		}
		again, err := f.svc.AddNote(ctx, mate, task.Key, "Merged WEB-3/pay into feature/WEB-1 at 1a2b3c", key)
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
