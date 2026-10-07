//go:build windows

package runner

import (
	"context"

	"github.com/coder/websocket"

	"github.com/tuongaz/darkory/internal/runnerapi"
)

// Attach is not available on Windows, which has no tmux.
func (r *Runner) Attach(_ context.Context, _ string, _ bool, conn *websocket.Conn) error {
	conn.Close(websocket.StatusPolicyViolation, "the session runs without tmux")
	return runnerapi.ErrNotJoinable
}
