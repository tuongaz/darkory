package runner

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// DefaultCommand is the agent command when an agent's settings name none: Claude Code, run
// interactively so a person can watch or join it (ADR 0013).
const DefaultCommand = "claude"

// DefaultArgs are the arguments of DefaultCommand when an agent's settings name none. The runner
// chooses the session id, so it knows where Claude Code writes the transcript; the last argument
// is the session's first message.
var DefaultArgs = []string{
	"--session-id", "{session_id}",
	"--model", "{model}",
	"--dangerously-skip-permissions",
	"--mcp-config", "{mcp_config}",
	"--append-system-prompt-file", "{prompt_file}",
	"Work on Task {task}: the system prompt holds the Task, its record and the rules for ending it.",
}

// skipPermissions is the flag DefaultArgs drop for an agent that is not unattended.
const skipPermissions = "--dangerously-skip-permissions"

// Values fill an agent command's placeholders.
type Values struct {
	// PromptFile is the prompt the runner wrote, {prompt_file}.
	PromptFile string
	// Workspace is the session's working directory, the first checkout, {workspace}.
	Workspace string
	// SessionID is the Darkory Session, which is also Claude Code's session id, {session_id}.
	SessionID string
	// Model is the agent's model, {model}.
	Model string
	// MCPConfig is the MCP configuration file for `darkory mcp`, {mcp_config}.
	MCPConfig string
	// Task is the Task's display key, {task}.
	Task string
}

func (v Values) lookup(name string) (string, bool) {
	switch name {
	case "prompt_file":
		return v.PromptFile, true
	case "workspace":
		return v.Workspace, true
	case "session_id":
		return v.SessionID, true
	case "model":
		return v.Model, true
	case "mcp_config":
		return v.MCPConfig, true
	case "task":
		return v.Task, true
	}
	return "", false
}

var placeholder = regexp.MustCompile(`\{([a-z_]+)\}`)

// Expand fills the placeholders in s. A {word} that is not a placeholder is an error, so a typo
// in an agent's settings fails the start rather than reaching the command; other braces, as in
// JSON, pass through.
func Expand(s string, v Values) (string, error) {
	var bad string
	out := placeholder.ReplaceAllStringFunc(s, func(m string) string {
		val, ok := v.lookup(m[1 : len(m)-1])
		if !ok {
			bad = m
			return m
		}
		return val
	})
	if bad != "" {
		return "", fmt.Errorf("%s is not a placeholder; the agent command knows {prompt_file}, {workspace}, {session_id}, {model}, {mcp_config} and {task}", bad)
	}
	return out, nil
}

// Render turns an agent's command and arguments into the argv the runner starts. An empty command
// is DefaultCommand, and empty arguments for it are DefaultArgs, without the permission skip when
// the agent is not unattended. An argument that is only a placeholder with no value is left out,
// with the flag before it, so "--model {model}" disappears for an agent with no model.
func Render(command string, args []string, unattended bool, v Values) ([]string, error) {
	if command == "" {
		command = DefaultCommand
	}
	if len(args) == 0 && IsClaude(command) {
		args = DefaultArgs
		if !unattended {
			args = slices.DeleteFunc(slices.Clone(args), func(a string) bool { return a == skipPermissions })
		}
	}
	prog, err := Expand(command, v)
	if err != nil {
		return nil, err
	}
	argv := []string{prog}
	for _, a := range args {
		out, err := Expand(a, v)
		if err != nil {
			return nil, err
		}
		if out == "" && placeholder.MatchString(a) && placeholder.FindString(a) == a {
			if n := len(argv); n > 1 && strings.HasPrefix(argv[n-1], "-") {
				argv = argv[:n-1]
			}
			continue
		}
		argv = append(argv, out)
	}
	return argv, nil
}

// IsClaude says whether command runs Claude Code, whose transcript the runner reads for progress.
func IsClaude(command string) bool {
	if command == "" {
		return true
	}
	base := filepath.Base(command)
	return base == "claude" || base == "claude.exe"
}

// ShellQuote quotes s for a POSIX shell.
func ShellQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_./=:,@+%", r))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ShellJoin quotes argv into one POSIX shell command line.
func ShellJoin(argv []string) string {
	q := make([]string, len(argv))
	for i, a := range argv {
		q[i] = ShellQuote(a)
	}
	return strings.Join(q, " ")
}
