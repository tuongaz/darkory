package runner

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The dialogs as Claude Code 2.1.289 draws them (the smoke run's capture, and a fresh
// configuration directory's) are found; anything that is not exactly one is not: another folder,
// the dialog's text with Claude Code's prompt under it (an agent printing it), the choice
// already moved, the older wording, a session at work.
func TestFindFirstRunPrompt(t *testing.T) {
	folder := "/private/tmp/smoke/data/workspaces/MAIN-2/project"
	trust := `
────────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/smoke/data/workspaces/MAIN-2/project

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this
 folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel

`
	bypass := `
────────────────────────────────────────────────────────────────
  WARNING: Claude Code running in Bypass Permissions mode

  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

  https://code.claude.com/docs/en/security

  ❯ No, exit
    Yes, I accept

  Enter to confirm · Esc to cancel
`
	printed := trust + `
⏺ Bash(cat notes.txt)
────────────────────────────────
❯
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`
	older := ` Do you trust the files in this folder?

 /private/tmp/smoke/data/workspaces/MAIN-2/project

 ❯ 1. Yes, proceed
   2. No, exit

 Enter to confirm · Esc to exit
`
	working := ` ▐▛███▛█   Claude Code v2.1.289
 ⏺ Bash(make test)
────────────────────────────────
❯ Try "create a util logging.py that..."
────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`
	for _, c := range []struct {
		name, screen, prompt string
	}{
		{"trust", trust, "the folder-trust dialog"},
		{"bypass", bypass, "the Bypass Permissions mode warning"},
		{"trust for another folder", strings.Replace(trust, "MAIN-2/project", "MAIN-9/project", 1), ""},
		{"trust printed above Claude Code's prompt", printed, ""},
		{"trust with Yes highlighted", strings.NewReplacer("❯ No, exit", "  No, exit", "  Yes, I trust", "❯ Yes, I trust").Replace(trust), ""},
		{"trust with its question changed", strings.Replace(trust, "Quick safety check", "Quick check", 1), ""},
		{"older trust", older, ""},
		{"working", working, ""},
		{"the dialog's words in a line", "Is this a project you created or one you trust? ❯ No, exit Yes, I trust this folder Enter to confirm · Esc to cancel", ""},
	} {
		p, ok := findFirstRunPrompt(c.screen, "/elsewhere", folder)
		if ok != (c.prompt != "") || p.Name != c.prompt {
			t.Errorf("%s: %q %v, want %q", c.name, p.Name, ok, c.prompt)
		}
	}
}

// A transcript holds an assistant message once the agent's model has answered.
func TestHasAssistantMessage(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		name, body string
		want       bool
	}{
		{"absent", "", false},
		{"the first message only", `{"type":"custom-title"}` + "\n" + `{"type":"user","message":{"role":"user","content":"Work on Task WEB-3"}}` + "\n", false},
		{"a subagent's", `{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[]}}` + "\n", false},
		{"answered", `{"type":"user","message":{"role":"user","content":"Work"}}` + "\n" +
			`{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use"}]}}` + "\n", true},
	} {
		path := filepath.Join(dir, c.name+".jsonl")
		if c.body != "" {
			writeTestFile(t, path, c.body)
		}
		if got, err := HasAssistantMessage(path); got != c.want || err != nil {
			t.Errorf("%s: %v, %v", c.name, got, err)
		}
	}
}

// fakeClaude writes a `claude` that runs the fake agent, so the runner takes it for Claude Code,
// and makes it the agent's command, asking its first-run questions as prompt says
// (tools/fakeagent).
func (f *fixture) fakeClaude(name, scenario, prompt string) {
	f.t.Helper()
	bin := filepath.Join(f.t.TempDir(), "claude")
	writeTestFile(f.t, bin, "#!/bin/sh\nexec "+ShellQuote(fakeBin)+` "$@"`+"\n")
	if err := os.Chmod(bin, 0o700); err != nil {
		f.t.Fatal(err)
	}
	progress := filepath.Join(f.progress, "{session_id}.jsonl")
	f.ok("ada", "agent", "set", name, "--command", bin, "--model", "fake-1", "--unattended", "--progress-file", progress,
		"--arg=--prompt-file", "--arg={prompt_file}", "--arg=--progress", "--arg="+progress, "--arg=--mcp-config", "--arg={mcp_config}",
		"--env", "FAKEAGENT_SCENARIO="+scenario, "--env", asDarkory+"=1", "--env", "FAKEAGENT_PROMPT="+prompt)
}

// waitingForAPerson waits until task's session shows a dialog the runner leaves to a person: the
// session waiting, and the Note saying so.
func waitingForAPerson(t *testing.T, f *fixture, r *Runner, task, note string) {
	t.Helper()
	eventually(t, 30*time.Second, task+"'s session waiting for a person", func() bool {
		return slices.ContainsFunc(r.Running(), func(s RunnerSession) bool { return s.Task == task && s.State == StateWaiting }) &&
			strings.Contains(notesOf(f.task(task)), note)
	})
}

