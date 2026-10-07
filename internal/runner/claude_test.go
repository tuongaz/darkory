package runner

import (
	"encoding/json"
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

// An agent's configuration directory keeps what Claude Code wrote there, gains the session's
// folders as trusted and onboarding as done, forgets the folders of Tasks gone, and has settings
// of the runner's alone.
func TestPrepareClaude(t *testing.T) {
	data := t.TempDir()
	dir := ClaudeConfigDir(data, "builder")
	workspaces := filepath.Join(data, "workspaces")
	kept, gone := filepath.Join(workspaces, "WEB-2", "web"), filepath.Join(workspaces, "WEB-1", "web")
	if err := os.MkdirAll(kept, 0o700); err != nil {
		t.Fatal(err)
	}
	// A folder reached through a link is trusted by its real path too, as Claude Code looks it up.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	real, _ = filepath.EvalSymlinks(real)
	writeTestFile(t, filepath.Join(dir, ".claude.json"), `{"oauthAccount": {"emailAddress": "a@example.com"}, "numStartups": 4,
		"projects": {"/elsewhere": {"allowedTools": ["Bash"]}, "`+kept+`": {"lastCost": 0.1, "hasTrustDialogAccepted": true},
		"`+gone+`": {"hasTrustDialogAccepted": true}}}`)
	writeTestFile(t, filepath.Join(dir, "settings.json"), `{"hooks": {"Stop": []}, "statusLine": {"type": "command"}}`)

	if err := prepareClaude(dir, []string{"/repo/web", link}, true, workspaces); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		OAuthAccount map[string]any            `json:"oauthAccount"`
		Startups     int                       `json:"numStartups"`
		Onboarded    bool                      `json:"hasCompletedOnboarding"`
		Projects     map[string]map[string]any `json:"projects"`
	}
	readTestJSON(t, filepath.Join(dir, ".claude.json"), &doc)
	if doc.OAuthAccount["emailAddress"] != "a@example.com" || doc.Startups != 4 || !doc.Onboarded {
		t.Fatalf("Claude Code's own fields: %+v", doc)
	}
	var trusted []string
	for p, e := range doc.Projects {
		if e["hasTrustDialogAccepted"] == true {
			trusted = append(trusted, p)
		}
	}
	slices.Sort(trusted)
	want := []string{"/repo/web", kept, link, real}
	slices.Sort(want)
	if !slices.Equal(trusted, want) {
		t.Fatalf("trusted %q, want %q", trusted, want)
	}
	if doc.Projects["/elsewhere"]["allowedTools"] == nil || doc.Projects[kept]["lastCost"] != 0.1 {
		t.Fatalf("the projects' own fields: %+v", doc.Projects)
	}
	if _, ok := doc.Projects[gone]; ok {
		t.Fatalf("a gone Task's folder is still there: %+v", doc.Projects)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "settings.json"))
	if got := strings.Join(strings.Fields(string(b)), ""); got != `{"skipDangerousModePermissionPrompt":true}` {
		t.Fatalf("settings.json: %s", b)
	}
	for _, f := range []string{".claude.json", "settings.json"} {
		if st, err := os.Stat(filepath.Join(dir, f)); err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v, %v", f, st, err)
		}
	}
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("the directory: %v, %v", st, err)
	}

	// An agent that is not unattended accepts nothing; a file Claude Code left unreadable starts
	// again.
	writeTestFile(t, filepath.Join(dir, ".claude.json"), `{"projects": `)
	if err := prepareClaude(dir, []string{"/repo/web"}, false, workspaces); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(filepath.Join(dir, "settings.json"))
	if got := strings.Join(strings.Fields(string(b)), ""); got != `{}` {
		t.Fatalf("settings.json: %s", b)
	}
	readTestJSON(t, filepath.Join(dir, ".claude.json"), &doc)
	if !doc.Onboarded || doc.Projects["/repo/web"]["hasTrustDialogAccepted"] != true {
		t.Fatalf("after an unreadable file: %+v", doc)
	}
}

func readTestJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v\n%s", path, err, b)
	}
}

// The session keeps the person's sign-in: where their Claude Code keeps it, by the variables of
// the runner's environment.
func TestClaudeEnv(t *testing.T) {
	for _, c := range []struct {
		environ []string
		secure  string
	}{
		{nil, ""},
		{[]string{"CLAUDE_CONFIG_DIR=/home/a/.claude-work"}, "/home/a/.claude-work"},
		{[]string{"CLAUDE_CONFIG_DIR=/home/a/.claude-work", "CLAUDE_SECURESTORAGE_CONFIG_DIR=/home/a/.keys"}, "/home/a/.keys"},
		{[]string{"CLAUDE_CONFIG_DIR=/home/a/.claude-work", "CLAUDE_SECURESTORAGE_CONFIG_DIR="}, ""},
	} {
		got := claudeEnv("/data/claude/builder", c.environ)
		want := []string{"CLAUDE_CONFIG_DIR=/data/claude/builder", "CLAUDE_SECURESTORAGE_CONFIG_DIR=" + c.secure}
		if !slices.Equal(got, want) {
			t.Errorf("claudeEnv with %q: %q, want %q", c.environ, got, want)
		}
	}
}

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

