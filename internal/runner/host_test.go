package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// spec is a session that prints its environment's DK_TEST, echoes one line typed into it, then
// exits with status 3.
func hostSpec(t *testing.T, name string) Spec {
	dir := t.TempDir()
	return Spec{Name: name, Argv: []string{"/bin/sh", "-c", `echo "env $DK_TEST"; read line; echo "got $line"; exit 3`}, Dir: dir,
		Env: append(baseEnv(os.Environ()), "DK_TEST=it's here"), SessionDir: dir, Log: filepath.Join(dir, "pane.log")}
}

func waitDone(t *testing.T, p Proc) {
	t.Helper()
	select {
	case <-p.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the session did not end")
	}
}

func TestChildHost(t *testing.T) {
	s := hostSpec(t, "dk-WEB-1")
	p, err := childHost{}.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Type("hello there"); err != nil {
		t.Fatal(err)
	}
	waitDone(t, p)
	if p.ExitCode() != 3 || p.Tmux() {
		t.Fatalf("exit %d, tmux %v", p.ExitCode(), p.Tmux())
	}
	if got := p.Screen(5); got != "env it's here\ngot hello there" {
		t.Fatalf("screen %q", got)
	}
	// Kill ends a session that would run on.
	s = hostSpec(t, "dk-WEB-2")
	s.Argv = []string{"/bin/sh", "-c", "sleep 60 & sleep 60"}
	p, err = childHost{}.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, p)
}

