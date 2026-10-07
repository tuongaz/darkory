package runner

import (
	"os"
	"slices"
	"strings"
)

// A session starts with a small environment of the runner's making, not the server's whole one:
// a serve started inside Claude Code or a person's tmux would otherwise hand every session
// CLAUDECODE, CLAUDE_CODE_*, TMUX and the rest, and the agent's Claude Code would take itself for
// one nested in another.

// passedVars are the variables a session takes from the runner's environment, by name.
var passedVars = []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ", "SSH_AUTH_SOCK",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"DARKORY_NO_UPDATE_CHECK"}

// passedPrefixes are the families of variables a session takes: the locale, and Claude Code's
// own sign-in and endpoint for a person who uses an API key rather than signing in.
var passedPrefixes = []string{"LC_", "ANTHROPIC_"}

// claudeVars are where the person's own Claude Code keeps its configuration and sign-in, when
// they moved it from ~/.claude: a session's Claude Code is theirs, so it looks in the same place.
// HOME and USER, which find the default place and the Keychain item, pass anyway.
var claudeVars = []string{"CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"}

// EnvPassed names, comma-separated, further variables a session takes from the runner's
// environment: where a person keeps the secrets their agents need, since agent settings are every
// Member's to read.
const EnvPassed = "DARKORY_RUNNER_ENV"

// baseEnv is the part of environ a session keeps.
func baseEnv(environ []string) []string {
	names := slices.Concat(passedVars, claudeVars)
	if v, ok := lookupEnv(environ, EnvPassed); ok {
		for n := range strings.SplitSeq(v, ",") {
			names = append(names, strings.TrimSpace(n))
		}
	}
	var out []string
	for _, kv := range environ {
		k, _, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		if slices.Contains(names, k) || slices.ContainsFunc(passedPrefixes, func(p string) bool { return strings.HasPrefix(k, p) }) {
			out = append(out, kv)
		}
	}
	return out
}

// tmuxEnv is the environment the runner runs tmux with. The first tmux command starts the
// runner's tmux server, whose environment every pane inherits, so it is a session's base one;
// TMUX_TMPDIR stays so the server's socket is where `darkory join` looks.
func tmuxEnv() []string {
	env := baseEnv(os.Environ())
	if d, ok := os.LookupEnv("TMUX_TMPDIR"); ok {
		env = append(env, "TMUX_TMPDIR="+d)
	}
	return env
}

// setEnv sets k to v in env, in place of any value it had.
func setEnv(env []string, k, v string) []string {
	for i, kv := range env {
		if strings.HasPrefix(kv, k+"=") {
			env[i] = k + "=" + v
			return env
		}
	}
	return append(env, k+"="+v)
}

// lookupEnv is k's value in env.
func lookupEnv(env []string, k string) (string, bool) {
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, k+"="); ok {
			return v, true
		}
	}
	return "", false
}
