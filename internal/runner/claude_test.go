package runner

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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
