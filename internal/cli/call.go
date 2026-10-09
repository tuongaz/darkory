package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// call is one run of a command.
type call struct {
	ctx  context.Context
	env  Env
	cmd  command
	fs   *flag.FlagSet
	g    globals
	rest []string
	conn *remote.Conn
	// warned is set once the --token warning has been printed.
	warned bool

	members, skills, projects, workspaces, taskKeys map[string]string
	// steps are each Project's Steps and Workflows, by the Project's id.
	steps map[string]projectSteps
	// labels are each Project's Label names by id, by the Project's id.
	labels map[string]map[string]string
}

// args parses the command's flags, which may come before, between or after its arguments (a
// lone -- ends the flags), and returns the arguments; there must be at least min and, unless max
// is negative, at most max.
func (c *call) args(min, max int) ([]string, error) {
	pos, err := parseInterleaved(c.fs, c.rest)
	if err != nil {
		if err == flag.ErrHelp {
			return nil, err
		}
		return nil, usageError{err.Error()}
	}
	switch {
	case len(pos) < min:
		return nil, usagef("needs %s", c.cmd.args)
	case max >= 0 && len(pos) > max:
		return nil, usagef("unexpected %q", strings.Join(pos[max:], " "))
	}
	return pos, nil
}

func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	var tail []string
	if i := slices.Index(args, "--"); i >= 0 {
		args, tail = args[:i], args[i+1:]
	}
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
	return append(pos, tail...), nil
}

// session says whether a command needs a Session that outlives it.
type session int

const (
	// oneOff commands run in a Session of their own when none is set.
	oneOff session = iota
	// lasting commands make or keep a Claim bound to the Session, which a Session made up for one
	// command would strand, so they refuse to run without DARKORY_SESSION.
	lasting
)

// settings are the flags' settings, else the environment's.
func (c *call) settings() remote.Settings {
	s := remote.FromEnv(c.env.Getenv)
	if c.g.url != "" {
		s.URL = c.g.url
	}
	if c.g.token != "" {
		s.Token = c.g.token
	}
	if c.g.session != "" {
		s.Session = c.g.session
	}
	if c.g.insecure {
		s.Insecure = true
	}
	s.HTTPClient = c.env.HTTPClient
	return s
}

// dial connects as the Member the token names, in the Session the settings name — or, for a
// command that need not outlive it, in one made up for it.
func (c *call) dial(need session) (*remote.Conn, error) {
	s := c.settings()
	if s.Token == "" {
		return nil, usagef("no token: set DARKORY_TOKEN or pass --token (an admin issues one with darkory token issue)")
	}
	if s.Session == "" {
		if need == lasting {
			return nil, usagef(`no Session: run eval "$(darkory prime)" first, or set DARKORY_SESSION. ` +
				`A Claim with a heartbeat timeout answers only to the Session that made it, so this command will not run in a Session made up for it alone`)
		}
		s.Session, s.OneOff = remote.NewSessionID(), true
	}
	return c.connect(s)
}

// tokenFlagWarning follows a command given --token: its arguments show in the process list.
const tokenFlagWarning = "darkory: warning: --token shows the token to other processes on this machine, which can read a " +
	"command's arguments; set DARKORY_TOKEN instead"

// dialPublic connects for an operation that needs no credential.
func (c *call) dialPublic() (*remote.Conn, error) { return c.connect(c.settings()) }

func (c *call) connect(s remote.Settings) (*remote.Conn, error) {
	if err := s.CheckURL(); err != nil {
		return nil, usageError{err.Error()}
	}
	if c.g.token != "" && !c.warned {
		fmt.Fprintln(c.env.Stderr, tokenFlagWarning)
		c.warned = true
	}
	conn, err := remote.Dial(s)
	if err != nil {
		return nil, err
	}
	c.conn = conn
	return conn, nil
}

// check is remote.Check.
func check(res remote.Response, err error, ok ...int) error { return remote.Check(res, err, ok...) }

