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
// configuration directory's), the older trust dialog, and a session at work.
func TestFindFirstRunPrompt(t *testing.T) {
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
	older := ` Do you trust the files in this folder?

 /work/repo

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
		keys                 []string
	}{
		{"trust", trust, "the folder-trust dialog", []string{"Down", "Enter"}},
		{"bypass", bypass, "the Bypass Permissions mode warning", []string{"Down", "Enter"}},
		{"older trust", older, "the folder-trust dialog", []string{"Enter"}},
		{"working", working, "", nil},
		{"text about the dialog", "the agent wrote: Is this a project you created or one you trust? Yes, I trust this folder", "", nil},
	} {
		p, keys, ok := findFirstRunPrompt(c.screen)
		if ok != (c.prompt != "") || p.Name != c.prompt || !slices.Equal(keys, c.keys) {
			t.Errorf("%s: %q %q %v, want %q %q", c.name, p.Name, keys, ok, c.prompt, c.keys)
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

// A first-run question the configuration did not prevent is answered once, with a Note; asked
// again after that, the session stops and the Task goes back with a Note saying why. Claude Code
// asks only on a terminal, so this runs in tmux.
func TestRunnerAnswersClaudeCodesFirstRunPrompts(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.agent("builder", "complete", "build")
	f.fakeClaude("builder", "complete", "always")
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	eventually(t, 30*time.Second, "WEB-3 done", func() bool { return f.task("WEB-3").Task.State == client.TaskStateDone })
	notes := notesOf(f.task("WEB-3"))
	for _, want := range []string{"The runner accepted Claude Code's first-run prompt: the folder-trust dialog.",
		"The runner accepted Claude Code's first-run prompt: the Bypass Permissions mode warning."} {
		if !strings.Contains(notes, want) {
			t.Fatalf("WEB-3's Notes lack %q:\n%s", want, notes)
		}
	}

	// The next session's Claude Code asks the same twice.
	f.fakeClaude("builder", "complete", "again")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Totals")
	eventually(t, 30*time.Second, "WEB-4 released with a Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-4")), silentPrefix+"; Claude Code showed the folder-trust dialog again after the runner accepted it")
	})
	notes = notesOf(f.task("WEB-4"))
	if !strings.Contains(notes, "The runner accepted Claude Code's first-run prompt: the folder-trust dialog.") ||
		!strings.Contains(notes, "darkory join WEB-4") {
		t.Fatalf("WEB-4's Notes:\n%s", notes)
	}
}