// Claude Code runs with the person's own configuration: their ~/.claude.json, which trusts the
// Workspace's repository they opened Claude Code in, covers the Task's worktree, and their
// settings accepted the permission skip, so the fake one, asking as Claude Code does, asks
// nothing. The runner writes none of it and makes no configuration directory of its own.
func TestRunnerUsesThePersonsClaudeCodeConfiguration(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		home := t.TempDir() // after the fixture, whose git has a HOME of its own
		t.Setenv("HOME", home)
		t.Setenv("CLAUDE_CONFIG_DIR", "")
		repo, _ := filepath.EvalSymlinks(f.repo)
		global := `{"hasCompletedOnboarding": true, "projects": {"` + repo + `": {"hasTrustDialogAccepted": true}}}`
		settings := `{"skipDangerousModePermissionPrompt": true}`
		writeTestFile(t, filepath.Join(home, ".claude.json"), global)
		writeTestFile(t, filepath.Join(home, ".claude", "settings.json"), settings)
		f.workflow(buildOnly)
		f.agent("builder", "complete", "engineer")
		f.fakeClaude("builder", "complete", "claude")
		f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
		r := f.run("builder")

		eventually(t, 30*time.Second, "WEB-1 done", func() bool { return f.task("WEB-1").Task.State == client.TaskStateDone })
		eventually(t, 10*time.Second, "the session to end", func() bool { return len(r.Running()) == 0 })
		if notes := notesOf(f.task("WEB-1")); strings.Contains(notes, "first-run") {
			t.Fatalf("the session met a first-run prompt:\n%s", notes)
		}
		for path, want := range map[string]string{filepath.Join(home, ".claude.json"): global, filepath.Join(home, ".claude", "settings.json"): settings} {
			if b, err := os.ReadFile(path); err != nil || string(b) != want {
				t.Fatalf("%s changed: %q, %v", path, b, err)
			}
		}
		if _, err := os.Stat(filepath.Join(f.data, "claude")); !os.IsNotExist(err) {
			t.Fatalf("the runner made a Claude Code configuration directory: %v", err)
		}
	})
}

// A first-run dialog of a repository never opened in Claude Code is accepted, once per session
// and only before the agent's first turn, with a Note. A second one is left to a person: the
// session waits and a Note says to join it. Claude Code asks only on a terminal, so this runs in
// tmux.
func TestRunnerAnswersOneFirstRunPrompt(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.timings.Stale = time.Minute
	f.workflow(buildOnly)
	f.agent("builder", "complete", "engineer")
	f.fakeClaude("builder", "complete", "trust")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	eventually(t, 30*time.Second, "WEB-1 done", func() bool { return f.task("WEB-1").Task.State == client.TaskStateDone })
	if notes := notesOf(f.task("WEB-1")); !strings.Contains(notes, "The runner accepted Claude Code's first-run prompt: the folder-trust dialog.") {
		t.Fatalf("WEB-1's Notes:\n%s", notes)
	}

	// The next session's Claude Code asks twice: the second time is a person's to answer.
	f.fakeClaude("builder", "complete", "again")
	f.ok("ada", "file", "--project", "WEB", "--title", "Totals")
	waitingForAPerson(t, f, r, "WEB-2", "Claude Code shows the folder-trust dialog, and the Runner accepts one first-run dialog "+
		"a Shift; a person can answer it with darkory join WEB-2.")
	n := 0
	for l := range strings.Lines(f.log.String()) {
		if strings.Contains(l, "accepting it") && strings.Contains(l, " task=WEB-2 ") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("the runner accepted %d dialogs on WEB-2, not the first alone", n)
	}
}

// What the agent prints after its first turn is never answered, even when it is the folder-trust
// dialog exactly: no key is sent, the session waits, and a Note says to join it.
func TestRunnerNeverAnswersAfterTheFirstTurn(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.timings.Stale = time.Minute
	f.workflow(buildOnly)
	f.agent("builder", "complete", "engineer")
	f.fakeClaude("builder", "complete", "late")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	waitingForAPerson(t, f, r, "WEB-1", "Claude Code shows a first-run dialog after the agent's first turn; "+
		"a person can answer it with darkory join WEB-1.")
	// Ten more checks, and still no key.
	time.Sleep(10 * f.timings.Tick)
	if strings.Contains(f.log.String(), "accepting it") || strings.Contains(notesOf(f.task("WEB-1")), "accepted Claude Code's first-run prompt") {
		t.Fatalf("the runner answered a dialog after the first turn:\n%s", notesOf(f.task("WEB-1")))
	}
	if b, _ := os.ReadFile(filepath.Join(f.data, "sessions", "WEB-1", "pane.log")); strings.Contains(string(b), "the dialog was answered") ||
		!strings.Contains(string(b), "Yes, I trust this folder") {
		t.Fatalf("the session's pane:\n%s", tail(string(b), 30))
	}
}