// show prints a reply: its JSON with --json, else what human writes.
func (c *call) show(body []byte, human func(w io.Writer)) error {
	if c.g.json {
		return printJSON(c.env.Stdout, body)
	}
	human(c.out())
	return nil
}

// out is standard output for text, with what other Members wrote made safe for a terminal.
func (c *call) out() io.Writer { return cleanWriter{c.env.Stdout} }

// errOut is standard error for text, made safe the same way.
func (c *call) errOut() io.Writer { return cleanWriter{c.env.Stderr} }

// printJSON prints a /v1 body indented, with the characters a terminal could act on that JSON
// leaves raw written as \u escapes (remote.CleanJSON), so it decodes exactly as the server sent it.
func printJSON(w io.Writer, body []byte) error {
	body = remote.CleanJSON(bytes.TrimSpace(body))
	if len(body) == 0 {
		body = []byte("{}")
	}
	var b bytes.Buffer
	if err := json.Indent(&b, body, "", "  "); err != nil {
		b.Reset()
		b.Write(body)
	}
	b.WriteByte('\n')
	_, err := w.Write(b.Bytes())
	return err
}

// text returns s, or standard input when s is "-".
func (c *call) text(s string) (string, error) {
	if s != "-" {
		return s, nil
	}
	b, err := io.ReadAll(c.env.Stdin)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(string(b), "\n"), nil
}

// seconds reads a duration such as 30s, 5m or a bare number of seconds, rounded up to whole
// seconds.
func seconds(s string) (int, error) {
	if n, err := strconv.Atoi(s); err == nil {
		if n < 0 {
			return 0, fmt.Errorf("%q is negative", s)
		}
		return n, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration such as 30s or 5m", s)
	}
	if d < 0 {
		return 0, fmt.Errorf("%q is negative", s)
	}
	return int(math.Ceil(d.Seconds())), nil
}

// timeoutFlag registers --timeout, the Claim's heartbeat timeout.
func (c *call) timeoutFlag() *string {
	return c.fs.String("timeout", "", "the Claim's heartbeat timeout, such as 5m; 0 for none, which binds the Claim to the Member instead of the Session (default: the token's)")
}

// claimTimeout reads --timeout: nil when unset.
func claimTimeout(s string) (*int, error) {
	if s == "" {
		return nil, nil
	}
	n, err := seconds(s)
	if err != nil {
		return nil, usagef("--timeout: %v", err)
	}
	return &n, nil
}

// needs returns the Session need of a claim with timeout: one made with no timeout is bound to
// the Member, so any Session will do.
func needs(timeout *int) session {
	if timeout != nil && *timeout == 0 {
		return oneOff
	}
	return lasting
}

func ptr[T any](v T) *T { return &v }

// opt returns a pointer to s, or nil when s is empty.
func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// optBool is a flag that is unset, true or false.
type optBool struct{ v *bool }

func (o *optBool) String() string {
	if o.v == nil {
		return ""
	}
	return strconv.FormatBool(*o.v)
}

func (o *optBool) Set(s string) error {
	b, err := strconv.ParseBool(s)
	if err != nil {
		return err
	}
	o.v = &b
	return nil
}

func (o *optBool) IsBoolFlag() bool { return true }

// member returns a Member's name for human output, or the id when it cannot be found.
func (c *call) member(id string) string {
	if c.members == nil {
		c.members = map[string]string{}
		res, err := c.conn.ListMembersWithResponse(c.ctx, &client.ListMembersParams{})
		if check(res, err, http.StatusOK) == nil {
			for _, m := range res.JSON200.Items {
				c.members[m.ID] = m.Name
			}
		}
	}
	if n, ok := c.members[id]; ok {
		return one(n)
	}
	return one(id)
}

// skill returns a Skill's name for human output, or the id when it cannot be found.
func (c *call) skill(id string) string { return one(c.skillName(id)) }

