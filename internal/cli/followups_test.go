package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// pr set and pr merge, attach --kind, a company Skill's Project (skill create --project, skill
// set, member show) and agent set --shifts.
func TestFollowupCommands(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		bob := in.as("bob", "bob-1")
		ada.ok("workspace", "add", "web", "--path", "/src/web", "--mode", "pull_request")
		bob.ok("file", "--project", "WEB", "--title", "Checkout", "--step", "Build", "--workspace", "web")

		// The pull request.
		bob.fails(ExitUsage, "pr", "set", "WEB-1", "--number", "7", "--link", "https://github.com/acme/web/pull/7")
		bob.fails(ExitUsage, "pr", "set", "WEB-1", "--number", "7", "--link", "https://github.com/acme/web/pull/7", "--state", "closed")
		out := bob.ok("pr", "set", "WEB-1", "--number", "7", "--link", "https://github.com/acme/web/pull/7", "--state", "open")
		if !strings.Contains(out, "WEB-1") || !strings.Contains(out, "\n  Pull request #7 open https://github.com/acme/web/pull/7\n") {
			t.Fatalf("pr set:\n%s", out)
		}
		if out := bob.ok("show", "WEB-1"); !strings.Contains(out, "\n  Pull request #7 open https://github.com/acme/web/pull/7\n") {
			t.Fatalf("show:\n%s", out)
		}
		if out := bob.ok("tasks", "--filter", "pull_request:is:open"); !strings.Contains(out, "WEB-1") {
			t.Fatalf("tasks with an open pull request:\n%s", out)
		}
		if res := ada.fails(ExitFailed, "pr", "merge", "WEB-1"); !strings.Contains(res.stderr, "no_runner") {
			t.Fatalf("pr merge without a Runner: %s", res.stderr)
		}
		var task client.TaskDetail
		bob.json(&task, "show", "WEB-1")
		var asked []string
		fake := &oneSession{session: runnerapi.Session{TaskID: task.Task.ID, MemberID: task.Task.OwnerID, SessionID: "run-1", Host: "box",
			StartedAt: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC), State: runnerapi.StateRunning}}
		fake.merge = func(_ string, number int64) error {
			asked = append(asked, fmt.Sprintf("#%d", number))
			return nil
		}
		in.srv.AttachRunner(fake)
		// Merging is a human's act: bob, an agent, owns WEB-1 and is refused.
		if res := bob.fails(ExitRefused, "pr", "merge", "WEB-1"); !strings.Contains(res.stderr, "human's act") {
			t.Fatalf("an agent merging: %s", res.stderr)
		}
		out = ada.ok("pr", "merge", "WEB-1")
		if !strings.Contains(out, "\n  Pull request #7 merged https://github.com/acme/web/pull/7\n") || fmt.Sprint(asked) != "[#7]" {
			t.Fatalf("pr merge, asked %v:\n%s", asked, out)
		}
		if out := bob.ok("show", "WEB-1"); !strings.Contains(out, "web: #7 merged") {
			t.Fatalf("show after the merge:\n%s", out)
		}

		// Evidence kind.
		file := filepath.Join(t.TempDir(), "shift-WEB-1-bob-090000.log")
		if err := os.WriteFile(file, []byte("the log"), 0o600); err != nil {
			t.Fatal(err)
		}
		bob.fails(ExitUsage, "attach", "WEB-1", file, "--kind", "screenshot")
		var ev client.Evidence
		bob.json(&ev, "attach", "WEB-1", file, "--kind", "log")
		if ev.Kind != client.EvidenceKindLog {
			t.Fatalf("attach --kind log: %+v", ev)
		}
		bob.json(&ev, "attach", "WEB-1", file)
		if ev.Kind != client.EvidenceKindEvidence {
			t.Fatalf("attach: %+v", ev)
		}
		if out := bob.ok("show", "WEB-1"); strings.Count(out, "Shift log") != 1 {
			t.Fatalf("show lists one Shift log:\n%s", out)
		}

		// A company Skill's Project.
		out = ada.ok("skill", "create", "web-qa", "--kind", "company", "--base", "qa", "--project", "WEB", "--body", "QA here.")
		if !strings.Contains(out, "on qa, Project WEB") {
			t.Fatalf("skill create --project:\n%s", out)
		}
		ada.fails(ExitUsage, "skill", "set", "web-qa")
		bob.fails(ExitRefused, "skill", "set", "web-qa", "--project", "")
		if out := ada.ok("skill", "set", "web-qa", "--project", ""); strings.Contains(out, "Project") {
			t.Fatalf("skill set to the Organisation:\n%s", out)
		}
		ada.ok("skill", "set", "web-qa", "--project", "WEB")
		if out := ada.ok("skill", "show", "web-qa"); !strings.Contains(out, "Project WEB") {
			t.Fatalf("skill show:\n%s", out)
		}
		ada.ok("grant", "bob", "web-qa")
		if out := ada.ok("member", "show", "bob"); !strings.Contains(out, "web-qa (WEB)") {
			t.Fatalf("member show:\n%s", out)
		}

		// Shifts at once.
		ada.fails(ExitUsage, "agent", "set", "bob", "--shifts", "9")
		if out := ada.ok("agent", "set", "bob", "--shifts", "3"); !strings.Contains(out, ", 3 Shifts at once") {
			t.Fatalf("agent set --shifts:\n%s", out)
		}
	})
}
