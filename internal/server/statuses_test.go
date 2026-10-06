package server

import (
	"net/http"
	"slices"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Statuses through the generated client on both engines: the list and its replacement, filing
// into the Backlog, a Team Member's move and its refusals with their codes and statuses, the
// claim and handover moving the Status, the status filter on Tasks, and Activity's filters.
func TestStatusesThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "OPS", Name: "Ops"})).want(t, http.StatusCreated)
		got(ada.AddTeamMemberWithResponse(ctx, "WEB", "ada", &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
		for _, s := range []string{"build", "review"} {
			got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: s, Kind: client.Generic, Body: s})).
				want(t, http.StatusCreated)
		}
		bob, bobID := h.member("bob", client.Agent, "WEB", "build", "breakdown")
		outsider, _ := h.member("olga", client.Human, "OPS")

		list := got(bob.ListStatusesWithResponse(ctx)).want(t, http.StatusOK).JSON200.Items
		ids := map[string]string{}
		var names []string
		for _, s := range list {
			ids[s.Name] = s.ID
			names = append(names, s.Name)
		}
		if want := []string{"Backlog", "Todo", "In progress", "In review", "Done", "Dropped"}; !slices.Equal(names, want) {
			t.Fatalf("Statuses %q", names)
		}

		f := got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Checkout"})).
			want(t, http.StatusCreated).JSON201
		later := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Later",
			Skill: ptrStr("build"), Status: ptrStr("Backlog")})).want(t, http.StatusCreated).JSON201
		if later.Status.Name != "Backlog" || later.Task.StatusID != ids["Backlog"] || later.Status.Kind != client.StatusKindBacklog {
			t.Fatalf("filed into %+v (%s)", later.Status, later.Task.StatusID)
		}
		takeable := got(bob.ListTakeableTasksWithResponse(ctx, &client.ListTakeableTasksParams{})).want(t, http.StatusOK).JSON200.Items
		for _, tk := range takeable {
			if tk.ID == later.Task.ID {
				t.Fatal("a Backlog Task is takeable")
			}
		}

		refused := func(res *client.SetTaskStatusResponse, err error, status int, code client.ErrorCode) {
			t.Helper()
			got(res, err).want(t, status)
			if res.JSONDefault == nil || res.JSONDefault.Code != code {
				t.Fatalf("refusal %s, want %s", res.Body, code)
			}
		}
		res, err := outsider.SetTaskStatusWithResponse(ctx, later.Task.Key, &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: "Todo"})
		refused(res, err, http.StatusForbidden, client.ErrorCodeForbidden)
		res, err = bob.SetTaskStatusWithResponse(ctx, later.Task.Key, &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: "Done"})
		refused(res, err, http.StatusConflict, client.ErrorCodeUseComplete)
		res, err = bob.SetTaskStatusWithResponse(ctx, later.Task.Key, &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: "Dropped"})
		refused(res, err, http.StatusConflict, client.ErrorCodeUseDrop)
		moved := got(bob.SetTaskStatusWithResponse(ctx, later.Task.Key, &client.SetTaskStatusParams{IdempotencyKey: key("move-1")},
			client.SetTaskStatusBody{Status: "todo"})).want(t, http.StatusOK).JSON200
		if moved.StatusID != ids["Todo"] {
			t.Fatalf("moved to %s", moved.StatusID)
		}

		// next takes the Break down first, then the Task now in Todo; each moves to In progress.
		for range 2 {
			d := got(bob.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(0), HeartbeatTimeoutSeconds: ptrInt(0)})).
				want(t, http.StatusOK).JSON200
			if d.Status.Name != "In progress" || d.Task.StatusID != ids["In progress"] {
				t.Fatalf("next answered %+v", d.Status)
			}
		}
		inProgress := got(ada.ListTasksWithResponse(ctx, &client.ListTasksParams{Status: ptrStr("In progress")})).want(t, http.StatusOK).JSON200.Items
		if len(inProgress) != 2 {
			t.Fatalf("%d Tasks in progress, want 2", len(inProgress))
		}
		handed := got(bob.HandoverTaskWithResponse(ctx, later.Task.Key, &client.HandoverTaskParams{},
			client.HandoverTaskBody{Skill: "review", Status: ptrStr("In review")})).want(t, http.StatusOK).JSON200
		if handed.StatusID != ids["In review"] {
			t.Fatalf("handed over into %s", handed.StatusID)
		}

		// The list: refusals, then a rename, an addition, and two deletions: the empty Backlog, and
		// In review with its Task moved.
		items := make([]client.StatusInput, 0, len(list))
		for _, s := range list {
			items = append(items, client.StatusInput{ID: &s.ID, Name: s.Name, Kind: s.Kind})
		}
		withoutReview := slices.Delete(slices.Clone(items), 3, 4)
		for _, r := range []struct {
			who    *client.ClientWithResponses
			body   client.SetStatusesBody
			status int
			code   client.ErrorCode
		}{
			{bob, client.SetStatusesBody{Items: items}, http.StatusForbidden, client.ErrorCodeForbidden},
			{ada, client.SetStatusesBody{Items: slices.Delete(slices.Clone(items), 1, 2)}, http.StatusBadRequest, client.ErrorCodeInvalid},
			{ada, client.SetStatusesBody{Items: withoutReview}, http.StatusConflict, client.ErrorCodeStatusInUse},
		} {
			res, err := r.who.SetStatusesWithResponse(ctx, &client.SetStatusesParams{}, r.body)
			got(res, err).want(t, r.status)
			if r.code != "" && (res.JSONDefault == nil || res.JSONDefault.Code != r.code) {
				t.Fatalf("refusal %s, want %s", res.Body, r.code)
			}
		}
		withoutReview = slices.Delete(slices.Clone(items[1:]), 2, 3)
		withoutReview[1].Name = "Doing"
		withoutReview = append(withoutReview, client.StatusInput{Name: "Blocked on vendor", Kind: client.StatusKindTodo})
		after := got(ada.SetStatusesWithResponse(ctx, &client.SetStatusesParams{IdempotencyKey: key("list-1")}, client.SetStatusesBody{
			Items: withoutReview, Moves: &map[string]string{ids["In review"]: ids["In progress"]}})).want(t, http.StatusOK).JSON200.Items
		names = nil
		for _, s := range after {
			names = append(names, s.Name)
		}
		if want := []string{"Todo", "Doing", "Done", "Dropped", "Blocked on vendor"}; !slices.Equal(names, want) {
			t.Fatalf("Statuses after the change %q, want %q", names, want)
		}
		task := got(ada.GetTaskWithResponse(ctx, later.Task.Key)).want(t, http.StatusOK).JSON200
		if task.Status.Name != "Doing" {
			t.Fatalf("the Task in In review moved to %+v", task.Status)
		}

		// Activity filtered by kind (repeated), by Member and by Team.
		page := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{
			Kind: &[]client.ActivityKind{client.ActivityKindTaskStatusSet, client.ActivityKindStatusesChanged}})).want(t, http.StatusOK).JSON200
		var kinds []client.ActivityKind
		for _, a := range page.Items {
			kinds = append(kinds, a.Kind)
		}
		if want := []client.ActivityKind{client.ActivityKindTaskStatusSet, client.ActivityKindStatusesChanged}; !slices.Equal(kinds, want) {
			t.Fatalf("filtered by kind: %v", kinds)
		}
		if a := page.Items[1]; a.SubjectType != client.SubjectTypeStatuses || a.SubjectID == "" {
			t.Fatalf("statuses.changed is about %s %s", a.SubjectType, a.SubjectID)
		}
		for _, a := range got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Member: ptrStr("bob")})).want(t, http.StatusOK).JSON200.Items {
			if a.ActorID == nil || *a.ActorID != bobID {
				t.Fatalf("bob's Activity holds %s by %v", a.Kind, a.ActorID)
			}
		}
		for _, a := range got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Team: ptrStr("OPS")})).want(t, http.StatusOK).JSON200.Items {
			t.Fatalf("OPS has no Features, yet its Activity holds %s", a.Kind)
		}
		bad := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Team: ptrStr("NOPE")})).want(t, http.StatusNotFound)
		if bad.JSONDefault == nil || bad.JSONDefault.Code != client.ErrorCodeNotFound {
			t.Fatalf("an unknown Team: %s", bad.Body)
		}
	})
}
