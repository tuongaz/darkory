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

	members, skills, teams map[string]string
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

// dial connects with the settings from the flags, else the environment.
func (c *call) dial(need session) (*remote.Conn, error) {
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
	s.HTTPClient = c.env.HTTPClient
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
	human(c.env.Stdout)
	return nil
}

func printJSON(w io.Writer, body []byte) error {
	body = bytes.TrimSpace(body)
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
		return n
	}
	return id
}

// skill returns a Skill's name for human output, or the id when it cannot be found.
func (c *call) skill(id string) string {
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

// team returns a Team's key for human output, or the id when it cannot be found.
func (c *call) team(id string) string {
	if c.teams == nil {
		c.teams = map[string]string{}
		res, err := c.conn.ListTeamsWithResponse(c.ctx)
		if check(res, err, http.StatusOK) == nil {
			for _, t := range res.JSON200.Items {
				c.teams[t.ID] = t.Key
			}
		}
	}
	if n, ok := c.teams[id]; ok {
		return n
	}
	return id
}

// me returns the caller's Member id.
func (c *call) me() (string, error) {
	res, err := c.conn.GetMeWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	return res.JSON200.Member.ID, nil
}
