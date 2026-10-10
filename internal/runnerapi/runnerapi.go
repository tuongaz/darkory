// Package runnerapi is what the server asks of the Runner beside it (ADR 0013): the sessions it
// runs, a nudge, a stop, and a terminal to watch or join. The server serves these under
// /v1/runner; the Runner implements Runner without importing the server, and a server with no
// Runner answers no_runner.
package runnerapi

import (
	"context"
	"errors"
	"time"

	"github.com/coder/websocket"
)

// Session states, as RunnerSession.state in api/openapi.yaml.
const (
	// StateRunning: the agent is working, its progress moving.
	StateRunning = "running"
	// StateWaiting: its turn ended with the Task still held and no decision, and the Runner
	// nudges it, then releases the Task; or it shows a dialog the Runner leaves to a person.
	StateWaiting = "waiting"
	// StateStalled: its progress went stale, so the Runner sends no more Heartbeats and the
	// Claim lapses unless it moves again.
	StateStalled = "stalled"
	// StateEnding: the Claim has ended and the session is closing.
	StateEnding = "ending"
)

// Session is one agent session the Runner runs for a Task it claimed as that agent. It is a read
// model, not part of the record.
type Session struct {
	// TaskID is the Task's id, never its display key.
	TaskID string
	// MemberID is the agent whose session it is.
	MemberID string
	// SessionID is the Darkory Session the Runner holds the Claim through, which is also the id
	// the agent's own session runs under.
	SessionID string
	// Host is the machine the session runs on.
	Host string
	// Tmux names the tmux session, such as dk-WEB-12; empty when the session runs without tmux
	// and cannot be joined.
	Tmux      string
	StartedAt time.Time
	// State is StateRunning, StateWaiting, StateStalled or StateEnding.
	State string
	// StateSince is when the session entered State.
	StateSince time.Time
	// LogPath is where the session's terminal is logged on Host.
	LogPath string
}

// ErrNoSession is what Nudge, Stop and Attach return for a Task the Runner runs no session on;
// the server answers it not_found.
var ErrNoSession = errors.New("runnerapi: no Shift on this Task")

// ErrNoPullRequest is what Merge returns for a Task with no open pull request, in the record or on
// GitHub; the server answers it not_found.
var ErrNoPullRequest = errors.New("runnerapi: no open pull request for this Task")

// ErrNotJoinable is what Attach returns for a session that runs without tmux; the server answers
// it conflict when it can still say so.
var ErrNotJoinable = errors.New("runnerapi: the Shift runs without tmux and cannot be joined")

// Runner is the Runner as the server sees it. Every method takes the Task by id; the server has
// already resolved a display key and checked the caller's rights (admins nudge and stop; anyone
// watches; only an admin who did not ask for readonly types).
type Runner interface {
	// Sessions lists the sessions running now, oldest first.
	Sessions() []Session
	// Nudge types the Runner's nudge into the Task's session.
	Nudge(taskID string) error
	// Stop ends the Task's session and releases its Claim with a Note.
	Stop(taskID string) error
	// Merge merges the Task's open pull request on GitHub, as the identity the Runner's gh signs
	// in as, and records it merged on the Task with a Note naming by, the Member who asked. It
	// returns ErrNoPullRequest when the Task has none open; any other error is GitHub's refusal,
	// its message as the Runner read it, which the server shows as it is.
	Merge(ctx context.Context, taskID, by string) error
	// Attach bridges conn to the Task's terminal until either side ends or ctx is done, and
	// closes conn. Binary messages carry the terminal's bytes both ways; a text message
	// {"cols": n, "rows": n} resizes the view. With readonly, what the client sends is ignored.
	// ViewerOf(ctx) names the Member joining, for the Note on the Task.
	Attach(ctx context.Context, taskID string, readonly bool, conn *websocket.Conn) error
}

// Viewer is the Member watching or joining a session through the terminal.
type Viewer struct {
	MemberID string
	Name     string
	// Admin says whether the Member is an admin; readonly is passed to Attach apart.
	Admin bool
}

type viewerKey struct{}

// WithViewer returns ctx carrying v, as the server passes it to Attach.
func WithViewer(ctx context.Context, v Viewer) context.Context {
	return context.WithValue(ctx, viewerKey{}, v)
}

// ViewerOf returns the Member the server says is attaching, and false when ctx carries none.
func ViewerOf(ctx context.Context) (Viewer, bool) {
	v, ok := ctx.Value(viewerKey{}).(Viewer)
	return v, ok
}
