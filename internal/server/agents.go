package server

import (
	"errors"
	"net/http"
	"net/url"

	"github.com/coder/websocket"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// Workspaces, Team settings, agent settings and the Runner's sessions (docs/build/agents-plan.md).

func (s *Server) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	ws, err := s.core.ListWorkspaces(r.Context(), caller(r))
	s.respond(w, r, as(http.StatusOK, func(ws []core.Workspace) any { return gen.WorkspaceList{Items: each(ws, workspaceOut)} }), ws, err)
}

func (s *Server) CreateWorkspace(w http.ResponseWriter, r *http.Request, params gen.CreateWorkspaceParams) {
	var body gen.CreateWorkspaceBody
	out := as(http.StatusCreated, func(ws core.Workspace) any { return workspaceOut(ws) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nw := core.NewWorkspace{Name: body.Name, Path: body.Path}
	if body.Kind != nil {
		nw.Kind = string(*body.Kind)
	}
	if body.Mode != nil {
		nw.Mode = string(*body.Mode)
	}
	if body.DefaultBranch != nil {
		nw.DefaultBranch = *body.DefaultBranch
	}
	ws, err := s.core.CreateWorkspace(r.Context(), c, nw, idem)
	s.respond(w, r, out, ws, err)
}

func (s *Server) UpdateWorkspace(w http.ResponseWriter, r *http.Request, workspace gen.WorkspaceRef, params gen.UpdateWorkspaceParams) {
	var body gen.UpdateWorkspaceBody
	out := as(http.StatusOK, func(ws core.Workspace) any { return workspaceOut(ws) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	ch := core.WorkspaceChange{Name: body.Name, Path: body.Path, DefaultBranch: body.DefaultBranch}
	if body.Mode != nil {
		mode := string(*body.Mode)
		ch.Mode = &mode
	}
	ws, err := s.core.UpdateWorkspace(r.Context(), c, workspace, ch, idem)
	s.respond(w, r, out, ws, err)
}

func (s *Server) RemoveWorkspace(w http.ResponseWriter, r *http.Request, workspace gen.WorkspaceRef, params gen.RemoveWorkspaceParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.RemoveWorkspace(r.Context(), c, workspace, idem))
}

func (s *Server) UpdateTeam(w http.ResponseWriter, r *http.Request, team gen.TeamRef, params gen.UpdateTeamParams) {
	var body gen.UpdateTeamBody
	out := as(http.StatusOK, func(t core.Team) any { return teamOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.UpdateTeam(r.Context(), c, team, core.TeamChange{Name: body.Name, DefaultWorkspace: body.DefaultWorkspace,
		ShipWhenDone: body.ShipWhenDone}, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) SetAgentSettings(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.SetAgentSettingsParams) {
	var body gen.SetAgentSettingsBody
	out := as(http.StatusOK, func(m core.Member) any { return memberOut(m) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	m, err := s.core.SetAgentSettings(r.Context(), c, member, core.AgentChange{Command: body.Command, Args: body.Args, Model: body.Model,
		Env: body.Env, Unattended: body.Unattended, Paused: body.Paused, ProgressFile: body.ProgressFile}, idem)
	s.respond(w, r, out, m, err)
}

// noRunner answers a /v1/runner request when no Runner is attached.
func noRunner(w http.ResponseWriter) {
	writeError(w, http.StatusConflict, gen.ErrorCodeNoRunner, "no Runner is attached to this server; it runs no agent sessions (serve --agents=off, or darkory agents runs them elsewhere)")
}

func runnerSessionOut(rs runnerapi.Session) gen.RunnerSession {
	return gen.RunnerSession{TaskID: rs.TaskID, MemberID: rs.MemberID, SessionID: rs.SessionID, Host: rs.Host, Tmux: optional(rs.Tmux),
		StartedAt: rs.StartedAt, State: gen.RunnerSessionState(rs.State), LogPath: rs.LogPath}
}

// ListRunnerSessions lists what the Runner runs now, or says none is attached: a page polls it,
// and a browser logs every refusal. A Local Install holds one Organisation, so every session is
// the caller's Organisation's.
func (s *Server) ListRunnerSessions(w http.ResponseWriter, r *http.Request) {
	run := s.theRunner()
	if run == nil {
		writeJSON(w, http.StatusOK, gen.RunnerSessionList{Items: []gen.RunnerSession{}, Runner: false})
		return
	}
	writeJSON(w, http.StatusOK, gen.RunnerSessionList{Items: each(run.Sessions(), runnerSessionOut), Runner: true})
}

// runnerSession finds the Runner and the session on task for a /v1/runner request, answering
// and returning false when there is none. admin asks for the admin mark.
func (s *Server) runnerSession(w http.ResponseWriter, r *http.Request, task string, admin bool) (runnerapi.Runner, runnerapi.Session, bool) {
	c := caller(r)
	if admin && !c.Admin {
		writeError(w, http.StatusForbidden, gen.ErrorCodeForbidden, "only an admin may do this")
		return nil, runnerapi.Session{}, false
	}
	run := s.theRunner()
	if run == nil {
		noRunner(w)
		return nil, runnerapi.Session{}, false
	}
	t, err := s.core.GetTask(r.Context(), c, task)
	if err != nil {
		s.fail(w, r, err)
		return nil, runnerapi.Session{}, false
	}
	for _, rs := range run.Sessions() {
		if rs.TaskID == t.Task.ID {
			return run, rs, true
		}
	}
	writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, "the Runner runs no session on "+t.Task.Key)
	return nil, runnerapi.Session{}, false
}

// runnerFailed answers what a Runner's Nudge or Stop returned.
func (s *Server) runnerFailed(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, runnerapi.ErrNoSession) {
		writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, "the Runner runs no session on this Task")
		return
	}
	s.fail(w, r, err)
}

// NudgeRunnerSession and StopRunnerSession accept an Idempotency-Key and keep nothing under it:
// they change the session, not the record, and repeating one does what it did (decisions.md).
func (s *Server) NudgeRunnerSession(w http.ResponseWriter, r *http.Request, task gen.TaskRef, _ gen.NudgeRunnerSessionParams) {
	run, rs, ok := s.runnerSession(w, r, task, true)
	if !ok {
		return
	}
	if err := run.Nudge(rs.TaskID); err != nil {
		s.runnerFailed(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) StopRunnerSession(w http.ResponseWriter, r *http.Request, task gen.TaskRef, _ gen.StopRunnerSessionParams) {
	run, rs, ok := s.runnerSession(w, r, task, true)
	if !ok {
		return
	}
	if err := run.Stop(rs.TaskID); err != nil {
		s.runnerFailed(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunnerTerminal upgrades to a WebSocket and hands it to the Runner's Attach. Every refusal is
// answered before the upgrade. A browser's upgrade carries the cookie and an Origin, which must be
// the Install's own (cross-site WebSocket hijacking); a client sending no Origin, such as darkory
// attach with its token, is not a browser.
func (s *Server) RunnerTerminal(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.RunnerTerminalParams) {
	run, rs, ok := s.runnerSession(w, r, task, false)
	if !ok {
		return
	}
	if rs.Tmux == "" {
		writeError(w, http.StatusConflict, gen.ErrorCodeConflict, "the session runs without tmux and cannot be joined")
		return
	}
	c := caller(r)
	if origin := r.Header.Get("Origin"); origin != "" && !s.ownOrigin(r, origin) {
		writeError(w, http.StatusForbidden, gen.ErrorCodeForbidden, "a terminal opened from a browser must come from this Install's own pages")
		return
	}
	readonly := !c.Admin || (params.Readonly != nil && *params.Readonly)
	// Accept checks the Origin's host again, as it always does; the public URL's is allowed too.
	var patterns []string
	if u, err := url.Parse(s.publicURL); err == nil && u.Host != "" {
		patterns = []string{u.Host}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: patterns})
	if err != nil {
		return // Accept has answered.
	}
	ctx := runnerapi.WithViewer(r.Context(), runnerapi.Viewer{MemberID: c.MemberID, Name: c.Name, Admin: c.Admin})
	if err := run.Attach(ctx, rs.TaskID, readonly, conn); err != nil {
		reason := "the terminal ended: " + err.Error()
		if len(reason) > 120 {
			reason = reason[:120]
		}
		_ = conn.Close(websocket.StatusInternalError, reason)
	}
}
