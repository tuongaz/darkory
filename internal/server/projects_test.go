package server

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Projects through the generated client: made with their Members, defaults and a Workflow —
// the default, empty, or a copy — listed, read, changed; the caller's own in /v1/me, with no
// Organisations on Local; Members and Activity narrowed to a Project.
func TestProjectsThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		bob, bobID := h.member("bob", client.Human, "")
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web"})).
			want(t, http.StatusCreated)

		body := client.CreateProjectBody{Key: "WEB", Name: "Web", Members: &[]string{"ada", "bob"}, DefaultWorkspace: ptrStr("web"),
			AutoComplete: ptrBool(true), Acceptance: ptrBool(true)}
		first := got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{IdempotencyKey: key("web")}, body)).want(t, http.StatusCreated)
		web := first.JSON201
		if web.Project.Key != "WEB" || !web.Project.AutoComplete || !web.Project.Acceptance || web.Project.DefaultWorkspaceID == nil ||
			len(web.Members) != 2 || web.Members[1].ID != bobID {
			t.Fatalf("created %s", first.Body)
		}
		if again := got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{IdempotencyKey: key("web")}, body)).want(t, http.StatusCreated); string(again.Body) != string(first.Body) {
			t.Fatalf("the retry: %s", again.Body)
		}
		for _, c := range []struct {
			who    *client.ClientWithResponses
			body   client.CreateProjectBody
			status int
			code   client.ErrorCode
		}{
			{bob, client.CreateProjectBody{Key: "OPS", Name: "Ops"}, http.StatusForbidden, client.ErrorCodeForbidden},
			{ada, client.CreateProjectBody{Key: "OPS", Name: "web"}, http.StatusConflict, client.ErrorCodeConflict},
			{ada, client.CreateProjectBody{Key: "ops", Name: "Ops"}, http.StatusBadRequest, client.ErrorCodeInvalid},
			{ada, client.CreateProjectBody{Key: "OPS", Name: "Ops", Workflow: ptrWorkflow(client.NewWorkflowCopy)}, http.StatusBadRequest, client.ErrorCodeInvalid},
			{ada, client.CreateProjectBody{Key: "OPS", Name: "Ops", CopyFrom: ptrStr("WEB")}, http.StatusBadRequest, client.ErrorCodeInvalid},
			{ada, client.CreateProjectBody{Key: "OPS", Name: "Ops", Workflow: ptrWorkflow(client.NewWorkflowCopy), CopyFrom: ptrStr("NOPE")}, http.StatusNotFound, client.ErrorCodeNotFound},
			{ada, client.CreateProjectBody{Key: "OPS", Name: "Ops", Members: &[]string{"nobody"}}, http.StatusNotFound, client.ErrorCodeNotFound},
		} {
			res := got(c.who.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, c.body)).want(t, c.status)
			if res.JSONDefault == nil || res.JSONDefault.Code != c.code {
				t.Errorf("%+v: %s", c.body, res.Body)
			}
		}
		empty := got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "TAX", Name: "Tax",
			Workflow: ptrWorkflow(client.NewWorkflowEmpty)})).want(t, http.StatusCreated).JSON201
		copied := got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "API", Name: "API",
			Workflow: ptrWorkflow(client.NewWorkflowCopy), CopyFrom: ptrStr("WEB")})).want(t, http.StatusCreated).JSON201
		if empty.Project.AutoComplete || len(empty.Members) != 0 {
			t.Fatalf("TAX %+v", empty)
		}
		if copied.Project.Key != "API" {
			t.Fatalf("API %+v", copied)
		}
		for key, want := range map[string]string{"WEB": "Backlog Plan Build Review Retro Skill review", "TAX": "Backlog", "API": "Backlog Plan Build Review Retro Skill review"} {
			if names := stepNames(got(ada.GetWorkflowWithResponse(ctx, key)).want(t, http.StatusOK).JSON200); names != want {
				t.Errorf("%s's Workflow: %s", key, names)
			}
		}
		taxFlow := got(ada.GetWorkflowWithResponse(ctx, "TAX")).want(t, http.StatusOK).JSON200
		if len(taxFlow.Connectors) != 1 || taxFlow.Connectors[0].Name != "done" || taxFlow.Connectors[0].ToStepID != nil || taxFlow.Steps[0].SkillID != nil {
			t.Fatalf("TAX's Workflow %+v", taxFlow)
		}

		list := got(bob.ListProjectsWithResponse(ctx)).want(t, http.StatusOK).JSON200.Items
		if len(list) != 3 || list[0].Key != "API" || list[2].Key != "WEB" {
			t.Fatalf("Projects %+v", list)
		}
		changed := got(ada.UpdateProjectWithResponse(ctx, "WEB", &client.UpdateProjectParams{}, client.UpdateProjectBody{Name: ptrStr("Shop"),
			DefaultWorkspace: ptrStr(""), Acceptance: ptrBool(false)})).want(t, http.StatusOK).JSON200
		if changed.Name != "Shop" || changed.Key != "WEB" || changed.DefaultWorkspaceID != nil || changed.Acceptance || !changed.AutoComplete {
			t.Fatalf("changed %+v", changed)
		}
		got(bob.UpdateProjectWithResponse(ctx, "WEB", &client.UpdateProjectParams{}, client.UpdateProjectBody{Name: ptrStr("x")})).want(t, http.StatusForbidden)
		detail := got(bob.GetProjectWithResponse(ctx, web.Project.ID)).want(t, http.StatusOK).JSON200
		if detail.Project.Name != "Shop" || len(detail.Members) != 2 {
			t.Fatalf("WEB %+v", detail)
		}

		// Membership.
		got(bob.AddProjectMemberWithResponse(ctx, "TAX", "bob", &client.AddProjectMemberParams{})).want(t, http.StatusForbidden)
		got(ada.AddProjectMemberWithResponse(ctx, "TAX", "bob", &client.AddProjectMemberParams{})).want(t, http.StatusNoContent)
		got(ada.RemoveProjectMemberWithResponse(ctx, "WEB", "bob", &client.RemoveProjectMemberParams{})).want(t, http.StatusNoContent)
		members := got(ada.ListMembersWithResponse(ctx, &client.ListMembersParams{Project: ptrStr("TAX")})).want(t, http.StatusOK).JSON200.Items
		if len(members) != 1 || members[0].Name != "bob" {
			t.Fatalf("TAX's Members %+v", members)
		}
		me := got(bob.GetMeWithResponse(ctx)).want(t, http.StatusOK)
		if len(me.JSON200.Projects) != 1 || me.JSON200.Projects[0].Key != "TAX" || me.JSON200.Organisations != nil ||
			strings.Contains(string(me.Body), "organisations") {
			t.Fatalf("bob's me: %s", me.Body)
		}
		if m := got(ada.GetMemberWithResponse(ctx, "bob")).want(t, http.StatusOK).JSON200; len(m.Projects) != 1 || m.Projects[0].Key != "TAX" {
			t.Fatalf("bob %+v", m)
		}

		// Activity about one Project: itself, its Workflow, its Members.
		page := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Project: ptrStr("TAX")})).want(t, http.StatusOK).JSON200
		var kinds []string
		for _, a := range page.Items {
			kinds = append(kinds, string(a.Kind))
		}
		if strings.Join(kinds, " ") != "project.created workflow.changed project.member_added" {
			t.Fatalf("TAX's Activity: %v", kinds)
		}
	})
}

