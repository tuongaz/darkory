package cli

import (
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/gitinfo"
)

var agentCommands = []command{
	{path: "workspace add", args: "[name] [--path dir] [--mode plain|pull_request] [--default-branch b]", short: "add a Workspace, by default the git repository here (admin)", run: cmdWorkspaceAdd},
	{path: "workspace list", short: "list the Install's Workspaces", run: cmdWorkspaceList},
	{path: "workspace set", args: "<workspace> [--name n] [--path dir] [--mode m] [--default-branch b]", short: "change a Workspace (admin)", run: cmdWorkspaceSet},
	{path: "workspace remove", args: "<workspace>", short: "remove a Workspace no Task names (admin)", run: cmdWorkspaceRemove},
	{path: "team set", args: "<team> [--name n] [--default-workspace ws|\"\"] [--ship-when-done=true|false]", short: "change a Team's name and defaults (admin)", run: cmdTeamSet},
	{path: "agent set", args: "<member> [--command c] [--arg a]… [--model m] [--env K=V]… [--paused] [--unattended] [--progress-file f]", short: "set how the Runner starts an agent's sessions (admin)", run: cmdAgentSet},
	{path: "agent clear", args: "<member>", short: "clear an agent's settings, so the Runner starts no session for it (admin)", run: cmdAgentClear},
	{path: "agent list", short: "list the agents and how the Runner starts them", run: cmdAgentList},
	{path: "sessions", short: "list the agent sessions the Runner runs now", run: cmdSessions},
	{path: "sessions nudge", args: "<task>", short: "ask the agent in a Task's session to end the Task (admin)", run: cmdSessionsNudge},
	{path: "sessions stop", args: "<task>", short: "stop a Task's session, releasing its Claim (admin)", run: cmdSessionsStop},
}

// strs is a flag given any number of times; set says whether it was given at all.
type strs struct {
	v   []string
	set bool
}

func (s *strs) String() string { return strings.Join(s.v, ",") }

func (s *strs) Set(v string) error {
	s.v, s.set = append(s.v, v), true
	return nil
}

// optString is a flag that is unset or a string, "" included.
type optString struct{ v *string }

func (o *optString) String() string { return deref(o.v) }

func (o *optString) Set(s string) error {
	o.v = &s
	return nil
}

func (c *call) modeFlag() *string {
	return c.fs.String("mode", "", "plain (the Runner merges) or pull_request (it opens pull requests)")
}

func cmdWorkspaceAdd(c *call) error {
	path := c.fs.String("path", "", "the repository's directory (default: the git repository this command runs in)")
	mode := c.modeFlag()
	branch := c.fs.String("default-branch", "", "the branch work lands on (default: the repository's, else main)")
	args, err := c.args(0, 1)
	if err != nil {
		return err
	}
	dir := *path
	if dir == "" {
		dir = "."
	}
	if dir, err = filepath.Abs(dir); err != nil {
		return err
	}
	body := client.CreateWorkspaceBody{Path: dir, DefaultBranch: opt(*branch)}
	// The repository's own root, name and default branch, when the path is in one.
	if repo, ok := gitinfo.Find(c.ctx, dir); ok {
		body.Path = repo.Root
		if body.DefaultBranch == nil {
			body.DefaultBranch = &repo.DefaultBranch
		}
	} else if *path == "" {
		return usagef("this directory is in no git repository; give --path")
	}
	body.Name = gitinfo.Name(body.Path)
	if len(args) == 1 {
		body.Name = args[0]
	}
	if *mode != "" {
		body.Mode = ptr(client.WorkspaceMode(*mode))
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.CreateWorkspaceWithResponse(c.ctx, &client.CreateWorkspaceParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printWorkspace(w, *res.JSON201) })
}

func (c *call) printWorkspace(w io.Writer, ws client.Workspace) {
	fmt.Fprintf(w, "%-16s %-4s %-12s %-14s %s\n", one(ws.Name), one(string(ws.Kind)), one(string(ws.Mode)), one(ws.DefaultBranch), one(ws.Path))
}

