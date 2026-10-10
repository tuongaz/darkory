package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A Task's pull request through the client: recorded by a Member of its Project, filtered by,
// and merged through the Runner beside the server, by the Task's Owner or an admin, with the
// Runner's refusals answered not_found or conflict in GitHub's words.
func TestPullRequestThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		mode := client.WorkspaceModePullRequest
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode})).
			want(t, http.StatusCreated)
		bob, _ := h.member("bob", client.Agent, "WEB")
		cy, _ := h.member("cy", client.Human, "WEB")
		task := got(bob.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout",
			Workspaces: &[]string{"web"}})).want(t, http.StatusCreated).JSON201.Task

		pr := client.SetTaskPullRequestBody{Number: 7, URL: "https://github.com/acme/web/pull/7", State: client.PullRequestOpen}
		set := got(cy.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{IdempotencyKey: key("pr-1")}, pr)).
			want(t, http.StatusOK).JSON200
		if set.PullRequest == nil || set.PullRequest.Number != 7 || set.PullRequest.State != client.PullRequestOpen {
			t.Fatalf("recorded %+v", set.PullRequest)
		}
		for _, addr := range []string{"javascript:alert(1)", "http://github.com/acme/web/pull/7", "https://evil.example/acme/web/pull/7"} {
			bad := pr
			bad.URL = addr
			if res := got(cy.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{}, bad)).want(t, http.StatusBadRequest); res.JSONDefault.Code != client.ErrorCodeInvalid {
				t.Fatalf("%s: %s", addr, res.Body)
			}
		}
		zero := pr
		zero.Number = 0
		got(cy.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{}, zero)).want(t, http.StatusBadRequest)
		open := got(ada.ListTasksWithResponse(ctx, &client.ListTasksParams{Filter: &[]string{"pull_request:is:open"}})).want(t, http.StatusOK).JSON200
		if len(open.Items) != 1 || open.Items[0].Key != task.Key {
			t.Fatalf("pull_request:is:open listed %+v", open.Items)
		}

		// No Runner attached.
		res := got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusConflict)
		if res.JSONDefault.Code != client.ErrorCodeNoRunner {
			t.Fatalf("without a Runner: %s", res.Body)
		}
		var asked []string
		fake := &fakeRunner{}
		h.srv.AttachRunner(fake)
		// An agent, though the Task's Owner, and a human neither its Owner nor an admin.
		if res := got(bob.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusForbidden); !strings.Contains(res.JSONDefault.Message, "human's act") {
			t.Fatalf("an agent merging: %s", res.Body)
		}
		got(cy.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusForbidden)
		// GitHub has no such pull request open.
		if res := got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusNotFound); res.JSONDefault.Code != client.ErrorCodeNotFound {
			t.Fatalf("no open pull request: %s", res.Body)
		}
		// The Runner refuses, in its words.
		fake.merge = func(string, int64) error {
			return errors.New("Pull request acme/web#7 is not mergeable: the base branch policy prohibits the merge")
		}
		res = got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusConflict)
		if res.JSONDefault.Code != client.ErrorCodeConflict || !strings.Contains(res.JSONDefault.Message, "base branch policy prohibits") {
			t.Fatalf("GitHub's refusal: %s", res.Body)
		}
		// The Runner merges, given the Task and the recorded number only; the server records the
		// merge as the caller.
		fake.merge = func(id string, number int64) error {
			asked = append(asked, fmt.Sprintf("%s #%d", id, number))
			return nil
		}
		done := got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusOK).JSON200
		if done.PullRequest == nil || done.PullRequest.State != client.PullRequestMerged {
			t.Fatalf("after the merge %+v", done.PullRequest)
		}
		if want := task.ID + " #7"; len(asked) != 1 || asked[0] != want {
			t.Fatalf("the Runner was asked %v, want %s", asked, want)
		}
		kinds := []client.ActivityKind{client.ActivityKindTaskPullRequestMerged}
		merged := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Kind: &kinds})).want(t, http.StatusOK).JSON200.Items
		if len(merged) != 1 || merged[0].ActorID == nil || shortid.Canonical(*merged[0].ActorID) != shortid.Canonical(h.adminID) {
			t.Fatalf("task.pull_request_merged %+v", merged)
		}
		detail := got(ada.GetTaskWithResponse(ctx, task.Key)).want(t, http.StatusOK).JSON200
		if n := detail.Notes; len(n) != 1 || n[0].Body != "web: #7 merged" {
			t.Fatalf("Notes %+v", n)
		}
		got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusNotFound)
		if res := got(cy.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{}, pr)).want(t, http.StatusConflict); !strings.Contains(res.JSONDefault.Message, "#7 is already merged") {
			t.Fatalf("open over merged: %s", res.Body)
		}
	})
}

