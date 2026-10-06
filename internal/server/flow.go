package server

import (
	"net/http"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// Flow and learning: Handover, Notes, Observations, Blocking, take-back and drop on Tasks; Rank,
// ship, drop and ownership on Features; Skill proposals.

func (s *Server) HandoverTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.HandoverTaskParams) {
	var body gen.HandoverTaskBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.Handover(r.Context(), c, task, body.Skill, body.Status, body.Note, idem)
	s.respond(w, r, out, t, err)
}

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
	p, err := s.core.GetSkillProposal(r.Context(), caller(r), proposal)
	s.respond(w, r, as(http.StatusOK, func(p core.SkillProposal) any { return proposalOut(p) }), p, err)
}

func (s *Server) RankFeature(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.RankFeatureParams) {
	var body gen.RankFeatureBody
	out := as(http.StatusOK, func(f core.Feature) any { return featureOut(f) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	f, err := s.core.RankFeature(r.Context(), c, feature, body.Position, idem)
	s.respond(w, r, out, f, err)
}

func (s *Server) ShipFeature(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.ShipFeatureParams) {
	out := as(http.StatusOK, func(d core.FeatureDetail) any { return featureDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	d, err := s.core.ShipFeature(r.Context(), c, feature, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) DropFeature(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.DropFeatureParams) {
	out := as(http.StatusOK, func(d core.FeatureDetail) any { return featureDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	d, err := s.core.DropFeature(r.Context(), c, feature, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) PassFeatureOwnership(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.PassFeatureOwnershipParams) {
	var body gen.PassFeatureOwnershipBody
	out := as(http.StatusOK, func(f core.Feature) any { return featureOut(f) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	f, err := s.core.PassFeatureOwnership(r.Context(), c, feature, body.Owner, idem)
	s.respond(w, r, out, f, err)
}

func (s *Server) ListFeatureObservations(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.ListFeatureObservationsParams) {
	all := params.Reviewed != nil && *params.Reviewed
	obs, err := s.core.ListFeatureObservations(r.Context(), caller(r), feature, all)
	s.respond(w, r, as(http.StatusOK, func(obs []core.Observation) any {
		return gen.ObservationList{Items: each(obs, observationOut)}
	}), obs, err)
}
