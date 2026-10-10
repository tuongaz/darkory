package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/runnerapi"
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
		fake.merge = func(context.Context, string, int64) error {
			return errors.New("Pull request acme/web#7 is not mergeable: the base branch policy prohibits the merge")
		}
		res = got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusConflict)
		if res.JSONDefault.Code != client.ErrorCodeConflict || !strings.Contains(res.JSONDefault.Message, "base branch policy prohibits") {
			t.Fatalf("GitHub's refusal: %s", res.Body)
		}
		// The Runner merges, given the Task and the recorded number only; the server records the
		// merge as the caller.
		fake.merge = func(_ context.Context, id string, number int64) error {
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

// One merge of a Task at a time: of two requests at once, one merges and is answered with the
// Task, and the other, waiting, finds the pull request merged and is answered not_found.
func TestMergeOneAtATime(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddProjectMemberWithResponse(ctx, "WEB", "ada", &client.AddProjectMemberParams{})).want(t, http.StatusNoContent)
		mode := client.WorkspaceModePullRequest
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode})).
			want(t, http.StatusCreated)
		task := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout",
			Workspaces: &[]string{"web"}})).want(t, http.StatusCreated).JSON201.Task
		got(ada.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{},
			client.SetTaskPullRequestBody{Number: 7, URL: "https://github.com/acme/web/pull/7", State: client.PullRequestOpen})).want(t, http.StatusOK)

		// The Runner's Merge says it has begun, then waits to be let go: the other requests arrive
		// meanwhile, with no clock in the test.
		var merges atomic.Int32
		entered, release := make(chan struct{}, 4), make(chan struct{})
		h.srv.AttachRunner(&fakeRunner{merge: func(ctx context.Context, _ string, _ int64) error {
			merges.Add(1)
			entered <- struct{}{}
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}})
		merge := func(ctx context.Context) (int, error) {
			res, err := ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})
			if err != nil {
				return 0, err
			}
			return res.StatusCode(), nil
		}
		codes := make(chan int, 2)
		go func() {
			c, err := merge(ctx)
			if err != nil {
				t.Error(err)
			}
			codes <- c
		}()
		<-entered
		// A waiter whose client goes away stops waiting, and leaves the lock as it was.
		gone, cancel := context.WithCancel(ctx)
		cancelled := make(chan error, 1)
		go func() {
			_, err := merge(gone)
			cancelled <- err
		}()
		go func() {
			c, err := merge(ctx)
			if err != nil {
				t.Error(err)
			}
			codes <- c
		}()
		time.Sleep(100 * time.Millisecond) // both waiters reach the lock; the test's outcome holds either way
		cancel()
		if err := <-cancelled; !errors.Is(err, context.Canceled) {
			t.Fatalf("the cancelled waiter: %v", err)
		}
		close(release)
		got := map[int]int{<-codes: 1}
		got[<-codes]++
		if merges.Load() != 1 || got[http.StatusOK] != 1 || got[http.StatusNotFound] != 1 {
			t.Fatalf("%d merges, answers %v", merges.Load(), got)
		}
	})
}

// A Runner that does not answer in time: the merge is answered conflict, saying to look on GitHub,
// and the Task's merge is free again for the next request.
func TestMergeTimesOut(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		h.srv.runnerTimeout = 200 * time.Millisecond
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddProjectMemberWithResponse(ctx, "WEB", "ada", &client.AddProjectMemberParams{})).want(t, http.StatusNoContent)
		mode := client.WorkspaceModePullRequest
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode})).
			want(t, http.StatusCreated)
		task := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout",
			Workspaces: &[]string{"web"}})).want(t, http.StatusCreated).JSON201.Task
		got(ada.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{},
			client.SetTaskPullRequestBody{Number: 7, URL: "https://github.com/acme/web/pull/7", State: client.PullRequestOpen})).want(t, http.StatusOK)

		var calls atomic.Int32
		h.srv.AttachRunner(&fakeRunner{merge: func(ctx context.Context, _ string, _ int64) error {
			if calls.Add(1) == 1 {
				<-ctx.Done() // gh hangs
				return ctx.Err()
			}
			return nil
		}})
		res := got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusConflict)
		if !strings.Contains(res.JSONDefault.Message, "the Runner did not answer in 200ms; look at the pull request on GitHub before trying again") {
			t.Fatalf("the refusal reads %q", res.JSONDefault.Message)
		}
		got(ada.MergeTaskPullRequestWithResponse(ctx, task.Key, &client.MergeTaskPullRequestParams{})).want(t, http.StatusOK)
		if calls.Load() != 2 {
			t.Fatalf("%d merges", calls.Load())
		}
	})
}