// skillName returns a Skill's name as written, or the id when it cannot be found.
func (c *call) skillName(id string) string {
	if c.skills == nil {
		c.skills = map[string]string{}
		res, err := c.conn.ListSkillsWithResponse(c.ctx, &client.ListSkillsParams{})
		if check(res, err, http.StatusOK) == nil {
			for _, s := range res.JSON200.Items {
				c.skills[s.ID] = s.Name
			}
		}
	}
	if n, ok := c.skills[id]; ok {
		return n
	}
	return id
}

// project returns a Project's key for human output, or the id when it cannot be found.
func (c *call) project(id string) string {
	if c.projects == nil {
		c.projects = map[string]string{}
		res, err := c.conn.ListProjectsWithResponse(c.ctx)
		if check(res, err, http.StatusOK) == nil {
			for _, p := range res.JSON200.Items {
				c.projects[p.ID] = p.Key
			}
		}
	}
	if n, ok := c.projects[id]; ok {
		return one(n)
	}
	return one(id)
}

// projectSteps is what human output needs of a Project's Workflows: each Step's name and the
// Workflow it is in, and each Workflow's name.
type projectSteps struct {
	names, workflowOf, workflows map[string]string
}

// stepsOf reads a Project's Workflows once per command; Step names are the Project's own, so
// they are read per Project.
func (c *call) stepsOf(projectID string) projectSteps {
	if c.steps == nil {
		c.steps = map[string]projectSteps{}
	}
	ps, ok := c.steps[projectID]
	if !ok {
		ps = projectSteps{names: map[string]string{}, workflowOf: map[string]string{}, workflows: map[string]string{}}
		res, err := c.conn.GetWorkflowWithResponse(c.ctx, projectID)
		if check(res, err, http.StatusOK) == nil {
			for _, w := range res.JSON200.Workflows {
				ps.workflows[w.ID] = w.Name
			}
			for _, s := range res.JSON200.Steps {
				ps.names[s.ID], ps.workflowOf[s.ID] = s.Name, s.WorkflowID
			}
		}
		c.steps[projectID] = ps
	}
	return ps
}

// step returns the name of a Step of a Project's Workflows for human output, or the id when it
// cannot be found.
func (c *call) step(projectID, id string) string {
	if n, ok := c.stepsOf(projectID).names[id]; ok {
		return one(n)
	}
	return one(id)
}

// stepFrom names the Step a Connector out of a Step of the Workflow from leads to: the Step alone
// within that Workflow, and as Workflow › Step into another.
func (c *call) stepFrom(projectID, from, id string) string {
	ps := c.stepsOf(projectID)
	n, ok := ps.names[id]
	if !ok {
		return one(id)
	}
	to := ps.workflowOf[id]
	return target(from, to, ps.workflows[to], n)
}

// label returns the name of a Label a Task of a Project may carry, the Project's own or the
// Organisation's, for human output; the id when it cannot be found.
func (c *call) label(projectID, id string) string {
	if c.labels == nil {
		c.labels = map[string]map[string]string{}
	}
	names, ok := c.labels[projectID]
	if !ok {
		names = map[string]string{}
		if ls, _, err := c.labelsOf(projectID); err == nil {
			for _, l := range ls {
				names[l.ID] = l.Name
			}
		}
		c.labels[projectID] = names
	}
	if n, ok := names[id]; ok {
		return one(n)
	}
	return one(id)
}

// taskKey returns a Task's display key for human output, or the id when it cannot be found.
func (c *call) taskKey(id string) string {
	if c.taskKeys == nil {
		c.taskKeys = map[string]string{}
	}
	if k, ok := c.taskKeys[id]; ok {
		return one(k)
	}
	k := id
	res, err := c.conn.GetTaskWithResponse(c.ctx, id)
	if check(res, err, http.StatusOK) == nil {
		k = res.JSON200.Task.Key
	}
	c.taskKeys[id] = k
	return one(k)
}

// me returns the caller's Member id.
func (c *call) me() (string, error) {
	res, err := c.conn.GetMeWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	return res.JSON200.Member.ID, nil
}
