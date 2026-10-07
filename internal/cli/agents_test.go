package cli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// oneSession is a Runner running one session.
type oneSession struct {
	session runnerapi.Session
	nudged  []string
}

func (o *oneSession) Sessions() []runnerapi.Session { return []runnerapi.Session{o.session} }
func (o *oneSession) Nudge(task string) error {
	o.nudged = append(o.nudged, task)
	return nil
}
func (o *oneSession) Stop(string) error { return nil }
func (o *oneSession) Attach(context.Context, string, bool, *websocket.Conn) error {
	return nil
}

// gitRepo makes a git repository whose default branch is trunk, and returns a directory in it;
// it skips the test without git.
func gitRepo(t *testing.T, name string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := filepath.Join(t.TempDir(), name)
	cmd := exec.Command("git", "init", "-q", "-b", "trunk", root)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	sub := filepath.Join(root, "web")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	return sub
}

// Workspaces, Team defaults, quick Features, Tasks naming Workspaces, agent settings and the
// Runner's sessions through the CLI, against a real server on both engines.
func TestAgentCommands(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		bob := in.as("bob", "bob-1")
		ada.ok("team", "add", "WEB", "ada")
		dir := gitRepo(t, "shop")

		out := ada.ok("workspace", "add", "--path", dir)
		root, _ := filepath.EvalSymlinks(filepath.Dir(dir))
		if !strings.HasPrefix(out, "shop             git  plain        trunk          ") || !strings.Contains(out, filepath.Base(root)) {
			t.Fatalf("workspace add:\n%s", out)
		}
		var shop client.Workspace
		ada.json(&shop, "workspace", "set", "shop", "--mode", "pull_request")
		if shop.Mode != client.WorkspaceModePullRequest || shop.DefaultBranch != "trunk" {
			t.Fatalf("workspace set: %+v", shop)
		}
		bob.fails(ExitRefused, "workspace", "add", "api", "--path", "/src/api")
		ada.ok("workspace", "add", "api", "--path", "/src/api")
		if res := ada.fails(ExitUsage, "workspace", "set", "api"); !strings.Contains(res.stderr, "nothing to change") {
			t.Fatalf("workspace set with nothing: %s", res.stderr)
		}
		out = bob.ok("workspace", "list")
		if !strings.HasPrefix(out, "api              git  plain        main           /src/api\nshop ") {
			t.Fatalf("workspace list:\n%s", out)
		}

		out = ada.ok("team", "set", "WEB", "--default-workspace", "shop", "--ship-when-done")
		if out != "WEB      Web  workspace shop  ships when done\n" {
			t.Fatalf("team set:\n%q", out)
		}
		if out := bob.ok("team", "list"); !strings.Contains(out, "WEB      Web  workspace shop  ships when done\n") {
			t.Fatalf("team list:\n%s", out)
		}
		ada.fails(ExitUsage, "team", "set", "WEB")

		// model v2: quick Features and ship-when-done went with `feature create` (M2 rebuilds
		// `file` with --parent and --breakdown).
		in.seed("ada", core.NewTask{Project: ptr("WEB"), Title: "Search", Breakdown: true})
		ada.ok("file", "--feature", "WEB-1", "--aim", "ada", "--title", "Two places", "--workspace", "api", "--workspace", "shop")
		out = bob.ok("show", "WEB-3")
		if !strings.Contains(out, "\n  Workspace  api (git, main) /src/api\n             shop (git, trunk) ") {
			t.Fatalf("show with two Workspaces:\n%s", out)
		}
		var none client.TaskDetail
		ada.json(&none, "file", "--feature", "WEB-1", "--aim", "ada", "--title", "A question", "--no-workspace")
		if none.Task.WorkspaceIds != nil || len(none.Workspaces) != 0 {
			t.Fatalf("--no-workspace named %v", none.Task.WorkspaceIds)
		}
		ada.fails(ExitUsage, "file", "--feature", "WEB-1", "--aim", "ada", "--title", "Q", "--no-workspace", "--workspace", "api")
		if res := ada.fails(ExitRefused, "workspace", "remove", "api"); !strings.Contains(res.stderr, "conflict") {
			t.Fatalf("removing a named Workspace: %s", res.stderr)
		}

		out = ada.ok("agent", "set", "bob", "--model", "claude-opus-5-5", "--env", "MAX_TOKENS=64000", "--paused")
		if !strings.HasPrefix(out, "bob              paused      claude-opus-5-5      claude --session-id {session_id} --model {model} ") ||
			!strings.Contains(out, "\n  env MAX_TOKENS=64000\n") {
			t.Fatalf("agent set:\n%s", out)
		}
		ada.ok("agent", "set", "bob", "--paused=false", "--arg", "-p", "--arg", "{prompt_file}")
		out = bob.ok("agent", "list")
		if !strings.HasPrefix(out, "bob              ready       claude-opus-5-5      claude -p {prompt_file}\n") || strings.Contains(out, "ada") {
			t.Fatalf("agent list:\n%s", out)
		}
		if out := ada.ok("agent", "clear", "bob"); out != "bob              not started by the Runner\n" {
			t.Fatalf("agent clear:\n%q", out)
		}
		bob.fails(ExitRefused, "agent", "clear", "bob")
		if res := ada.fails(ExitFailed, "agent", "set", "ada", "--model", "x"); !strings.Contains(res.stderr, "human") {
			t.Fatalf("agent set on a human: %s", res.stderr)
		}
		ada.fails(ExitUsage, "agent", "set", "bob", "--env", "NOEQUALS")

		if out := bob.ok("sessions"); out != "No Runner is attached to this server; it runs no agent sessions.\n" {
			t.Fatalf("sessions without a Runner: %q", out)
		}
		if res := ada.fails(ExitFailed, "sessions", "nudge", "WEB-3"); !strings.Contains(res.stderr, "no_runner") {
			t.Fatalf("nudge without a Runner: %s", res.stderr)
		}
		var task client.TaskDetail
		bob.json(&task, "show", "WEB-3")
		fake := &oneSession{session: runnerapi.Session{TaskID: task.Task.ID, MemberID: task.Task.FiledBy, SessionID: "run-1", Host: "box",
			Tmux: "dk-WEB-3", StartedAt: time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC), State: runnerapi.StateRunning, LogPath: "/data/pane.log"}}
		in.srv.AttachRunner(fake)
		out = bob.ok("sessions")
		if out != "WEB-3     ada            running  since 2026-10-07T09:00:00Z on box, tmux dk-WEB-3, log /data/pane.log\n" {
			t.Fatalf("sessions:\n%q", out)
		}
		bob.fails(ExitRefused, "sessions", "nudge", "WEB-3")
		ada.ok("sessions", "nudge", "WEB-3")
		ada.ok("sessions", "stop", "WEB-3")
		if len(fake.nudged) != 1 || fake.nudged[0] != task.Task.ID {
			t.Fatalf("nudged %v", fake.nudged)
		}
		ada.fails(ExitFailed, "sessions", "nudge", "WEB-4")
	})
}