// A Workflow through the client: read with each Step's live facts, replaced whole by position,
// refused when it would strand open Tasks or names what it does not have; a Task moved by hand,
// out of a hold and, held, by its Owner; ranked; passed on; labelled.
func TestWorkflowAndTasksThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web",
			Members: &[]string{"ada"}})).want(t, http.StatusCreated)
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "OPS", Name: "Ops"})).
			want(t, http.StatusCreated)
		builder, builderID := h.member("builder", client.Agent, "WEB", "engineer")
		peer, _ := h.member("peer", client.Human, "WEB")
		outsider, _ := h.member("outsider", client.Human, "OPS")

		later := h.file(peer, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Later", Step: ptrStr("Backlog")}).Task
		now := h.file(ada, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Now", Step: ptrStr("build")}).Task
		got(builder.ClaimTaskWithResponse(ctx, now.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusOK)

		wf := got(peer.GetWorkflowWithResponse(ctx, "WEB")).want(t, http.StatusOK).JSON200
		if len(wf.Workflows) != 1 || wf.Workflows[0].Name != "Work" || wf.Workflows[0].Position != 1 || wf.Workflows[0].ID == "" {
			t.Fatalf("WEB's Workflows: %+v", wf.Workflows)
		}
		work := wf.Workflows[0].ID
		facts := map[string]client.WorkflowStep{}
		for _, s := range wf.Steps {
			facts[s.Name] = s
			if s.WorkflowID != work {
				t.Fatalf("%s is in Workflow %q, want %s", s.Name, s.WorkflowID, work)
			}
		}
		if b := facts["Build"]; b.Tasks != 1 || b.Working != 1 || len(b.Takers) != 1 || b.Takers[0].ID != builderID || b.Takers[0].Kind != client.Agent {
			t.Fatalf("Build %+v", b)
		}
		if bl := facts["Backlog"]; bl.Tasks != 1 || bl.Working != 0 || len(bl.Takers) != 0 || bl.SkillID != nil {
			t.Fatalf("Backlog %+v", bl)
		}
		if raw := string(got(peer.GetWorkflowWithResponse(ctx, "WEB")).want(t, http.StatusOK).Body); !strings.Contains(raw, `"takers":[]`) {
			t.Fatalf("a Step nobody takes lists no takers: %s", raw)
		}

		// Moved out of the hold by a Member of the Project, with a Note; by an outsider, refused.
		got(outsider.MoveTaskWithResponse(ctx, later.Key, &client.MoveTaskParams{}, client.MoveTaskBody{Step: "Build"})).want(t, http.StatusForbidden)
		moved := got(peer.MoveTaskWithResponse(ctx, later.Key, &client.MoveTaskParams{}, client.MoveTaskBody{Step: "build", Note: ptrStr("ready now")})).
			want(t, http.StatusOK).JSON200
		if moved.StepID == nil || *moved.StepID != facts["Build"].ID {
			t.Fatalf("moved %+v", moved)
		}
		if n := got(peer.GetTaskWithResponse(ctx, later.Key)).want(t, http.StatusOK).JSON200.Notes; len(n) != 1 || n[0].Body != "ready now" || n[0].SkillID != nil {
			t.Fatalf("the move's Note %+v", n)
		}
		got(peer.MoveTaskWithResponse(ctx, later.Key, &client.MoveTaskParams{}, client.MoveTaskBody{Step: "Nowhere"})).want(t, http.StatusNotFound)
		// Held: its Owner moves it, and the Claim ends taken back.
		back := got(ada.MoveTaskWithResponse(ctx, now.Key, &client.MoveTaskParams{}, client.MoveTaskBody{Step: "Review"})).want(t, http.StatusOK).JSON200
		if back.Claim != nil || *back.StepID != facts["Review"].ID {
			t.Fatalf("moved while held %+v", back)
		}
		hb := got(builder.HeartbeatWithResponse(ctx, now.Key, &client.HeartbeatParams{})).want(t, http.StatusOK).JSON200
		if hb.Status != client.HeartbeatStatusTakenBack {
			t.Fatalf("the holder's heartbeat after the move: %+v", hb)
		}

		// Listed by Step: by id alone, or by name with the Project.
		at := func(params client.ListTasksParams) []string {
			t.Helper()
			var ks []string
			for _, tk := range got(peer.ListTasksWithResponse(ctx, &params)).want(t, http.StatusOK).JSON200.Items {
				ks = append(ks, tk.Key)
			}
			return ks
		}
		if ks := at(client.ListTasksParams{Step: ptrStr(facts["Build"].ID)}); !slices.Equal(ks, []string{later.Key}) {
			t.Fatalf("at Build: %v", ks)
		}
		if ks := at(client.ListTasksParams{Project: ptrStr("WEB"), Step: ptrStr("Review")}); !slices.Equal(ks, []string{now.Key}) {
			t.Fatalf("at Review: %v", ks)
		}

		// Replaced whole: the Steps by position, not by the list's order; a Step with open Tasks
		// needs moves.
		reviewID, buildID, backlogID := facts["Review"].ID, facts["Build"].ID, facts["Backlog"].ID
		in := client.SetWorkflowBody{
			Workflows: []client.WorkflowInput{{Name: "Work", Position: 1}},
			Steps: []client.StepInput{
				{ID: &reviewID, Workflow: "Work", Name: "Check", Skill: ptrStr("review"), Position: 3},
				{ID: &buildID, Workflow: "Work", Name: "Build", Skill: ptrStr("engineer"), Position: 2},
				{ID: &backlogID, Workflow: "Work", Name: "Backlog", Position: 1},
			},
			Connectors: []client.ConnectorInput{
				{From: "Build", To: ptrStr("Check"), Name: "pass", Position: 1},
				{From: "Check", Name: "pass", Position: 1},
				{From: "Check", To: ptrStr("Build"), Name: "needs changes", Position: 2},
			},
		}
		bad := in
		bad.Steps = slices.Clone(in.Steps)
		bad.Steps[0].Position = 2
		if res := got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, bad)).want(t, http.StatusBadRequest); res.JSONDefault.Code != client.ErrorCodeInvalid {
			t.Fatalf("two Steps at one position: %s", res.Body)
		}
		bare := in
		bare.Workflows = nil
		if res := got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, bare)).want(t, http.StatusBadRequest); res.JSONDefault.Code != client.ErrorCodeInvalid {
			t.Fatalf("a body without workflows: %s", res.Body)
		}
		got(peer.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, in)).want(t, http.StatusForbidden)
		set := got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{IdempotencyKey: key("wf")}, in)).want(t, http.StatusOK).JSON200
		if names := stepNames(set); names != "Backlog Build Check" || set.Steps[2].Tasks != 1 || set.Steps[2].Position != 3 {
			t.Fatalf("set %+v", set)
		}
		in.Steps = in.Steps[1:]
		in.Connectors = in.Connectors[:1]
		in.Connectors[0].To = nil
		inUse := got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, in)).want(t, http.StatusConflict)
		if inUse.JSONDefault.Code != client.ErrorCodeStepInUse {
			t.Fatalf("deleting a Step with Tasks: %s", inUse.Body)
		}
		in.Moves = &map[string]string{facts["Review"].ID: "Build"}
		if set = got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, in)).want(t, http.StatusOK).JSON200; stepNames(set) != "Backlog Build" || set.Steps[1].Tasks != 2 {
			t.Fatalf("after the move %+v", set)
		}

		// Ranked by a Member of the Project; passed on by the Owner; a Subtask takes both from its
		// Parent.
		ranked := got(peer.RankTaskWithResponse(ctx, now.Key, &client.RankTaskParams{}, client.RankTaskBody{Position: 1})).want(t, http.StatusOK).JSON200
		if *ranked.Rank != 1 {
			t.Fatalf("ranked %+v", ranked)
		}
		got(outsider.RankTaskWithResponse(ctx, now.Key, &client.RankTaskParams{}, client.RankTaskBody{Position: 2})).want(t, http.StatusForbidden)
		passed := got(ada.PassOwnershipWithResponse(ctx, now.Key, &client.PassOwnershipParams{}, client.PassOwnershipBody{Owner: "peer"})).
			want(t, http.StatusOK).JSON200
		if passed.OwnerID == ranked.OwnerID {
			t.Fatalf("passed %+v", passed)
		}
		sub := h.file(peer, client.FileTaskBody{Parent: &now.Key, Title: "A part"}).Task
		if res := got(peer.RankTaskWithResponse(ctx, sub.Key, &client.RankTaskParams{}, client.RankTaskBody{Position: 1})).want(t, http.StatusConflict); res.JSONDefault.Code != client.ErrorCodeUseParent {
			t.Fatalf("ranking a Subtask: %s", res.Body)
		}
		if res := got(ada.PassOwnershipWithResponse(ctx, sub.Key, &client.PassOwnershipParams{}, client.PassOwnershipBody{Owner: "ada"})).want(t, http.StatusConflict); res.JSONDefault.Code != client.ErrorCodeUseParent {
			t.Fatalf("passing a Subtask's ownership: %s", res.Body)
		}

		// Two Workflows: Bugs' Steps listed first but placed second, and a Connector out of Build
		// into Bugs. The Steps read back in the Project's order, each with its Workflow.
		two := client.SetWorkflowBody{
			Workflows: []client.WorkflowInput{{Name: "Bugs", Position: 2}, {ID: &work, Name: "Work", Position: 1}},
			Steps: []client.StepInput{
				{Workflow: "Bugs", Name: "Fix", Skill: ptrStr("engineer"), Position: 2},
				{Workflow: "Bugs", Name: "Investigate", Skill: ptrStr("engineer"), Position: 1},
				{ID: &backlogID, Workflow: work, Name: "Backlog", Position: 1},
				{ID: &buildID, Workflow: "Work", Name: "Build", Skill: ptrStr("engineer"), Position: 2},
			},
			Connectors: []client.ConnectorInput{
				{From: "Build", Name: "pass", Position: 1},
				{From: "Build", To: ptrStr("Investigate"), Name: "bug", Position: 2},
				{From: "Investigate", To: ptrStr("Fix"), Name: "fix", Position: 1},
				{From: "Fix", Name: "done", Position: 1},
			},
		}
		set = got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, two)).want(t, http.StatusOK).JSON200
		if stepNames(set) != "Backlog Build Investigate Fix" || len(set.Workflows) != 2 || set.Workflows[0].ID != work ||
			set.Workflows[1].Name != "Bugs" || set.Workflows[1].Position != 2 {
			t.Fatalf("two Workflows: %s %+v", stepNames(set), set.Workflows)
		}
		bugs := set.Workflows[1].ID
		for _, s := range set.Steps {
			if want := map[bool]string{true: bugs, false: work}[s.Name == "Investigate" || s.Name == "Fix"]; s.WorkflowID != want {
				t.Fatalf("%s is in Workflow %s, want %s", s.Name, s.WorkflowID, want)
			}
		}
		// The Connector out of Build into Bugs reads back with the rest, in Step order.
		var outs []string
		for _, k := range set.Connectors {
			to := "Done"
			if k.ToStepID != nil {
				to = *k.ToStepID
			}
			outs = append(outs, k.FromStepID+" "+k.Name+" "+to)
		}
		investigate, fix := stepID(set, "Investigate"), stepID(set, "Fix")
		if want := []string{buildID + " pass Done", buildID + " bug " + investigate, investigate + " fix " + fix, fix + " done Done"}; !slices.Equal(outs, want) {
			t.Fatalf("the Connectors read back as %q, want %q", outs, want)
		}

		// Sent back as read, its Workflows without their ids: they keep them, and nothing is
		// written.
		changes := func() int {
			t.Helper()
			kinds := []client.ActivityKind{client.ActivityKindWorkflowChanged}
			return len(got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Project: ptrStr("WEB"), Kind: &kinds})).
				want(t, http.StatusOK).JSON200.Items)
		}
		before := changes()
		asRead := client.SetWorkflowBody{}
		for _, w := range set.Workflows {
			asRead.Workflows = append(asRead.Workflows, client.WorkflowInput{Name: w.Name, Position: w.Position})
		}
		for _, s := range set.Steps {
			asRead.Steps = append(asRead.Steps, client.StepInput{ID: &s.ID, Workflow: s.WorkflowID, Name: s.Name, Skill: s.SkillID, Position: s.Position, X: &s.X, Y: &s.Y})
		}
		for _, k := range set.Connectors {
			asRead.Connectors = append(asRead.Connectors, client.ConnectorInput{ID: &k.ID, From: k.FromStepID, To: k.ToStepID, Name: k.Name, Position: k.Position})
		}
		again := got(ada.SetWorkflowWithResponse(ctx, "WEB", &client.SetWorkflowParams{}, asRead)).want(t, http.StatusOK).JSON200
		if again.Workflows[0].ID != work || again.Workflows[1].ID != bugs || changes() != before {
			t.Fatalf("sent back as read: %+v, %d workflow.changed after %d", again.Workflows, changes(), before)
		}

		// Advanced along bug, a Task is in Bugs: listed by its name with the Project, or by its
		// id alone, in either form.
		claimAndAdvance := func(task, outcome string) client.Task {
			t.Helper()
			got(builder.ClaimTaskWithResponse(ctx, task, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusOK)
			return *got(builder.AdvanceTaskWithResponse(ctx, task, &client.AdvanceTaskParams{}, client.AdvanceTaskBody{Outcome: &outcome})).
				want(t, http.StatusOK).JSON200
		}
		bugged := claimAndAdvance(later.Key, "bug")
		if bugged.WorkflowID == nil || *bugged.WorkflowID != bugs || bugged.LastStepID != nil {
			t.Fatalf("advanced into Bugs: %+v", bugged)
		}
		if ks := at(client.ListTasksParams{Project: ptrStr("WEB"), Workflow: ptrStr("Bugs")}); !slices.Equal(ks, []string{later.Key}) {
			t.Fatalf("in Bugs by name: %v", ks)
		}
		if ks := at(client.ListTasksParams{Workflow: ptrStr(shortid.Canonical(bugs))}); !slices.Equal(ks, []string{later.Key}) {
			t.Fatalf("in Bugs by its long id: %v", ks)
		}
		if ks := at(client.ListTasksParams{Workflow: &bugs}); !slices.Equal(ks, []string{later.Key}) {
			t.Fatalf("in Bugs by its short id: %v", ks)
		}

		// Ended at Fix, it keeps Fix as its last Step, and Bugs as its Workflow.
		claimAndAdvance(later.Key, "fix")
		claimAndAdvance(later.Key, "done")
		fixID := stepID(set, "Fix")
		ended := got(peer.GetTaskWithResponse(ctx, later.Key)).want(t, http.StatusOK).JSON200.Task
		if ended.State != client.TaskStateDone || ended.StepID != nil || ended.LastStepID == nil || *ended.LastStepID != fixID ||
			ended.WorkflowID == nil || *ended.WorkflowID != bugs {
			t.Fatalf("ended at Fix: %+v", ended)
		}
	})
}

func ptrWorkflow(w client.NewWorkflow) *client.NewWorkflow { return &w }
