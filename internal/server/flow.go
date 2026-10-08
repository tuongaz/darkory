package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// Flow and learning: Notes, Observations, Blocking, take-back and drop on Tasks; Skill proposals.

func (s *Server) AddNote(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.AddNoteParams) {
	var body gen.AddNoteBody
	out := as(http.StatusCreated, func(n core.Note) any { return noteOut(n) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	n, err := s.core.AddNote(r.Context(), c, task, body.Body, idem)
	s.respond(w, r, out, n, err)
}

func (s *Server) Observe(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.ObserveParams) {
	var body gen.ObserveBody
	out := as(http.StatusCreated, func(o core.Observation) any { return observationOut(o) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	o, err := s.core.Observe(r.Context(), c, task, string(body.Outcome), body.Body, idem)
	s.respond(w, r, out, o, err)
}

func (s *Server) TakeBackTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.TakeBackTaskParams) {
	var body gen.TakeBackTaskBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.TakeBack(r.Context(), c, task, body.Reason, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) DropTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.DropTaskParams) {
	var body gen.DropTaskBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.DropTask(r.Context(), c, task, body.Reason, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) AddBlocker(w http.ResponseWriter, r *http.Request, task gen.TaskRef, blocker gen.BlockerRef, params gen.AddBlockerParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.AddBlocker(r.Context(), c, task, blocker, idem))
}

func (s *Server) RemoveBlocker(w http.ResponseWriter, r *http.Request, task gen.TaskRef, blocker gen.BlockerRef, params gen.RemoveBlockerParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.RemoveBlocker(r.Context(), c, task, blocker, idem))
}

func (s *Server) ProposeSkillVersion(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.ProposeSkillVersionParams) {
	var body gen.ProposeSkillVersionBody
	out := as(http.StatusCreated, func(p core.SkillProposal) any { return proposalOut(p) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	p, err := s.core.ProposeSkillVersion(r.Context(), c, task, body.Skill, body.BasedOnVersion, body.Body, idem)
	s.respond(w, r, out, p, err)
}

func (s *Server) GetSkillProposal(w http.ResponseWriter, r *http.Request, proposal gen.ProposalID) {
	p, err := s.core.GetSkillProposal(r.Context(), caller(r), string(proposal))
	s.respond(w, r, as(http.StatusOK, func(p core.SkillProposal) any { return proposalOut(p) }), p, err)
}

// ListTaskObservations lists the Observations on a Task, and on a Parent's Subtasks: what its
// Retrospective reads.
func (s *Server) ListTaskObservations(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.ListTaskObservationsParams) {
	all := params.Reviewed != nil && *params.Reviewed
	os, err := s.core.ListParentObservations(r.Context(), caller(r), task, all)
	s.respond(w, r, as(http.StatusOK, func(os []core.Observation) any {
		return gen.ObservationList{Items: each(os, observationOut)}
	}), os, err)
}
