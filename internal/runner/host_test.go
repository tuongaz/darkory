package runner

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// spec is a session that prints its environment's DK_TEST, echoes one line typed into it, then
// exits with status 3.
func hostSpec(t *testing.T, name string) Spec {
	dir := t.TempDir()
	return Spec{Name: name, Argv: []string{"/bin/sh", "-c", `echo "env $DK_TEST"; read line; echo "got $line"; exit 3`}, Dir: dir,
		Env: []string{"DK_TEST=it's here"}, SessionDir: dir, Log: filepath.Join(dir, "pane.log")}
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
	t.Cleanup(func() { exec.Command("tmux", "-L", h.socket, "kill-server").Run() })
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

func TestTail(t *testing.T) {
	raw := "\x1b[2J\x1b[Hstarting\r\n\x1b]0;title\x07progress 10%\rprogress 100%\n\n\x1b[1mdone\x1b[0m   \n"
	if got := tail(raw, 2); got != "progress 100%\ndone" {
		t.Fatalf("got %q", got)
	}
	if got := tail(raw, 10); got != "starting\nprogress 100%\ndone" {
		t.Fatalf("got %q", got)
	}
}