// An agent's write of merged is checked on GitHub through the Runner when one is attached: the
// pull request must be merged there, its head on the Task's branch. A human's write, a write of
// open, and a write with no Runner attached are not checked.
func TestAgentMergedWriteIsCheckedOnGitHub(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddProjectMemberWithResponse(ctx, "WEB", "ada", &client.AddProjectMemberParams{})).want(t, http.StatusNoContent)
		mode := client.WorkspaceModePullRequest
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode})).
			want(t, http.StatusCreated)
		bob, _ := h.member("bob", client.Agent, "WEB")
		file := func(title string) client.Task {
			return got(bob.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Project: ptrStr("WEB"), Title: title,
				Workspaces: &[]string{"web"}})).want(t, http.StatusCreated).JSON201.Task
		}
		write := func(c *client.ClientWithResponses, task client.Task, state client.PullRequestState) *client.SetTaskPullRequestResponse {
			res, err := c.SetTaskPullRequestWithResponse(ctx, task.Key, &client.SetTaskPullRequestParams{},
				client.SetTaskPullRequestBody{Number: 7, URL: "https://github.com/acme/web/pull/7", State: state})
			if err != nil {
				t.Fatal(err)
			}
			return res
		}

		// No Runner attached: not checked.
		if res := write(bob, file("No Runner"), client.PullRequestMerged); res.StatusCode() != http.StatusOK {
			t.Fatalf("no Runner: %s", res.Body)
		}

		var asked []string
		github := runnerapi.PullRequest{Number: 7, URL: "https://github.com/acme/web/pull/7", State: "open", Head: "web-2-checkout", Base: "main"}
		h.srv.AttachRunner(&fakeRunner{pullRequest: func(_ context.Context, task string, number int64) (runnerapi.PullRequest, error) {
			asked = append(asked, fmt.Sprintf("%s #%d", task, number))
			return github, nil
		}})
		task := file("Checkout") // WEB-2
		// open is not checked.
		if res := write(bob, task, client.PullRequestOpen); res.StatusCode() != http.StatusOK || len(asked) != 0 {
			t.Fatalf("open, asked %v: %s", asked, res.Body)
		}
		// GitHub has it open.
		res := write(bob, task, client.PullRequestMerged)
		if res.StatusCode() != http.StatusConflict || !strings.Contains(res.JSONDefault.Message, "GitHub has #7 open, not merged") {
			t.Fatalf("merged while GitHub has it open: %s", res.Body)
		}
		if len(asked) != 1 || asked[0] != task.ID+" #7" {
			t.Fatalf("the Runner was asked %v", asked)
		}
		// Merged, on another Task's branch.
		github.State, github.Head = "merged", "web-9-other"
		res = write(bob, task, client.PullRequestMerged)
		if res.StatusCode() != http.StatusBadRequest || !strings.Contains(res.JSONDefault.Message, "pull request #7's branch web-9-other is not WEB-2's") {
			t.Fatalf("another Task's branch: %s", res.Body)
		}
		// Merged, on the Task's branch: a renamed Task's branch still starts with its key.
		github.Head = "web-2-old-title"
		if res := write(bob, task, client.PullRequestMerged); res.StatusCode() != http.StatusOK || res.JSON200.PullRequest.State != client.PullRequestMerged {
			t.Fatalf("merged on the Task's branch: %s", res.Body)
		}
		// A human's write is not checked.
		asked = nil
		if res := write(ada, file("Human"), client.PullRequestMerged); res.StatusCode() != http.StatusOK || len(asked) != 0 {
			t.Fatalf("a human's write, asked %v: %s", asked, res.Body)
		}
	})
}
