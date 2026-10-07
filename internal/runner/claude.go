package runner

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
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

// firstRunPrompt is one of the two questions Claude Code 2.1 asks on a terminal the first time,
// which would stall an unattended session. The runner's configuration directory answers both
// before the session starts; the runner answers one it still sees on screen only as a fallback,
// within the limits of session.firstRun, and only when the screen is exactly that dialog: what
// the agent prints can look like anything, so nothing looser is ever answered.
type firstRunPrompt struct {
	// Name says which, in Notes.
	Name string
	// before are lines the dialog shows above its choices, in order: whole lines, or the start of
	// one for a line that ends in "…". workspaceLine stands for the session's folder.
	before []string
	// accept is the second choice, the one that accepts, under the highlighted "No, exit".
	accept string
}

const workspaceLine = "\x00workspace"

var firstRunPrompts = []firstRunPrompt{
	{Name: "the folder-trust dialog", before: []string{"Accessing workspace:", workspaceLine,
		"Quick safety check: Is this a project you created or one you trust?…"}, accept: "Yes, I trust this folder"},
	{Name: "the Bypass Permissions mode warning", before: []string{"WARNING: Claude Code running in Bypass Permissions mode"},
		accept: "Yes, I accept"},
}

// findFirstRunPrompt says which first-run dialog screen, a session's screen as shown, is, if it
// is exactly one: the dialog's lines in order, and as the screen's last lines, nothing under
// them, "❯ No, exit" highlighted, the accepting choice, and "Enter to confirm · Esc to cancel".
// The folder-trust dialog must name folder, the session's working directory, by any of its
// paths. Its accepting choice is then one Down and Enter away.
func findFirstRunPrompt(screen string, folder ...string) (firstRunPrompt, bool) {
	var lines []string
	for l := range strings.Lines(screen) {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	n := len(lines)
	if n < 4 || lines[n-3] != "❯ No, exit" || lines[n-1] != "Enter to confirm · Esc to cancel" {
		return firstRunPrompt{}, false
	}
	for _, p := range firstRunPrompts {
		if lines[n-2] != p.accept {
			continue
		}
		at := 0
		for _, want := range p.before {
			for at < n-3 && !lineIs(lines[at], want, folder) {
				at++
			}
			if at == n-3 {
				return firstRunPrompt{}, false
			}
			at++
		}
		return p, true
	}
	return firstRunPrompt{}, false
}

func lineIs(line, want string, folder []string) bool {
	switch {
	case want == workspaceLine:
		return slices.Contains(folder, line)
	case strings.HasSuffix(want, "…"):
		return strings.HasPrefix(line, strings.TrimSuffix(want, "…"))
	}
	return line == want
}
