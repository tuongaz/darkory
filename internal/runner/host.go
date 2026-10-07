package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A session's command runs in tmux when the machine has it, so a person can watch and join it
// (ADR 0013); without tmux it runs as a child process. Either way its output goes to the session's
// pane.log.

// Spec is what a session's command is started with.
type Spec struct {
	// Name is the tmux session's name, dk-<TASK-KEY>.
	Name string
	Argv []string
	// Dir is the working directory, the first checkout.
	Dir string
	// Env is the command's whole environment, as KEY=VALUE; in tmux, TERM is the pane's.
	Env []string
	// SessionDir is <data>/sessions/<TASK-KEY>, where the log and the host's files go.
	SessionDir string
	// Log is the output's file.
	Log string
}

// Proc is a running session.
type Proc interface {
	// Type sends text and Enter, as a person typing a line.
	Type(text string) error
	// Done is closed when the command has exited.
	Done() <-chan struct{}
	// ExitCode is the command's exit status once Done is closed; -1 when unknown.
	ExitCode() int
	// Kill ends the command at once.
	Kill() error
	// Tmux says whether the session runs in tmux, so it can be joined.
	Tmux() bool
	// Screen is the last lines the session showed.
	Screen(lines int) string
}

// Answerer is a Proc whose screen can be read as it shows now and whose Claude Code first-run
// dialog can be accepted, as a person at its terminal would: a session in tmux. It presses no
// other key, so nothing else on the screen is ever answered.
type Answerer interface {
	// Shown is the screen as it shows now, without the lines scrolled off it.
	Shown() string
	// AcceptFirstRunPrompt presses Down and Enter: from the highlighted "No, exit" to the
	// dialog's second choice, which accepts, and chooses it.
	AcceptFirstRunPrompt() error
}

// Host starts sessions.
type Host interface {
	Start(ctx context.Context, s Spec) (Proc, error)
	Tmux() bool
}

// TmuxSocket is the tmux server the runner of the Install in data uses, by name (tmux -L), so its
// sessions stay apart from a person's own tmux sessions.
func TmuxSocket(data string) string {
	abs, err := filepath.Abs(data)
	if err != nil {
		abs = data
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	sum := sha256.Sum256([]byte(abs))
	return "darkory-" + hex.EncodeToString(sum[:4])
}

// TmuxName is the tmux session of a Task.
func TmuxName(task string) string { return "dk-" + task }

// childHost runs sessions as child processes.
type childHost struct{}

func (childHost) Tmux() bool { return false }

func (childHost) Start(_ context.Context, s Spec) (Proc, error) {
	log, err := os.OpenFile(s.Log, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(s.Argv[0], s.Argv[1:]...)
	cmd.Dir = s.Dir
	cmd.Env = s.Env
	cmd.Stdout, cmd.Stderr = log, log
	newGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		log.Close()
		return nil, err
	}
	p := &child{cmd: cmd, stdin: stdin, log: s.Log, done: make(chan struct{}), code: -1}
	go func() {
		cmd.Wait() // the exit status is read from ProcessState
		log.Close()
		p.mu.Lock()
		if cmd.ProcessState != nil {
			p.code = cmd.ProcessState.ExitCode()
		}
		p.mu.Unlock()
		close(p.done)
	}()
	return p, nil
}

type child struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	log   string
	done  chan struct{}
	mu    sync.Mutex
	code  int
}

func (p *child) Type(text string) error {
	_, err := io.WriteString(p.stdin, text+"\n")
	return err
}

func (p *child) Done() <-chan struct{} { return p.done }

func (p *child) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code
}

func (p *child) Kill() error {
	select {
	case <-p.done:
		return nil
	default:
	}
	return killGroup(p.cmd)
}

func (p *child) Tmux() bool { return false }

func (p *child) Screen(lines int) string { return lastLines(p.log, lines) }

// tmuxHost runs sessions in tmux, on the runner's own tmux server. The server reads no tmux
// configuration (a person's status bar, key tables and plugins are theirs, not the agents'): it
// sets only tmuxOptions as the first session starts it.
type tmuxHost struct {
	socket string
	// every is how often a session is looked for, to tell it has ended.
	every time.Duration
}

func (h *tmuxHost) Tmux() bool { return true }