func cmdWorkspaceList(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListWorkspacesWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No Workspaces. Add the git repository you are in with darkory workspace add.")
		}
		for _, ws := range res.JSON200.Items {
			c.printWorkspace(w, ws)
		}
	})
}

func cmdWorkspaceSet(c *call) error {
	name := c.fs.String("name", "", "the Workspace's new name")
	path := c.fs.String("path", "", "the repository's directory")
	mode := c.modeFlag()
	branch := c.fs.String("default-branch", "", "the branch work lands on")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.UpdateWorkspaceBody{Name: opt(*name), DefaultBranch: opt(*branch)}
	if *path != "" {
		abs, err := filepath.Abs(*path)
		if err != nil {
			return err
		}
		body.Path = &abs
	}
	if *mode != "" {
		body.Mode = ptr(client.WorkspaceMode(*mode))
	}
	if body.Name == nil && body.Path == nil && body.Mode == nil && body.DefaultBranch == nil {
		return usagef("nothing to change: give --name, --path, --mode or --default-branch")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.UpdateWorkspaceWithResponse(c.ctx, args[0], &client.UpdateWorkspaceParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printWorkspace(w, *res.JSON200) })
}

func cmdWorkspaceRemove(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RemoveWorkspaceWithResponse(c.ctx, args[0], &client.RemoveWorkspaceParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "Removed Workspace %s.\n", one(args[0])) })
}

func cmdTeamSet(c *call) error {
	name := c.fs.String("name", "", "the Team's new name")
	var ws optString
	c.fs.Var(&ws, "default-workspace", `the Workspace a Task filed in the Team names when it names none; "" for none`)
	var ship optBool
	c.fs.Var(&ship, "ship-when-done", "whether a Feature filed in the Team ships itself when its last Task is completed, unless its filer says")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.UpdateTeamBody{Name: opt(*name), DefaultWorkspace: ws.v, ShipWhenDone: ship.v}
	if body.Name == nil && body.DefaultWorkspace == nil && body.ShipWhenDone == nil {
		return usagef("nothing to change: give --name, --default-workspace or --ship-when-done")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.UpdateTeamWithResponse(c.ctx, args[0], &client.UpdateTeamParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printTeamLine(w, *res.JSON200) })
}

// printTeamLine prints a Team with its defaults.
func (c *call) printTeamLine(w io.Writer, t client.Team) {
	line := fmt.Sprintf("%-8s %s", one(t.Key), one(t.Name))
	if t.DefaultWorkspaceID != nil {
		line += "  workspace " + c.workspace(*t.DefaultWorkspaceID)
	}
	if t.ShipWhenDone {
		line += "  ships when done"
	}
	fmt.Fprintln(w, line)
}

// workspace returns a Workspace's name for human output, or the id when it cannot be found.
func (c *call) workspace(id string) string {
	if c.workspaces == nil {
		c.workspaces = map[string]string{}
		res, err := c.conn.ListWorkspacesWithResponse(c.ctx)
		if check(res, err, http.StatusOK) == nil {
			for _, ws := range res.JSON200.Items {
				c.workspaces[ws.ID] = ws.Name
			}
		}
	}
	if n, ok := c.workspaces[id]; ok {
		return one(n)
	}
	return one(id)
}

