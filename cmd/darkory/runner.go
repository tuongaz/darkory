package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/tuongaz/darkory/internal/cli"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/runner"
)

const runnerUsage = `Usage: darkory runner [--data dir] [--url url] [--token-dir dir] [--member name]… [--tmux auto|on|off]

Runs the Runner on its own (ADR 0013): for every agent Member whose token is in the token
directory (<data>/agents unless set), it pulls Tasks through next and works each in a session,
as darkory serve does in-process unless --runner=off. Sessions run in tmux when the machine has it.
--member limits it to the agents named. DARKORY_URL names the Install (http://127.0.0.1:7357
unless set). DARKORY_RUNNER_TIMINGS (such as wait=5s,timeout=1m) changes its clocks, for tests.

`

// runRunner is `darkory runner`.
func runRunner(args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("runner", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprint(stderr, runnerUsage)
		fs.PrintDefaults()
	}
	data := fs.String("data", or(os.Getenv("DARKORY_DATA"), config.DefaultData), "the Install's data directory, where sessions and worktrees go (DARKORY_DATA)")
	url := fs.String("url", or(os.Getenv(remote.EnvURL), remote.DefaultURL), "the Install's URL (DARKORY_URL)")
	tokenDir := fs.String("token-dir", "", "the directory of <member>.token files; default <data>/agents")
	tmux := fs.String("tmux", or(os.Getenv("DARKORY_RUNNER_TMUX"), "auto"), "run sessions in tmux: auto (when it is installed), on or off (DARKORY_RUNNER_TMUX)")
	var members names
	fs.Var(&members, "member", "run only this agent; repeat for more")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "darkory runner takes no arguments, got %q\n", fs.Args())
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	dir := *tokenDir
	if dir == "" {
		dir = runner.TokenDir(*data)
	}
	tokens, err := runner.ReadTokens(dir)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		return fmt.Errorf("no agent tokens in %s: darkory init writes them there, or put <member>.token files there yourself", dir)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	r, err := newRunner(*url, *data, tokens, members, *tmux, slog.New(slog.NewTextHandler(stderr, nil)))
	if err != nil {
		return err
	}
	return r.Run(ctx)
}

// newRunner makes the Runner for an Install's data directory.
func newRunner(url, data string, tokens []runner.Token, members []string, tmux string, log *slog.Logger) (*runner.Runner, error) {
	timings, err := runner.ParseTimings(os.Getenv("DARKORY_RUNNER_TIMINGS"))
	if err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(data)
	if err != nil {
		return nil, err
	}
	return runner.New(runner.Config{URL: url, Data: abs, Tokens: tokens, Members: members, Timings: timings, Tmux: tmux, Log: log})
}

// names collects a repeated flag.
type names []string

func (n *names) String() string     { return strings.Join(*n, ",") }
func (n *names) Set(v string) error { *n = append(*n, v); return nil }

func or(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

const joinUsage = `Usage: darkory join <task> [--readonly] [--data dir]

Joins the tmux session the Runner runs for a Task (dk-<TASK>), on the Runner's own tmux server
for the Install in the data directory. --readonly watches without typing. Detach with the tmux
prefix and d.

`

// joinSession is `darkory join <task>`: tmux attach to the Task's session.
func joinSession(args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("join", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprint(stderr, joinUsage)
		fs.PrintDefaults()
	}
	readonly := fs.Bool("readonly", false, "watch without typing")
	data := fs.String("data", or(os.Getenv("DARKORY_DATA"), config.DefaultData), "the Install's data directory (DARKORY_DATA)")
	var task string
	// The Task may come before the flags, as darkory's other commands take it.
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		task, args = args[0], args[1:]
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	if task == "" && fs.NArg() == 1 {
		task = fs.Arg(0)
	} else if fs.NArg() > 0 || task == "" {
		fs.Usage()
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		return errors.New("darkory join needs tmux, and it is not on the PATH; the session's log is in <data>/sessions/<task>/pane.log")
	}
	socket := runner.TmuxSocket(*data)
	name := runner.TmuxName(strings.ToUpper(task))
	if out, err := exec.Command(tmux, "-L", socket, "has-session", "-t", "="+name).CombinedOutput(); err != nil {
		fmt.Fprintf(stderr, "darkory join: no session %s on the Runner's tmux server for %s (%s)\n", name, *data, strings.TrimSpace(string(out)))
		return &cli.ExitError{Code: cli.ExitFailed}
	}
	argv := []string{"-L", socket, "attach-session", "-t", "=" + name}
	if *readonly {
		argv = append(argv, "-r", "-f", "ignore-size")
	}
	cmd := exec.Command(tmux, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ex *exec.ExitError
		if errors.As(err, &ex) {
			return &cli.ExitError{Code: ex.ExitCode()}
		}
		return err
	}
	return nil
}
