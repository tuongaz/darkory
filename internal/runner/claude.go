package runner

import (
	"slices"
	"strings"
)

// A Claude Code session runs with the person's own Claude Code configuration: ~/.claude and
// ~/.claude.json (or the CLAUDE_CONFIG_DIR of the server's environment), their sign-in, their
// trust decisions, hooks and plugins. The runner writes none of it. A Workspace on a Local
// Install is a repository the person has opened in Claude Code already, so it is trusted, and
// Claude Code keys that trust on the repository, which the Task's worktree inherits. Only a
// repository never opened in Claude Code meets the two questions Claude Code asks on a terminal
// the first time, even with --dangerously-skip-permissions: whether the folder is trusted, and,
// for a person who never accepted it, whether running with permissions skipped is accepted.

// firstRunPrompt is one of the two questions Claude Code 2.1 asks on a terminal the first time,
// which would stall an unattended session. The runner answers one it sees on screen only within
// the limits of session.firstRun, and only when the screen is exactly that dialog: what the
// agent prints can look like anything, so nothing looser is ever answered.
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
