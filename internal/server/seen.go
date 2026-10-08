package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// A Member's own mark of how far they have seen a Project's Activity.

func projectSeenOut(m core.ProjectSeen) any { return gen.ProjectSeen{Seq: m.Seq, At: m.At} }

func (s *Server) GetProjectSeen(w http.ResponseWriter, r *http.Request, project gen.ProjectRef) {
	m, err := s.core.GetProjectSeen(r.Context(), caller(r), project)
	s.respond(w, r, as(http.StatusOK, projectSeenOut), m, err)
}

func (s *Server) SetProjectSeen(w http.ResponseWriter, r *http.Request, project gen.ProjectRef, params gen.SetProjectSeenParams) {
	var body gen.SetProjectSeenBody
	out := as(http.StatusOK, projectSeenOut)
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	m, err := s.core.SetProjectSeen(r.Context(), c, project, body.Seq, idem)
	s.respond(w, r, out, m, err)
}
