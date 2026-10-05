package server

import (
	"net/http"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

func (s *Server) FileFeature(w http.ResponseWriter, r *http.Request, params gen.FileFeatureParams) {
	var body gen.FileFeatureBody
	out := as(http.StatusCreated, func(d core.FeatureDetail) any { return featureDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nf := core.NewFeature{Team: body.Team, Title: body.Title, Owner: body.Owner, FromRetrospective: body.FromRetrospective}
	if body.Description != nil {
		nf.Description = *body.Description
	}
	d, err := s.core.FileFeature(r.Context(), c, nf, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) ListFeatures(w http.ResponseWriter, r *http.Request, params gen.ListFeaturesParams) {
	ff := core.FeatureFilter{Team: params.Team, State: (*string)(params.State), Owner: params.Owner}
	if params.Limit != nil {
		ff.Limit = *params.Limit
	}
	if params.Cursor != nil {
		ff.Cursor = *params.Cursor
	}
	p, err := s.core.ListFeatures(r.Context(), caller(r), ff)
	s.respond(w, r, as(http.StatusOK, func(p core.Page[core.Feature]) any {
		return gen.FeatureList{Items: each(p.Items, featureOut), NextCursor: pageCursor(p.NextCursor)}
	}), p, err)
}

func (s *Server) GetFeature(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef) {
	d, err := s.core.GetFeature(r.Context(), caller(r), feature)
	s.respond(w, r, as(http.StatusOK, func(d core.FeatureDetail) any { return featureDetailOut(d) }), d, err)
}

func (s *Server) FileTask(w http.ResponseWriter, r *http.Request, params gen.FileTaskParams) {
	var body gen.FileTaskBody
	out := as(http.StatusCreated, func(d core.TaskDetail) any { return taskDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nt := core.NewTask{Feature: body.Feature, Title: body.Title, Skill: body.Skill, AimedAt: body.AimedAt, Blocks: body.Blocks}
	if body.Description != nil {
		nt.Description = *body.Description
	}
	d, err := s.core.FileTask(r.Context(), c, nt, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) ListTasks(w http.ResponseWriter, r *http.Request, params gen.ListTasksParams) {
	tf := core.TaskFilter{Feature: params.Feature, Team: params.Team, State: (*string)(params.State), Skill: params.Skill,
		AimedAt: params.AimedAt, Holder: params.Holder}
	if params.Limit != nil {
		tf.Limit = *params.Limit
	}
	if params.Cursor != nil {
		tf.Cursor = *params.Cursor
	}
	p, err := s.core.ListTasks(r.Context(), caller(r), tf)
	s.respond(w, r, as(http.StatusOK, func(p core.Page[core.Task]) any {
		return gen.TaskList{Items: each(p.Items, taskOut), NextCursor: pageCursor(p.NextCursor)}
	}), p, err)
}

func (s *Server) ListTakeableTasks(w http.ResponseWriter, r *http.Request, params gen.ListTakeableTasksParams) {
	limit := 0
	if params.Limit != nil {
		limit = *params.Limit
	}
	ts, err := s.core.ListTakeable(r.Context(), caller(r), limit)
	s.respond(w, r, as(http.StatusOK, func(ts []core.Task) any { return gen.TaskList{Items: each(ts, taskOut)} }), ts, err)
}

func (s *Server) GetTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef) {
	d, err := s.core.GetTask(r.Context(), caller(r), task)
	s.respond(w, r, as(http.StatusOK, func(d core.TaskDetail) any { return taskDetailOut(d) }), d, err)
}

// claimOptions checks what claim and next take besides the Task.
func claimOptions(w http.ResponseWriter, timeout *int, label *string) (core.ClaimOptions, bool) {
	var o core.ClaimOptions
	if timeout != nil {
		if *timeout < 0 || *timeout > 86400 {
			invalid(w, "heartbeat_timeout_seconds is 0 to 86400")
			return o, false
		}
		d := time.Duration(*timeout) * time.Second
		o.Timeout = &d
	}
	if label != nil {
		if len(*label) > 200 {
			invalid(w, "model_label is at most 200 characters")
			return o, false
		}
		o.ModelLabel = label
	}
	return o, true
}

func (s *Server) ClaimTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.ClaimTaskParams) {
	var body gen.ClaimTaskBody
	out := as(http.StatusOK, func(d core.TaskDetail) any { return taskDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	o, ok := claimOptions(w, body.HeartbeatTimeoutSeconds, body.ModelLabel)
	if !ok {
		return
	}
	d, err := s.core.Claim(r.Context(), c, task, o, idem)
	s.respond(w, r, out, d, err)
}

// NextTask long-polls for a takeable Task and claims it. A wait that ends with nothing claimed
// answers 204 and stores nothing under the Idempotency-Key, since nothing was written.
func (s *Server) NextTask(w http.ResponseWriter, r *http.Request, params gen.NextTaskParams) {
	var body gen.NextTaskBody
	out := as(http.StatusOK, func(d core.TaskDetail) any { return taskDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	o, ok := claimOptions(w, body.HeartbeatTimeoutSeconds, body.ModelLabel)
	if !ok {
		return
	}
	wait := core.NextWaitDefault
	if body.WaitSeconds != nil {
		if *body.WaitSeconds < 0 || *body.WaitSeconds > int(core.NextWaitMax/time.Second) {
			invalid(w, "wait_seconds is 0 to 60")
			return
		}
		wait = time.Duration(*body.WaitSeconds) * time.Second
	}
	d, found, err := s.core.Next(r.Context(), c, wait, o, idem)
	if err == nil && !found {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.respond(w, r, out, d, err)
}

// Heartbeat accepts an Idempotency-Key and does not store it: a repeated Heartbeat reports the
// Claim as it is now (decisions.md).
func (s *Server) Heartbeat(w http.ResponseWriter, r *http.Request, task gen.TaskRef, _ gen.HeartbeatParams) {
	hb, err := s.core.Heartbeat(r.Context(), caller(r), task)
	s.respond(w, r, as(http.StatusOK, func(hb core.HeartbeatReply) any {
		return gen.HeartbeatReply{Status: gen.HeartbeatStatus(hb.Status), ExpiresAt: hb.ExpiresAt}
	}), hb, err)
}

func (s *Server) ReleaseTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.ReleaseTaskParams) {
	var body gen.ReleaseTaskBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.Release(r.Context(), c, task, body.Note, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) CompleteTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.CompleteTaskParams) {
	var body gen.CompleteTaskBody
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	t, err := s.core.Complete(r.Context(), c, task, body.Note, idem)
	s.respond(w, r, out, t, err)
}
