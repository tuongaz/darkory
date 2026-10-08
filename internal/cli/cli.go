// Package cli is darkory's command line: every operation of /v1, written on the generated client
// (plan invariant 9). Output is for people by default and the /v1 JSON with --json; the exit
// status says how a command ended (ExitOK … ExitNothing).
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"

	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/update"
)

// Exit statuses.
const (
	ExitOK = 0
	// ExitFailed is any failure that is not one of the others: no answer, not found, invalid…
	ExitFailed = 1
	// ExitUsage is a command used wrongly, or missing a setting it needs.
	ExitUsage = 2
	// ExitRefused is a request the record refused on one of its rules: already_claimed,
	// not_takeable, not_holder, forbidden, cycle, proposal_stale…, or a Heartbeat that found the
	// Claim gone.
	ExitRefused = 3
	// ExitNothing is `next` ending its wait with nothing claimed.
	ExitNothing = 4
)

// ExitError ends the process with Code. Run has already printed why.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return fmt.Sprintf("exit status %d", e.Code) }

// Env is what a command reads and writes besides its arguments.
type Env struct {
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	Getenv         func(string) string
	// HTTPClient sends the requests; nil for one with no timeout.
	HTTPClient *http.Client
	// Executable is the binary `heartbeat run --background` starts; "" for this one.
	Executable string
}

// OSEnv is the process's own environment.
func OSEnv() Env {
	return Env{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv}
}

// command is one CLI command.
type command struct {
	// path is the command's words, such as "project create".
	path string
	// args is the usage after the path.
	args  string
	short string
	run   func(c *call) error
	// long marks a command that runs until stopped, which skips the update notice.
	long bool
}

// commands lists every CLI command, in the order Usage shows them.
var commands []command

func init() {
	commands = slices.Concat(workCommands, projectCommands, adminCommands, agentCommands)
}

// Usage lists every CLI command; cmd/darkory prints it after the server commands.
func Usage() string {
	var b strings.Builder
	group := func(title string, cs []command) {
		fmt.Fprintf(&b, "\n%s:\n", title)
		for _, c := range cs {
			line := c.path
			if c.args != "" {
				line += " " + c.args
			}
			if len(line) > 52 {
				fmt.Fprintf(&b, "  darkory %s\n  %-60s %s\n", line, "", c.short)
				continue
			}
			fmt.Fprintf(&b, "  darkory %-52s %s\n", line, c.short)
		}
	}
	group("Work", workCommands)
	group("Projects, Workflows and Labels", projectCommands)
	group("Organisation, tokens and sign-in", adminCommands)
	group("Agents, Workspaces and the Runner", agentCommands)
	b.WriteString(`
Global flags, accepted before or after the command:
  --url url          the Install (DARKORY_URL, default ` + remote.DefaultURL + `)
  --token dk_…       the Member's token (DARKORY_TOKEN)
  --session id       this running copy's Session id (DARKORY_SESSION; darkory prime prints one)
  --json             print the /v1 JSON instead of text
  --insecure         allow a plain http:// URL to a host other than this machine, which sends the
                     token in clear text (DARKORY_INSECURE=1)
  --no-update-check  print no update notice (DARKORY_NO_UPDATE_CHECK=1)

Exit status: 0 done, 1 failed, 2 usage or a missing setting, 3 refused by a rule of the record
(already_claimed, not_takeable, not_holder, forbidden, cycle, proposal_stale…), 4 nothing to do.
Run darkory <command> --help for a command's flags.
`)
	return b.String()
}

// Handles reports whether args name a CLI command, possibly after global flags.
func Handles(args []string) bool {
	if len(args) == 0 {
		return false
	}
	if strings.HasPrefix(args[0], "-") {
		return slices.Contains([]string{"--url", "-url", "--token", "-token", "--session", "-session", "--json", "-json",
			"--no-update-check", "-no-update-check", "--insecure", "-insecure"}, strings.SplitN(args[0], "=", 2)[0])
	}
	if _, _, ok := find(args); ok {
		return true
	}
	_, group := groupOf(args)
	return len(group) > 0
}

// find returns the command args name, preferring the longest path, and the arguments after it.
func find(args []string) (command, []string, bool) {
	var best command
	var rest []string
	n := 0
	for _, c := range commands {
		words := strings.Fields(c.path)
		if len(words) > len(args) || len(words) <= n || !slices.Equal(words, args[:len(words)]) {
			continue
		}
		best, rest, n = c, args[len(words):], len(words)
	}
	return best, rest, n > 0
}

// groupOf returns the longest leading words of args that begin commands without being one, and
// those commands: `label` for `label`, `label --help` or `label sett`.
func groupOf(args []string) ([]string, []command) {
	for n := len(args); n > 0; n-- {
		var out []command
		for _, c := range commands {
			if words := strings.Fields(c.path); len(words) > n && slices.Equal(words[:n], args[:n]) {
				out = append(out, c)
			}
		}
		if len(out) > 0 {
			return args[:n], out
		}
	}
	return nil, nil
}

// globals are the flags every command takes.
type globals struct {
	url, token, session           string
	json, noUpdateCheck, insecure bool
}