func cmdAgentSet(c *call) error {
	command := c.fs.String("command", "", "the program to start, such as claude")
	var args, env strs
	c.fs.Var(&args, "arg", "an argument of the command, in order; give it once per argument, replacing them all")
	c.fs.Var(&env, "env", "NAME=value added to the session's environment; give it once per variable, replacing them all (every Member can read them: no secrets)")
	model := c.fs.String("model", "", "the model the agent runs on, such as claude-opus-5-5")
	var paused, unattended optBool
	c.fs.Var(&paused, "paused", "start no new session for the agent (--paused=false resumes)")
	c.fs.Var(&unattended, "unattended", "run sessions with the agent's permission checks skipped")
	var progress optString
	c.fs.Var(&progress, "progress-file", `the file whose changes show a session's progress, for a command other than Claude Code; "" for none`)
	pos, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.SetAgentSettingsBody{Command: opt(*command), Model: opt(*model), Paused: paused.v, Unattended: unattended.v,
		ProgressFile: progress.v}
	if args.set {
		body.Args = &args.v
	}
	if env.set {
		vars := map[string]string{}
		for _, kv := range env.v {
			k, v, ok := strings.Cut(kv, "=")
			if !ok || k == "" {
				return usagef("--env takes NAME=value, not %q", kv)
			}
			vars[k] = v
		}
		body.Env = &vars
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.SetAgentSettingsWithResponse(c.ctx, pos[0], &client.SetAgentSettingsParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printAgent(w, *res.JSON200) })
}

// printAgent prints an agent and how the Runner starts it.
func (c *call) printAgent(w io.Writer, m client.Member) {
	a := m.Agent
	if a == nil {
		fmt.Fprintf(w, "%-16s not started by the Runner\n", one(m.Name))
		return
	}
	state := "ready"
	if a.Paused {
		state = "paused"
	}
	if m.DeactivatedAt != nil {
		state = "deactivated"
	}
	extra := ""
	if !a.Unattended {
		extra = ", attended"
	}
	fmt.Fprintf(w, "%-16s %-11s %-20s %s %s%s\n", one(m.Name), state, one(a.Model), one(a.Command), one(strings.Join(a.Args, " ")), extra)
	for _, k := range sortedKeys(a.Env) {
		fmt.Fprintf(w, "  env %s=%s\n", one(k), one(a.Env[k]))
	}
	if a.ProgressFile != nil {
		fmt.Fprintf(w, "  progress file %s\n", one(*a.ProgressFile))
	}
}

func cmdAgentClear(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ClearAgentSettingsWithResponse(c.ctx, args[0], &client.ClearAgentSettingsParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printAgent(w, *res.JSON200) })
}

func cmdAgentList(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListMembersWithResponse(c.ctx, &client.ListMembersParams{Kind: ptr(client.Agent)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No agents.")
		}
		for _, m := range res.JSON200.Items {
			c.printAgent(w, m)
		}
	})
}

func cmdSessions(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListRunnerSessionsWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		switch {
		case !res.JSON200.Runner:
			fmt.Fprintln(w, "No Runner is attached to this server; it runs no agent sessions.")
		case len(res.JSON200.Items) == 0:
			fmt.Fprintln(w, "The Runner runs no sessions now.")
		}
		for _, s := range res.JSON200.Items {
			join := "no tmux"
			if s.Tmux != nil {
				join = "tmux " + one(*s.Tmux)
			}
			fmt.Fprintf(w, "%-9s %-14s %-8s since %s on %s, %s, log %s\n", c.taskKey(s.TaskID), c.member(s.MemberID), one(string(s.State)),
				stamp(s.StartedAt), one(s.Host), join, one(s.LogPath))
		}
	})
}

// taskKey returns a Task's display key for human output, or its id when it cannot be read.
func (c *call) taskKey(id string) string {
	res, err := c.conn.GetTaskWithResponse(c.ctx, id)
	if check(res, err, http.StatusOK) != nil {
		return one(id)
	}
	return one(res.JSON200.Task.Key)
}

func cmdSessionsNudge(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.NudgeRunnerSessionWithResponse(c.ctx, args[0], &client.NudgeRunnerSessionParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "Nudged the session on %s.\n", one(args[0])) })
}

func cmdSessionsStop(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.StopRunnerSessionWithResponse(c.ctx, args[0], &client.StopRunnerSessionParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "Stopping the session on %s.\n", one(args[0])) })
}
