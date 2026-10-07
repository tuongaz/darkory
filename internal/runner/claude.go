package runner

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Claude Code keeps its state in a configuration directory, ~/.claude and ~/.claude.json unless
// CLAUDE_CONFIG_DIR names another. The runner gives each agent's sessions one of their own under
// the Install's data, so a session never meets the person's hooks, plugins, status line or
// CLAUDE.md, and so the runner can answer, before the session starts, the two questions Claude
// Code asks on a terminal the first time and would wait on for ever: whether the folder is
// trusted, and whether running with permissions skipped is accepted. Claude Code (2.1.289) asks
// both even with --dangerously-skip-permissions and has no flag that skips them in an
// interactive session.

// envConfigDir and envSecureStorage are Claude Code's variables for its configuration directory
// and for where its sign-in is kept. With a configuration directory of its own a session would
// keep its sign-in apart too (a Keychain item named after the directory on macOS, its
// .credentials.json elsewhere) and start signed out; CLAUDE_SECURESTORAGE_CONFIG_DIR, empty for
// the default, keeps it where the person's own Claude Code keeps it. Neither is in
// `claude --help`; checked against 2.1.289.
const (
	envConfigDir     = "CLAUDE_CONFIG_DIR"
	envSecureStorage = "CLAUDE_SECURESTORAGE_CONFIG_DIR"
)

// ClaudeConfigDir is the Claude Code configuration directory of an agent's sessions.
func ClaudeConfigDir(data, agent string) string {
	return filepath.Join(data, "claude", strings.ReplaceAll(agent, string(filepath.Separator), "-"))
}

// claudeEnv is what a session's environment gains to run Claude Code in dir: the directory, and
// the sign-in of the person who runs the Install, wherever their own Claude Code keeps it.
func claudeEnv(dir string, environ []string) []string {
	secure, ok := lookupEnv(environ, envSecureStorage)
	if !ok {
		secure, _ = lookupEnv(environ, envConfigDir)
	}
	return []string{envConfigDir + "=" + dir, envSecureStorage + "=" + secure}
}

// prepareClaude makes dir the configuration directory of a Claude Code session: its
// .claude.json says onboarding is done and each of trusted is a trusted folder, kept with what
// Claude Code wrote there in earlier sessions, and its settings.json is the runner's alone, with
// no hooks, plugins or status line, and the permission skip accepted for an unattended agent.
// Trusted folders under gone, the Install's workspaces directory, that no longer exist are
// dropped, so the file does not grow with every Task.
func prepareClaude(dir string, trusted []string, unattended bool, gone string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, ".claude.json")
	doc := map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		// Claude Code rewrites the file as it runs; one it left unreadable is started again.
		if json.Unmarshal(b, &doc) != nil || doc == nil {
			doc = map[string]any{}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	doc["hasCompletedOnboarding"] = true
	projects, _ := doc["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
	}
	if gone != "" {
		for p := range projects {
			if strings.HasPrefix(p, gone+string(filepath.Separator)) {
				if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
					delete(projects, p)
				}
			}
		}
	}
	for _, p := range trusted {
		// Claude Code looks a folder up by its real path (/tmp is /private/tmp on macOS).
		paths := []string{p}
		if real, err := filepath.EvalSymlinks(p); err == nil && real != p {
			paths = append(paths, real)
		}
		for _, p := range paths {
			entry, _ := projects[p].(map[string]any)
			if entry == nil {
				entry = map[string]any{}
			}
			entry["hasTrustDialogAccepted"] = true
			projects[p] = entry
		}
	}
	doc["projects"] = projects
	if err := writeJSON(path, doc); err != nil {
		return err
	}
	settings := map[string]any{}
	if unattended {
		settings["skipDangerousModePermissionPrompt"] = true
	}
	return writeJSON(filepath.Join(dir, "settings.json"), settings)
}

// writeJSON replaces path with v as JSON, through a file beside it, readable by this user only.
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// firstRunPrompt is one of the questions Claude Code asks on a terminal the first time, which
// would stall an unattended session: the runner's configuration directory answers them before
// the session starts, and the runner answers one it still sees, once.
type firstRunPrompt struct {
	// Name says which, in Notes.
	Name string
	// signs are what the question says, any one of them, in lower case.
	signs []string
	// accept is the choice that accepts, any one of them, in lower case.
	accept []string
}

var firstRunPrompts = []firstRunPrompt{
	{Name: "the folder-trust dialog", signs: []string{"is this a project you created or one you trust", "do you trust the files in this folder"},
		accept: []string{"yes, i trust this folder", "yes, proceed"}},
	{Name: "the Bypass Permissions mode warning", signs: []string{"running in bypass permissions mode"}, accept: []string{"yes, i accept"}},
}

// promptCursor marks the highlighted choice of Claude Code's dialogs.
const promptCursor = "❯"

// findFirstRunPrompt finds a first-run prompt on screen, the session's screen as shown, and the
// keys that move to its accepting choice and choose it.
func findFirstRunPrompt(screen string) (firstRunPrompt, []string, bool) {
	low := strings.ToLower(screen)
	if !strings.Contains(low, "enter to confirm") {
		return firstRunPrompt{}, nil, false
	}
	for _, p := range firstRunPrompts {
		if !containsAny(low, p.signs) {
			continue
		}
		var lines []string
		for l := range strings.Lines(screen) {
			if strings.TrimSpace(l) != "" {
				lines = append(lines, strings.ToLower(l))
			}
		}
		cursor, accept := -1, -1
		for i, l := range lines {
			if strings.Contains(l, promptCursor) && cursor < 0 {
				cursor = i
			}
			if containsAny(l, p.accept) {
				accept = i
			}
		}
		if accept < 0 {
			continue
		}
		if cursor < 0 {
			// No highlighted choice to count from: the first comes before the one that accepts.
			cursor = accept - 1
		}
		var keys []string
		for i := cursor; i < accept; i++ {
			keys = append(keys, "Down")
		}
		for i := accept; i < cursor; i++ {
			keys = append(keys, "Up")
		}
		return p, append(keys, "Enter"), true
	}
	return firstRunPrompt{}, nil, false
}

func containsAny(s string, subs []string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