// A company Skill's Project, Evidence kind and an agent's Shifts through the client.
func TestSkillProjectEvidenceKindAndShiftsThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		web := got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).
			want(t, http.StatusCreated).JSON201.Project
		bob, _ := h.member("bob", client.Agent, "WEB")

		sk := got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: "web-qa", Kind: client.Company,
			BaseSkill: ptrStr("qa"), Project: ptrStr("WEB"), Body: "WEB's QA"})).want(t, http.StatusCreated).JSON201.Skill
		if sk.ProjectID == nil || *sk.ProjectID != web.ID {
			t.Fatalf("created %+v", sk)
		}
		got(bob.UpdateSkillWithResponse(ctx, "web-qa", &client.UpdateSkillParams{}, client.UpdateSkillBody{Project: ""})).want(t, http.StatusForbidden)
		got(ada.UpdateSkillWithResponse(ctx, "qa", &client.UpdateSkillParams{}, client.UpdateSkillBody{Project: "WEB"})).want(t, http.StatusBadRequest)
		org := got(ada.UpdateSkillWithResponse(ctx, "web-qa", &client.UpdateSkillParams{}, client.UpdateSkillBody{Project: ""})).want(t, http.StatusOK).JSON200.Skill
		if b, _ := json.Marshal(org); org.ProjectID != nil || strings.Contains(string(b), "project_id") {
			t.Fatalf("the Organisation's %+v", org)
		}

		task := got(bob.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptrStr("WEB"), Title: "x"})).
			want(t, http.StatusCreated).JSON201.Task
		attach := func(kind *client.EvidenceKind) *client.AttachTaskEvidenceResponse {
			res, err := bob.AttachTaskEvidenceWithBodyWithResponse(ctx, task.Key, &client.AttachTaskEvidenceParams{Filename: "a.log", Kind: kind},
				"text/plain", bytes.NewReader([]byte("ok")))
			if err != nil {
				t.Fatal(err)
			}
			return res
		}
		if e := attach(nil); e.StatusCode() != http.StatusCreated || e.JSON201.Kind != client.EvidenceKindEvidence {
			t.Fatalf("no kind: %s", e.Body)
		}
		log := client.EvidenceKindLog
		if e := attach(&log); e.StatusCode() != http.StatusCreated || e.JSON201.Kind != client.EvidenceKindLog {
			t.Fatalf("a log: %s", e.Body)
		}
		wrong := client.EvidenceKind("screenshot")
		if e := attach(&wrong); e.StatusCode() != http.StatusBadRequest {
			t.Fatalf("an unknown kind: %d %s", e.StatusCode(), e.Body)
		}

		m := got(ada.SetAgentSettingsWithResponse(ctx, "bob", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{Model: ptrStr("m")})).
			want(t, http.StatusOK).JSON200
		if m.Agent == nil || m.Agent.Shifts != 1 {
			t.Fatalf("the default %+v", m.Agent)
		}
		nine, two := 9, 2
		got(ada.SetAgentSettingsWithResponse(ctx, "bob", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{Shifts: &nine})).want(t, http.StatusBadRequest)
		m = got(ada.SetAgentSettingsWithResponse(ctx, "bob", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{Shifts: &two})).
			want(t, http.StatusOK).JSON200
		if m.Agent.Shifts != 2 {
			t.Fatalf("two %+v", m.Agent)
		}
	})
}
