package server

import (
	"net/http"
	"slices"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// GET /v1/activity?task=: a Parent's entries with its Subtasks', by key or id, composed with
// kind; a Task that is not there is not_found.
func TestActivityAboutATaskThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddProjectMemberWithResponse(ctx, "WEB", "ada", &client.AddProjectMemberParams{})).want(t, http.StatusNoContent)
		parent := h.file(ada, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout", Breakdown: ptrBool(true)})
		pay := h.file(ada, client.FileTaskBody{Parent: &parent.Task.Key, Title: "Pay"})
		other := h.file(ada, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Search"})

		subjects := func(p client.ListActivityParams) []string {
			t.Helper()
			page := got(ada.ListActivityWithResponse(ctx, &p)).want(t, http.StatusOK).JSON200
			var out []string
			for _, a := range page.Items {
				out = append(out, string(a.Kind)+" "+a.SubjectID)
			}
			return out
		}
		filed := []client.ActivityKind{client.ActivityKindTaskFiled}
		want := []string{"task.filed " + parent.Task.ID, "task.filed " + parent.Subtasks[0].ID, "task.filed " + pay.Task.ID}
		for _, ref := range []string{parent.Task.Key, parent.Task.ID} {
			if got := subjects(client.ListActivityParams{Task: &ref, Kind: &filed}); !slices.Equal(got, want) {
				t.Fatalf("task=%s: %q, want %q", ref, got, want)
			}
		}
		if got := subjects(client.ListActivityParams{Task: &other.Task.Key, Project: ptrStr("WEB")}); !slices.Equal(got, []string{"task.filed " + other.Task.ID}) {
			t.Fatalf("task=%s: %q", other.Task.Key, got)
		}
		res := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Task: ptrStr("WEB-999")})).want(t, http.StatusNotFound)
		if res.JSONDefault == nil || res.JSONDefault.Code != client.ErrorCodeNotFound {
			t.Fatalf("an unknown Task: %s", res.Body)
		}
	})
}
