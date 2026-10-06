package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Workspaces, Team settings, agent settings and the Runner's sessions (docs/build/agents-plan.md).
// Not built yet: each answers 501.

func (s *Server) ListWorkspaces(w http.ResponseWriter, r *http.Request) { s.notImplemented(w, r) }

func (s *Server) CreateWorkspace(w http.ResponseWriter, r *http.Request, _ gen.CreateWorkspaceParams) {
	s.notImplemented(w, r)
}

func (s *Server) UpdateWorkspace(w http.ResponseWriter, r *http.Request, _ gen.WorkspaceRef, _ gen.UpdateWorkspaceParams) {
	s.notImplemented(w, r)
}

func (s *Server) RemoveWorkspace(w http.ResponseWriter, r *http.Request, _ gen.WorkspaceRef, _ gen.RemoveWorkspaceParams) {
	s.notImplemented(w, r)
}

func (s *Server) UpdateTeam(w http.ResponseWriter, r *http.Request, _ gen.TeamRef, _ gen.UpdateTeamParams) {
	s.notImplemented(w, r)
}

func (s *Server) SetAgentSettings(w http.ResponseWriter, r *http.Request, _ gen.MemberRef, _ gen.SetAgentSettingsParams) {
	s.notImplemented(w, r)
}

func (s *Server) ListRunnerSessions(w http.ResponseWriter, r *http.Request) { s.notImplemented(w, r) }

func (s *Server) NudgeRunnerSession(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.NudgeRunnerSessionParams) {
	s.notImplemented(w, r)
}

func (s *Server) StopRunnerSession(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.StopRunnerSessionParams) {
	s.notImplemented(w, r)
}

func (s *Server) RunnerTerminal(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.RunnerTerminalParams) {
	s.notImplemented(w, r)
}
