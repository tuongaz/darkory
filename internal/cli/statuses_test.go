package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Statuses through the CLI against a real server on both engines: the workflow listed and set
// from its own --json, filing into the Backlog, the Status in tasks and show, a move, its refusals
// exiting 3, and handover --status.
func TestStatusCommands(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		ada.ok("team", "add", "WEB", "ada")
		ada.ok("skill", "create", "review", "--kind", "generic", "--body", "Review it.")
		bob := in.as("bob", "bob-1")

		out := bob.ok("workflow")
		for _, want := range []string{"1   Backlog              backlog", "4   In review            in_progress", "6   Dropped              dropped"} {
			if !strings.Contains(out, want) {
				t.Fatalf("workflow lacks %q:\n%s", want, out)
			}
		}
		ada.ok("feature", "create", "--team", "WEB", "--title", "Search")
		ada.ok("file", "--feature", "WEB-1", "--skill", "build", "--title", "Later", "--status", "backlog")
		out = bob.ok("tasks", "--status", "Backlog")
		if !strings.Contains(out, "WEB-3     open          Backlog      build          Later") || strings.Count(out, "\n") != 1 {
			t.Fatalf("tasks in the Backlog:\n%s", out)
		}
		if res := bob.fails(ExitNothing, "next", "--wait", "0", "--timeout", "0"); res.stdout != "" {
			t.Fatalf("next offered the Backlog: %s", res.stdout)
		}

		res := bob.fails(ExitRefused, "status", "WEB-3", "Done")
		if !strings.Contains(res.stderr, "use_complete") {
			t.Fatalf("moving to Done: %s", res.stderr)
		}
		out = bob.ok("status", "WEB-3", "Todo")
		if !strings.HasPrefix(out, "Moved WEB-3.\nWEB-3     open          Todo ") {
			t.Fatalf("status:\n%s", out)
		}
		out = bob.ok("next", "--wait", "0", "--timeout", "0")
		if !strings.Contains(out, "\n  Status     In progress (in_progress)\n") {
			t.Fatalf("next does not show the Status:\n%s", out)
		}
		out = bob.ok("handover", "WEB-3", "--skill", "review", "--status", "in review")
		if !strings.Contains(out, " In review ") {
			t.Fatalf("handover --status:\n%s", out)
		}

		// The list as --json prints it, edited and set again: In review renamed.
		var list client.StatusList
		ada.json(&list, "workflow")
		for i := range list.Items {
			if list.Items[i].Name == "In review" {
				list.Items[i].Name = "Review"
			}
		}
		b, err := json.Marshal(list)
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(t.TempDir(), "statuses.json")
		if err := os.WriteFile(file, b, 0o600); err != nil {
			t.Fatal(err)
		}
		bob.fails(ExitRefused, "workflow", "set", "--file", file)
		out = ada.ok("workflow", "set", "--file", file)
		if !strings.Contains(out, "4   Review               in_progress") {
			t.Fatalf("workflow set:\n%s", out)
		}
		if out = ada.ok("show", "WEB-3"); !strings.Contains(out, "\n  Status     Review (in_progress)\n") {
			t.Fatalf("show after the rename:\n%s", out)
		}
	})
}
