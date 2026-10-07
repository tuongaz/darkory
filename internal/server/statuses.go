package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Statuses are gone (ADR 0016): a Task's state is its Step in its Project's Workflow. model v2:
// replaced by /v1/projects/{project}/workflow and /v1/tasks/{task}/step (M1b).

func (s *Server) ListStatuses(w http.ResponseWriter, r *http.Request) {
	replaced(w, "Statuses are replaced by each Project's Workflow of Steps")
}

func (s *Server) SetStatuses(w http.ResponseWriter, r *http.Request, params gen.SetStatusesParams) {
	replaced(w, "Statuses are replaced by each Project's Workflow of Steps")
}

func (s *Server) SetTaskStatus(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.SetTaskStatusParams) {
	replaced(w, "a Task is moved to a Step of its Project's Workflow")
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
