package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Operations in the spec that are not built yet answer 501 not_implemented (decisions.md).

func (s *Server) ListStatuses(w http.ResponseWriter, r *http.Request) { s.notImplemented(w, r) }

func (s *Server) SetStatuses(w http.ResponseWriter, r *http.Request, _ gen.SetStatusesParams) {
	s.notImplemented(w, r)
}

func (s *Server) SetTaskStatus(w http.ResponseWriter, r *http.Request, _ gen.TaskRef, _ gen.SetTaskStatusParams) {
	s.notImplemented(w, r)
}
