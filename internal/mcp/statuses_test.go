package mcp

import (
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Statuses through the MCP tools: the workflow, a Task filed into the Backlog that next passes
// over, set_status moving it out and refusing Done with use_complete, next's reply naming the
// Status, list_tasks carrying the list to read status_id by, and handover naming a Status.
func TestStatusTools(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st, server.Options{})
		_, cs := f.connect("bob-mcp", Options{})
		var list client.StatusList
		ok(t, cs, &list, "workflow", map[string]any{})
		ids := map[string]string{}
		for _, s := range list.Items {
			ids[s.Name] = s.ID
		}
		if len(list.Items) != 6 || ids["Backlog"] == "" || ids["In review"] == "" {
			t.Fatalf("workflow: %+v", list.Items)
		}

		var filed client.TaskDetail
		ok(t, cs, &filed, "file_task", map[string]any{"feature": "WEB-1", "skill": "build", "title": "Later", "status": "Backlog"})
		if filed.Status.Name != "Backlog" {
			t.Fatalf("filed into %+v", filed.Status)
		}
		// The fixture's Break down (bob owns its Feature) and Task come first; after them, the
		// Backlog Task is passed over.
		for range 2 {
			var next nextOut
			ok(t, cs, &next, "next", map[string]any{"wait_seconds": 0, "heartbeat_timeout_seconds": 0})
			if !next.Claimed || next.Task.Status.Name != "In progress" || next.Task.Task.StatusID != ids["In progress"] {
				t.Fatalf("next: %+v", next)
			}
		}
		var none nextOut
		ok(t, cs, &none, "next", map[string]any{"wait_seconds": 0})
		if none.Claimed {
			t.Fatalf("next offered the Backlog: %s", none.Task.Task.Key)
		}

		res := call(t, cs, "set_status", map[string]any{"task": filed.Task.Key, "status": "Done"})
		if !res.IsError || !strings.HasPrefix(text(res), "use_complete: ") {
			t.Fatalf("set_status Done: %s", text(res))
		}
		var moved client.Task
		ok(t, cs, &moved, "set_status", map[string]any{"task": filed.Task.Key, "status": "todo"})
		if moved.StatusID != ids["Todo"] {
			t.Fatalf("set_status: %+v", moved)
		}

		var tasks taskListOut
		ok(t, cs, &tasks, "list_tasks", map[string]any{"status": "In progress"})
		if len(tasks.Items) != 2 || tasks.Items[0].StatusID != ids["In progress"] || len(tasks.Statuses) != 6 {
			t.Fatalf("list_tasks in progress: %+v", tasks)
		}
		ok(t, cs, &tasks, "list_tasks", map[string]any{"filter": []string{"status_kind:is:in_progress", "kind:is:work"}})
		if len(tasks.Items) != 1 || tasks.Items[0].Key != "WEB-3" {
			t.Fatalf("list_tasks filtered to work in progress: %+v", tasks)
		}
		if res := call(t, cs, "list_tasks", map[string]any{"filter": []string{"status_kind:is:doing"}}); !res.IsError ||
			!strings.HasPrefix(text(res), "invalid: ") {
			t.Fatalf("list_tasks with a bad filter: %s", text(res))
		}
		var handed client.Task
		ok(t, cs, &handed, "handover", map[string]any{"task": "WEB-3", "skill": "build", "status": "In review"})
		if handed.StatusID != ids["In review"] {
			t.Fatalf("handover into %s", handed.StatusID)
		}
	})
}