// The tmux host runs a session on the runner's own tmux server, logs its pane, takes typed
// lines, and tells its end and exit status. It needs tmux.
func TestTmuxHost(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	h := &tmuxHost{socket: TmuxSocket(t.TempDir()), every: 50 * time.Millisecond}
	t.Cleanup(func() { killTmux(h.socket) })
	s := hostSpec(t, "dk-WEB-1")
	p, err := h.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Tmux() {
		t.Fatal("not in tmux")
	}
	if out, err := exec.Command("tmux", "-L", h.socket, "has-session", "-t", "=dk-WEB-1").CombinedOutput(); err != nil {
		t.Fatalf("no tmux session dk-WEB-1: %s", out)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(p.Screen(5), "env it's here") {
		if time.Now().After(deadline) {
			t.Fatalf("the session shows %q", p.Screen(5))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := p.Type("hello there"); err != nil {
		t.Fatal(err)
	}
	waitDone(t, p)
	if p.ExitCode() != 3 {
		t.Fatalf("exit %d", p.ExitCode())
	}
	b, _ := os.ReadFile(s.Log)
	if log := tail(string(b), 5); !strings.Contains(log, "env it's here") || !strings.Contains(log, "got hello there") {
		t.Fatalf("the pane's log: %q", log)
	}
	// The token went in a file only this user reads, not on tmux's command line.
	if st, err := os.Stat(filepath.Join(s.SessionDir, "env.sh")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("env.sh: %v, %v", st, err)
	}

	// Kill ends it.
	s = hostSpec(t, "dk-WEB-2")
	s.Argv = []string{"/bin/sh", "-c", "sleep 60"}
	p, err = h.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	waitDone(t, p)
	if p.ExitCode() != -1 {
		t.Fatalf("a killed session's exit %d", p.ExitCode())
	}
}

// killTmux stops a tmux server and removes its socket, which tmux leaves behind.
func killTmux(socket string) {
	exec.Command("tmux", "-L", socket, "kill-server").Run()
	dir := os.Getenv("TMUX_TMPDIR")
	if dir == "" {
		dir = "/tmp"
	}
	os.Remove(filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), socket))
}

// A session keeps a few of the runner's variables, not the nesting markers of a serve started
// inside Claude Code or a person's tmux.
func TestBaseEnv(t *testing.T) {
	got := baseEnv([]string{"PATH=/bin", "HOME=/home/a", "LC_ALL=en_AU.UTF-8", "ANTHROPIC_API_KEY=k", "TMPDIR=/tmp/a", "SSH_AUTH_SOCK=/s",
		"CLAUDECODE=1", "CLAUDE_CODE_SESSION_ID=x", "CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CONFIG_DIR=/home/a/.c", "TMUX=/tmp/tmux-1/default,1,0",
		"TMUX_PANE=%1", "DARKORY_TOKEN=dk_admin", "DARKORY_NO_UPDATE_CHECK=1", "SECRET=s", "weird"})
	want := []string{"PATH=/bin", "HOME=/home/a", "LC_ALL=en_AU.UTF-8", "ANTHROPIC_API_KEY=k", "TMPDIR=/tmp/a", "SSH_AUTH_SOCK=/s",
		"DARKORY_NO_UPDATE_CHECK=1"}
	if !slices.Equal(got, want) {
		t.Fatalf("baseEnv kept %q, want %q", got, want)
	}
	// DARKORY_RUNNER_ENV names more.
	got = baseEnv([]string{"HOME=/home/a", "GH_TOKEN=g", "STRIPE_KEY=s", "OTHER=o", "DARKORY_RUNNER_ENV=GH_TOKEN, STRIPE_KEY"})
	if want := []string{"HOME=/home/a", "GH_TOKEN=g", "STRIPE_KEY=s"}; !slices.Equal(got, want) {
		t.Fatalf("baseEnv with DARKORY_RUNNER_ENV kept %q, want %q", got, want)
	}
}

// envProbe prints the variables a nested Claude Code or a person's tmux would leave behind.
const envProbe = `echo "CLAUDECODE=[$CLAUDECODE] ENTRY=[$CLAUDE_CODE_ENTRYPOINT] TMUX=[$TMUX] PANE=[$TMUX_PANE] KEPT=[$DK_TEST]"; exit 0`

func TestChildHostEnvironment(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
	s := hostSpec(t, "dk-WEB-1")
	s.Argv = []string{"/bin/sh", "-c", envProbe}
	p, err := childHost{}.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	waitDone(t, p)
	if got := p.Screen(5); got != "CLAUDECODE=[] ENTRY=[] TMUX=[] PANE=[] KEPT=[it's here]" {
		t.Fatalf("the session's environment: %q", got)
	}
}

// A tmux pane starts with the session's environment alone, even on a tmux server whose own
// environment carries Claude Code's markers.
func TestTmuxHostEnvironment(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	h := &tmuxHost{socket: TmuxSocket(t.TempDir()), every: 50 * time.Millisecond}
	t.Cleanup(func() { killTmux(h.socket) })
	server := exec.Command("tmux", "-L", h.socket, "-f", os.DevNull, "new-session", "-d", "-s", "earlier", "sleep 60")
	server.Env = append(os.Environ(), "CLAUDECODE=1", "CLAUDE_CODE_ENTRYPOINT=cli")
	if out, err := server.CombinedOutput(); err != nil {
		t.Fatalf("starting a tmux server: %v: %s", err, out)
	}
	s := hostSpec(t, "dk-WEB-1")
	s.Argv = []string{"/bin/sh", "-c", strings.Replace(envProbe, "exit 0", "sleep 60", 1)}
	p, err := h.Start(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(p.Screen(5), "KEPT=") {
		if time.Now().After(deadline) {
			t.Fatalf("the session shows %q", p.Screen(5))
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got := p.Screen(5); got != "CLAUDECODE=[] ENTRY=[] TMUX=[] PANE=[] KEPT=[it's here]" {
		t.Fatalf("the session's environment: %q", got)
	}
}

func TestTail(t *testing.T) {
	raw := "\x1b[2J\x1b[Hstarting\r\n\x1b]0;title\x07progress 10%\rprogress 100%\n\n\x1b[1mdone\x1b[0m   \n"
	if got := tail(raw, 2); got != "progress 100%\ndone" {
		t.Fatalf("got %q", got)
	}
	if got := tail(raw, 10); got != "starting\nprogress 100%\ndone" {
		t.Fatalf("got %q", got)
	}
}
