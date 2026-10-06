package core

import (
	"context"
	"encoding/json"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
)

// Agent settings are how the Runner starts an agent Member's sessions (ADR 0013): a command
// template, the agent's model, and whether it is paused. They live on the Member record, as JSON
// (decisions.md); the agent's token lives on disk.

// The defaults an agent's settings start from: Claude Code with the agent's model, its permission
// checks skipped, Darkory's MCP server and the prompt the Runner writes.
const (
	DefaultAgentCommand = "claude"
	DefaultAgentModel   = "claude-sonnet-5-5"
)

// DefaultAgentArgs are the default command's arguments, each a template.
var DefaultAgentArgs = []string{
	"--session-id", "{session_id}",
	"--model", "{model}",
	"--dangerously-skip-permissions",
	"--mcp-config", "{mcp_config}",
	"--append-system-prompt-file", "{prompt_file}",
}

// DefaultAgentSettings are the settings an agent has before any are changed.
func DefaultAgentSettings() AgentSettings {
	return AgentSettings{Command: DefaultAgentCommand, Args: slices.Clone(DefaultAgentArgs), Model: DefaultAgentModel,
		Env: map[string]string{}, Unattended: true}
}

// AgentChange is what SetAgentSettings changes; nil fields stay as they are. Env replaces the
// whole set; ProgressFile "" clears it.
type AgentChange struct {
	Command      *string
	Args         *[]string
	Model        *string
	Env          *map[string]string
	Unattended   *bool
	Paused       *bool
	ProgressFile *string
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// template is a command, argument or path template: printable, on one line, bounded.
func validTemplate(what, v string, max int, empty bool) error {
	if (!empty && strings.TrimSpace(v) == "") || utf8.RuneCountInString(v) > max || strings.ContainsAny(v, "\x00\n\r") {
		return refuse(CodeInvalid, "%s is 1 to %d characters on one line", what, max)
	}
	return nil
}

func (a AgentSettings) validate() error {
	if err := validTemplate("command", a.Command, 1000, false); err != nil {
		return err
	}
	if len(a.Args) > 100 {
		return refuse(CodeInvalid, "args holds at most 100 arguments")
	}
	for _, arg := range a.Args {
		if err := validTemplate("an argument", arg, 1000, true); err != nil {
			return err
		}
	}
	if err := validTemplate("model", a.Model, 200, false); err != nil {
		return err
	}
	if len(a.Env) > 100 {
		return refuse(CodeInvalid, "env holds at most 100 variables")
	}
	for k, v := range a.Env {
		if !envName.MatchString(k) {
			return refuse(CodeInvalid, "%q is not an environment variable's name", k)
		}
		// The Runner sets these for the session itself.
		if strings.HasPrefix(strings.ToUpper(k), "DARKORY_") {
			return refuse(CodeInvalid, "%s is set by the Runner; env cannot name a DARKORY_ variable", k)
		}
		if strings.ContainsRune(v, 0) || len(v) > 4096 {
			return refuse(CodeInvalid, "the value of %s is at most 4096 bytes, without NUL", k)
		}
	}
	return validTemplate("progress_file", a.ProgressFile, 1000, true)
}

// SetAgentSettings changes how the Runner starts an agent's sessions (admin). An agent with no
// settings starts from DefaultAgentSettings; a human has none.
func (s *Service) SetAgentSettings(ctx context.Context, c *auth.Caller, ref string, ch AgentChange, idem Idem) (Member, error) {
	if err := mustAdmin(c); err != nil {
		return Member{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveMember(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		m, err := getMember(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if m.Kind != "agent" {
			return nil, refuse(CodeInvalid, "%s is a human; only an agent has agent settings", m.Name)
		}
		was := DefaultAgentSettings()
		if m.Agent != nil {
			was = *m.Agent
		}
		next := was
		if ch.Command != nil {
			next.Command = *ch.Command
		}
		if ch.Args != nil {
			next.Args = slices.Clone(*ch.Args)
		}
		if ch.Model != nil {
			next.Model = *ch.Model
		}
		if ch.Env != nil {
			next.Env = maps.Clone(*ch.Env)
		}
		if ch.Unattended != nil {
			next.Unattended = *ch.Unattended
		}
		if ch.Paused != nil {
			next.Paused = *ch.Paused
		}
		if ch.ProgressFile != nil {
			next.ProgressFile = *ch.ProgressFile
		}
		if next.Args == nil {
			next.Args = []string{}
		}
		if next.Env == nil {
			next.Env = map[string]string{}
		}
		if err := next.validate(); err != nil {
			return nil, err
		}
		changed := agentChanges(was, next)
		if m.Agent == nil {
			// The first settings are recorded whole.
			changed = agentChanges(AgentSettings{}, next)
		} else if len(changed) == 0 {
			return m, nil
		}
		if err := setAgent(t, id, next, changed); err != nil {
			return nil, err
		}
		return getMember(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return Member{}, err
	}
	return res.(Member), nil
}

// agentChanges says what differs between two settings, as member.agent_changed records it: the
// new value of each field, and for env only the names of its variables.
func agentChanges(was, next AgentSettings) map[string]any {
	out := map[string]any{}
	if next.Command != was.Command {
		out["command"] = next.Command
	}
	if !slices.Equal(next.Args, was.Args) {
		out["args"] = next.Args
	}
	if next.Model != was.Model {
		out["model"] = next.Model
	}
	if !maps.Equal(next.Env, was.Env) {
		out["env"] = slices.Sorted(maps.Keys(next.Env))
	}
	if next.Unattended != was.Unattended {
		out["unattended"] = next.Unattended
	}
	if next.Paused != was.Paused {
		out["paused"] = next.Paused
	}
	if next.ProgressFile != was.ProgressFile {
		out["progress_file"] = next.ProgressFile
	}
	return out
}

// setAgent writes an agent's settings inside a write and records member.agent_changed with
// payload, the fields that changed.
func setAgent(t *tx, memberID string, a AgentSettings, payload map[string]any) error {
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if _, err := t.Exec(t.ctx, `UPDATE members SET agent = $1, updated_at = $2 WHERE org_id = $3 AND id = $4`,
		string(b), ms(t.now), t.caller.OrgID, memberID); err != nil {
		return err
	}
	return t.recordByCaller("member.agent_changed", memberID, payload)
}