// Claude Code runs in a configuration directory of the agent's own under the Install's data,
// which trusts the session's folders and accepts the permission skip before it starts, so it
// asks nothing: the fake one asks as Claude Code does unless that directory says otherwise.
func TestRunnerGivesClaudeCodeItsOwnConfiguration(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.agent("builder", "complete", "build")
		f.fakeClaude("builder", "complete", "claude")
		f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
		f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
		r := f.run("builder")

		eventually(t, 30*time.Second, "WEB-3 done", func() bool { return f.task("WEB-3").Task.State == client.TaskStateDone })
		eventually(t, 10*time.Second, "the session to end", func() bool { return len(r.Running()) == 0 })
		if notes := notesOf(f.task("WEB-3")); strings.Contains(notes, "first-run prompt") {
			t.Fatalf("the runner had to answer a first-run prompt:\n%s", notes)
		}
		dir := ClaudeConfigDir(f.data, "builder")
		var doc struct {
			Projects map[string]map[string]any `json:"projects"`
		}
		readTestJSON(t, filepath.Join(dir, ".claude.json"), &doc)
		repo, _ := filepath.EvalSymlinks(f.repo)
		if doc.Projects[filepath.Join(TaskDir(f.data, "WEB-3"), "web")] == nil || doc.Projects[repo]["hasTrustDialogAccepted"] != true {
			t.Fatalf("the trusted folders: %v", doc.Projects)
		}
	})
}

// A first-run dialog the configuration did not prevent is accepted, once per session and only
// before the agent's first turn, with a Note. A second one is left to a person: the session waits
// and a Note says to join it. Claude Code asks only on a terminal, so this runs in tmux.
func TestRunnerAnswersOneFirstRunPrompt(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.timings.Stale = time.Minute
	f.agent("builder", "complete", "build")
	f.fakeClaude("builder", "complete", "trust")
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	eventually(t, 30*time.Second, "WEB-3 done", func() bool { return f.task("WEB-3").Task.State == client.TaskStateDone })
	if notes := notesOf(f.task("WEB-3")); !strings.Contains(notes, "The runner accepted Claude Code's first-run prompt: the folder-trust dialog.") {
		t.Fatalf("WEB-3's Notes:\n%s", notes)
	}

	// The next session's Claude Code asks twice: the second time is a person's to answer.
	f.fakeClaude("builder", "complete", "again")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Totals")
	waitingForAPerson(t, f, r, "WEB-4")
	n := 0
	for l := range strings.Lines(f.log.String()) {
		if strings.Contains(l, "accepting it") && strings.Contains(l, " task=WEB-4 ") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("the runner accepted %d dialogs on WEB-4, not the first alone", n)
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
	f.agent("builder", "complete", "build")
	f.fakeClaude("builder", "complete", "late")
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	waitingForAPerson(t, f, r, "WEB-3")
	// Ten more checks, and still no key.
	time.Sleep(10 * f.timings.Tick)
	if strings.Contains(f.log.String(), "accepting it") || strings.Contains(notesOf(f.task("WEB-3")), "accepted Claude Code's first-run prompt") {
		t.Fatalf("the runner answered a dialog after the first turn:\n%s", notesOf(f.task("WEB-3")))
	}
	if b, _ := os.ReadFile(filepath.Join(f.data, "sessions", "WEB-3", "pane.log")); strings.Contains(string(b), "the dialog was answered") ||
		!strings.Contains(string(b), "Yes, I trust this folder") {
		t.Fatalf("the session's pane:\n%s", tail(string(b), 30))
	}
}

// waitingForAPerson waits until task's session shows a dialog the runner leaves to a person: the
// session waiting, and a Note saying to join it.
func waitingForAPerson(t *testing.T, f *fixture, r *Runner, task string) {
	t.Helper()
	eventually(t, 30*time.Second, task+"'s session waiting for a person", func() bool {
		return slices.ContainsFunc(r.Running(), func(s RunnerSession) bool { return s.Task == task && s.State == StateWaiting }) &&
			strings.Contains(notesOf(f.task(task)), "Claude Code shows the folder-trust dialog, which the runner does not answer")
	})
	if notes := notesOf(f.task(task)); !strings.Contains(notes, "darkory join "+task) {
		t.Fatalf("%s's Notes:\n%s", task, notes)
	}
}