func (h *tmuxHost) tmux(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "tmux", append([]string{"-L", h.socket, "-f", os.DevNull}, args...)...)
	cmd.Env = tmuxEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("tmux %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (h *tmuxHost) Start(ctx context.Context, s Spec) (Proc, error) {
	// The environment carries the token, so it goes in a file only this user reads rather than on
	// tmux's command line, which every process can see. The pane's own TERM stays.
	var env strings.Builder
	for _, kv := range s.Env {
		k, v, _ := strings.Cut(kv, "=")
		if k != "TERM" {
			fmt.Fprintf(&env, "export %s=%s\n", k, ShellQuote(v))
		}
	}
	envFile := filepath.Join(s.SessionDir, "env.sh")
	if err := os.WriteFile(envFile, []byte(env.String()), 0o600); err != nil {
		return nil, err
	}
	exitFile, goFile := filepath.Join(s.SessionDir, "exit"), filepath.Join(s.SessionDir, "go")
	os.Remove(exitFile)
	os.Remove(goFile)
	if err := os.WriteFile(s.Log, nil, 0o600); err != nil {
		return nil, err
	}
	// The script waits for the pane's output to reach the log before it starts the command, and
	// leaves the command's exit status behind. It starts with an empty environment but the pane's
	// TERM, whatever the tmux server's own is, and takes the session's from env.sh.
	script := fmt.Sprintf("#!/bin/sh\nn=0\nwhile [ ! -e %[1]s ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done\n. %[2]s\n%[3]s\necho $? > %[4]s\n",
		ShellQuote(goFile), ShellQuote(envFile), ShellJoin(s.Argv), ShellQuote(exitFile))
	run := filepath.Join(s.SessionDir, "run.sh")
	if err := os.WriteFile(run, []byte(script), 0o700); err != nil {
		return nil, err
	}
	h.tmux(ctx, "kill-session", "-t", "="+s.Name)
	// The options come first, so the first window has them too.
	newSession := append(slices.Clone(tmuxOptions), "new-session", "-d", "-s", s.Name, "-x", "200", "-y", "50", "-c", s.Dir,
		`exec /usr/bin/env -i TERM="$TERM" /bin/sh `+ShellQuote(run))
	if _, err := h.tmux(ctx, newSession...); err != nil {
		return nil, err
	}
	if _, err := h.tmux(ctx, "pipe-pane", "-o", "-t", pane(s.Name), "cat >> "+ShellQuote(s.Log)); err != nil {
		h.tmux(ctx, "kill-session", "-t", "="+s.Name)
		return nil, err
	}
	if err := os.WriteFile(goFile, nil, 0o600); err != nil {
		return nil, err
	}
	p := &tmuxProc{h: h, name: s.Name, exitFile: exitFile, log: s.Log, done: make(chan struct{})}
	go p.watch()
	return p, nil
}

// tmuxOptions are all the runner's tmux server is configured with: no status bar (a joiner sees
// the agent's screen alone), a scrollback for the screen the runner reads, and a terminal type
// every system's terminfo knows.
var tmuxOptions = []string{
	"set-option", "-g", "status", "off", ";",
	"set-option", "-g", "history-limit", "10000", ";",
	"set-option", "-g", "default-terminal", "screen-256color", ";",
}

// pane is the target of a session's one pane, the session matched by its exact name.
func pane(session string) string { return "=" + session + ":" }

type tmuxProc struct {
	h              *tmuxHost
	name, exitFile string
	log            string
	done           chan struct{}
}

func (p *tmuxProc) watch() {
	every := p.h.every
	if every <= 0 {
		every = 500 * time.Millisecond
	}
	for {
		if _, err := p.h.tmux(context.Background(), "has-session", "-t", "="+p.name); err != nil {
			close(p.done)
			return
		}
		time.Sleep(every)
	}
}

func (p *tmuxProc) Type(text string) error {
	if _, err := p.h.tmux(context.Background(), "send-keys", "-t", pane(p.name), "-l", text); err != nil {
		return err
	}
	_, err := p.h.tmux(context.Background(), "send-keys", "-t", pane(p.name), "Enter")
	return err
}

func (p *tmuxProc) Done() <-chan struct{} { return p.done }

func (p *tmuxProc) ExitCode() int {
	b, err := os.ReadFile(p.exitFile)
	if err != nil {
		return -1
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return -1
	}
	return n
}

func (p *tmuxProc) Kill() error {
	_, err := p.h.tmux(context.Background(), "kill-session", "-t", "="+p.name)
	select {
	case <-p.done:
		return nil
	default:
	}
	return err
}

func (p *tmuxProc) Tmux() bool { return true }

func (p *tmuxProc) Shown() string {
	out, _ := p.h.tmux(context.Background(), "capture-pane", "-p", "-J", "-t", pane(p.name))
	return out
}

func (p *tmuxProc) AcceptFirstRunPrompt() error {
	if _, err := p.h.tmux(context.Background(), "send-keys", "-t", pane(p.name), "Down"); err != nil {
		return err
	}
	time.Sleep(200 * time.Millisecond)
	_, err := p.h.tmux(context.Background(), "send-keys", "-t", pane(p.name), "Enter")
	return err
}

func (p *tmuxProc) Screen(lines int) string {
	out, err := p.h.tmux(context.Background(), "capture-pane", "-p", "-J", "-t", pane(p.name), "-S", "-"+strconv.Itoa(lines*3))
	if err != nil {
		return lastLines(p.log, lines)
	}
	return tail(out, lines)
}

// ansi matches terminal escape sequences: CSI, OSC and the two-byte escapes.
var ansi = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)

// lastLines is the last n lines of the log at path with terminal escapes taken out.
func lastLines(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	off := max(st.Size()-64<<10, 0)
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	return tail(string(buf), n)
}

// tail is the last n non-blank lines of s, with escapes and carriage returns taken out.
func tail(s string, n int) string {
	s = ansi.ReplaceAllString(s, "")
	var lines []string
	for l := range strings.Lines(s) {
		if i := strings.LastIndexByte(strings.TrimRight(l, "\r\n"), '\r'); i >= 0 {
			l = l[i+1:]
		}
		if l = strings.TrimRight(l, " \t\r\n"); strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