func (g *globals) register(fs *flag.FlagSet) {
	fs.StringVar(&g.url, "url", g.url, "the Install's URL (DARKORY_URL)")
	fs.StringVar(&g.token, "token", g.token, "the Member's token (DARKORY_TOKEN, which other processes cannot read as they can arguments)")
	fs.StringVar(&g.session, "session", g.session, "this running copy's Session id (DARKORY_SESSION)")
	fs.BoolVar(&g.json, "json", g.json, "print the /v1 JSON")
	fs.BoolVar(&g.noUpdateCheck, "no-update-check", g.noUpdateCheck, "print no update notice")
	fs.BoolVar(&g.insecure, "insecure", g.insecure, "allow plain http:// to a host other than this machine (DARKORY_INSECURE)")
}

// Run runs the command args name, printing its output and, on failure, why. It returns nil or an
// *ExitError.
func Run(ctx context.Context, args []string, env Env) error {
	if env.Getenv == nil {
		env.Getenv = func(string) string { return "" }
	}
	if env.Stdin == nil {
		env.Stdin = strings.NewReader("")
	}
	var g globals
	lead := flag.NewFlagSet("darkory", flag.ContinueOnError)
	lead.SetOutput(io.Discard)
	g.register(lead)
	if err := lead.Parse(args); err != nil {
		fmt.Fprintf(env.Stderr, "darkory: %v\n%s", err, Usage())
		return &ExitError{ExitUsage}
	}
	cmd, rest, ok := find(lead.Args())
	if !ok {
		// A group's name alone, or with --help, such as `darkory label`: its commands, not "unknown".
		if words, group := groupOf(lead.Args()); len(group) > 0 {
			help := slices.ContainsFunc(lead.Args(), func(a string) bool { return a == "--help" || a == "-help" || a == "-h" })
			if !help {
				fmt.Fprintf(env.Stderr, "darkory: %q needs one of its commands:\n", strings.Join(words, " "))
			}
			for _, c := range group {
				fmt.Fprintf(env.Stderr, "  darkory %s %s\n      %s\n", c.path, c.args, c.short)
			}
			if help {
				return nil
			}
			return &ExitError{ExitUsage}
		}
		fmt.Fprintf(env.Stderr, "darkory: unknown command %q\n%s", strings.Join(lead.Args(), " "), Usage())
		return &ExitError{ExitUsage}
	}
	c := &call{ctx: ctx, env: env, cmd: cmd, g: g, rest: rest}
	c.fs = flag.NewFlagSet("darkory "+cmd.path, flag.ContinueOnError)
	c.fs.SetOutput(env.Stderr)
	c.fs.Usage = func() {
		fmt.Fprintf(env.Stderr, "Usage: darkory %s %s\n\n%s\n\nFlags:\n", cmd.path, cmd.args, cmd.short)
		c.fs.PrintDefaults()
	}
	c.g.register(c.fs)

	err := cmd.run(c)
	code := c.report(err)
	if !cmd.long {
		update.PrintNotice(context.WithoutCancel(ctx), c.errOut(), c.g.noUpdateCheck)
	}
	if code != ExitOK {
		return &ExitError{code}
	}
	return nil
}

// usageError is a command used wrongly.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

func usagef(format string, a ...any) error { return usageError{fmt.Sprintf(format, a...)} }

// refusal is a refusal the CLI finds in a reply that is not an error, such as a Heartbeat saying
// the Claim lapsed.
type refusal struct{ msg string }

func (e refusal) Error() string { return e.msg }

// nothing is `next` ending its wait with nothing claimed.
type nothing struct{ msg string }

func (e nothing) Error() string { return e.msg }

// report prints why a command failed and returns its exit status.
func (c *call) report(err error) int {
	if err == nil {
		return ExitOK
	}
	if errors.Is(err, flag.ErrHelp) {
		return ExitOK
	}
	var (
		ue usageError
		rf refusal
		no nothing
		re *remote.Error
	)
	switch {
	case errors.As(err, &ue):
		fmt.Fprintf(c.errOut(), "darkory %s: %s\nUsage: darkory %s %s (see --help)\n", c.cmd.path, ue.msg, c.cmd.path, c.cmd.args)
		return ExitUsage
	case errors.As(err, &no):
		if !c.g.json {
			fmt.Fprintln(c.errOut(), no.msg)
		}
		return ExitNothing
	case errors.As(err, &rf):
		c.printError("", rf.msg, nil)
		return ExitRefused
	case errors.As(err, &re):
		msg := re.Error()
		if re.Code != "" {
			msg = re.Message
		}
		if re.Code == "not_holder" && c.conn != nil && c.conn.Settings.OneOff {
			msg += " (DARKORY_SESSION is not set, so this command ran in a Session of its own; a Claim with a heartbeat timeout answers only to the Session that made it)"
		}
		c.printError(string(re.Code), msg, re.Details)
		if re.Refused() {
			return ExitRefused
		}
		return ExitFailed
	}
	c.printError("", err.Error(), nil)
	return ExitFailed
}

func (c *call) printError(code, msg string, details map[string]any) {
	if c.g.json {
		out := map[string]any{"message": msg}
		if code != "" {
			out["code"] = code
		}
		if details != nil {
			out["details"] = details
		}
		b, _ := json.Marshal(out)
		fmt.Fprintf(c.env.Stderr, "%s\n", remote.CleanJSON(b))
		return
	}
	if code != "" {
		fmt.Fprintf(c.errOut(), "darkory: %s: %s\n", one(code), msg)
		return
	}
	fmt.Fprintf(c.errOut(), "darkory: %s\n", msg)
}
