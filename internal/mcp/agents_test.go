package mcp

import (
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// file_task names the Workspaces it is given, else its Parent's (model v2: a Subtask works where
// its Parent does, whatever the Project's default); show_task reads them
// back whole, path and default branch included, for the session that works the Task.
func TestWorkspaceTools(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st, server.Options{})
		ctx := t.Context()
		ada := dial(t, f.url, f.ada, "ada-setup")
		for _, name := range []string{"web", "api"} {
			must(t)(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: name, Path: "/src/" + name}))
		}
		must(t)(ada.UpdateTeamWithResponse(ctx, "WEB", &client.UpdateTeamParams{}, client.UpdateTeamBody{DefaultWorkspace: ptr("web")}))
		_, cs := f.connect("bob-mcp", Options{})

		var byDefault, named client.TaskDetail
		// model v2: a Task needing a Skill is filed at a Step (M2); an aimed one still files.
		ok(t, cs, &byDefault, "file_task", map[string]any{"feature": "WEB-1", "aimed_at": "bob", "title": "Default"})
		ok(t, cs, &named, "file_task", map[string]any{"feature": "WEB-1", "aimed_at": "bob", "title": "Named", "workspaces": []string{"api", "web"}})
		// WEB-1 was filed before WEB had a default, so it names none, and so does its Subtask.
		if len(byDefault.Workspaces) != 0 {
			t.Fatalf("by default: %+v, want WEB-1's, none", byDefault.Workspaces)
		}
		var shown client.TaskDetail
		ok(t, cs, &shown, "show_task", map[string]any{"task": named.Task.Key})
		if len(shown.Workspaces) != 2 || shown.Workspaces[0].Name != "api" || shown.Workspaces[0].Path != "/src/api" ||
			shown.Workspaces[1].DefaultBranch != "main" || shown.Task.WorkspaceIds == nil || len(*shown.Task.WorkspaceIds) != 2 {
			t.Fatalf("show_task: %+v %v", shown.Workspaces, shown.Task.WorkspaceIds)
		}
	})
}
