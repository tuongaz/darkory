//go:build !windows

package runner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"

	"github.com/coder/websocket"
	"github.com/creack/pty"

	"github.com/tuongaz/darkory/internal/runnerapi"
)

// Attach bridges conn to the Task's tmux session (D6): `tmux attach` runs on a pseudo-terminal
// whose output goes to the client as binary messages, and the client's binary messages are typed
// into it unless readonly; a text message {"cols": n, "rows": n} resizes it. Someone joining to
// type is recorded in a Note on the Task. It returns when either side ends, and closes conn.
func (r *Runner) Attach(ctx context.Context, taskID string, readonly bool, conn *websocket.Conn) error {
	s := r.session(taskID)
	if s == nil {
		conn.Close(websocket.StatusPolicyViolation, "no session on this Task")
		return runnerapi.ErrNoSession
	}
	s.mu.Lock()
	proc := s.proc
	s.mu.Unlock()
	if proc == nil || !proc.Tmux() {
		conn.Close(websocket.StatusPolicyViolation, "the session runs without tmux")
		return runnerapi.ErrNotJoinable
	}
	if v, ok := runnerapi.ViewerOf(ctx); ok && !readonly {
		if err := s.rec.Note(ctx, s.key, v.Name+" joined the session."); err != nil {
			s.log.Warn("could not note who joined the session", "viewer", v.Name, "err", err)
		}
		s.log.Info("someone joined the session", "viewer", v.Name)
	}
	args := []string{"-L", r.Socket(), "attach-session", "-t", "=" + TmuxName(s.key)}
	if readonly {
		args = append(args, "-r")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", args...)
	cmd.Env = append(withoutTmux(os.Environ()), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 40})
	if err != nil {
		conn.Close(websocket.StatusInternalError, "could not start tmux attach")
		return err
	}
	defer func() {
		ptmx.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}()
	go func() {
		defer cancel()
		buf := make([]byte, 32<<10)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if typ == websocket.MessageText {
			var size struct{ Cols, Rows uint16 }
			if json.Unmarshal(data, &size) == nil && size.Cols > 0 && size.Rows > 0 {
				pty.Setsize(ptmx, &pty.Winsize{Cols: size.Cols, Rows: size.Rows})
			}
			continue
		}
		if !readonly {
			if _, err := ptmx.Write(data); err != nil {
				break
			}
		}
	}
	err = ctx.Err()
	conn.Close(websocket.StatusNormalClosure, "")
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

// withoutTmux drops TMUX from env, so tmux attaches from inside another tmux session too.
func withoutTmux(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "TMUX=") {
			out = append(out, kv)
		}
	}
	return out
}
