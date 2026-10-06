package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// Statuses: the Organisation's list, and a Task's move within it (ADR 0012).

func statusListOut(ss []core.Status) gen.StatusList {
	return gen.StatusList{Items: each(ss, statusOut)}
}

func (s *Server) ListStatuses(w http.ResponseWriter, r *http.Request) {
	ss, err := s.core.ListStatuses(r.Context(), caller(r))
	s.respond(w, r, as(http.StatusOK, func(ss []core.Status) any { return statusListOut(ss) }), ss, err)
}

func (s *Server) SetStatuses(w http.ResponseWriter, r *http.Request, params gen.SetStatusesParams) {
	var body gen.SetStatusesBody
	out := as(http.StatusOK, func(ss []core.Status) any { return statusListOut(ss) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	items := make([]core.StatusInput, 0, len(body.Items))
	for _, in := range body.Items {
		items = append(items, core.StatusInput{ID: deref(in.ID), Name: in.Name, Kind: string(in.Kind)})
	}
	var moves map[string]string
	if body.Moves != nil {
		moves = *body.Moves
	}
	ss, err := s.core.SetStatuses(r.Context(), c, items, moves, idem)
	s.respond(w, r, out, ss, err)
}

func (s *Server) SetTaskStatus(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.SetTaskStatusParams) {
	var body gen.SetTaskStatusBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.SetTaskStatus(r.Context(), c, task, body.Status, idem)
	s.respond(w, r, out, t, err)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
