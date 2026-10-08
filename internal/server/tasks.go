package server

import (
	"net/http"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// Features are Tasks now (ADR 0015). model v2: replaced by /v1/tasks with parent and breakdown
// (M1b).

func (s *Server) FileFeature(w http.ResponseWriter, r *http.Request, params gen.FileFeatureParams) {
	replaced(w, "a Feature is a Task filed with Break down, its Tasks its Subtasks")
}

func (s *Server) ListFeatures(w http.ResponseWriter, r *http.Request, params gen.ListFeaturesParams) {
	replaced(w, "a Feature is a Task with Subtasks; list Tasks with top:is:true")
}

func (s *Server) GetFeature(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef) {
	replaced(w, "a Feature is a Task with Subtasks; read the Task")
}

func (s *Server) FileTask(w http.ResponseWriter, r *http.Request, params gen.FileTaskParams) {
	var body gen.FileTaskBody
	out := as(http.StatusCreated, func(d core.TaskDetail) any { return taskDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	// model v2: a Task is filed at a Step, not needing a Skill or in a Status; its Feature is its
	// Parent (M1b rebuilds this body).
	if body.Skill != nil || body.Status != nil {
		replaced(w, "a Task is filed at a Step of its Project's Workflow, which carries the Skill")
		return
	}
	nt := core.NewTask{Parent: body.Feature, Title: body.Title, AimedAt: body.AimedAt, Blocks: body.Blocks, Workspaces: body.Workspaces}
	if body.Description != nil {
		nt.Description = *body.Description
	}
	d, err := s.core.FileTask(r.Context(), c, nt, idem)
	s.respond(w, r, out, d, err)
}

func (s *Server) ListTasks(w http.ResponseWriter, r *http.Request, params gen.ListTasksParams) {
	// model v2: a Feature is a Parent, a Team a Project; a Status is a Step (M1b).
	if params.Status != nil {
		replaced(w, "a Task's Status is its Step; filter by step")
		return
	}
	tf := core.TaskFilter{Parent: params.Feature, Project: params.Team, State: (*string)(params.State),
		AimedAt: params.AimedAt, Holder: params.Holder}
	// model v2: the skill parameter goes; the skill: filter token is the Step's Skill (M1b).
	if params.Skill != nil {
		tf.Filters = append(tf.Filters, "skill:is:"+*params.Skill)
	}
	if params.Filter != nil {
		tf.Filters = append(tf.Filters, *params.Filter...)
		if run := s.theRunner(); run != nil {
			for _, sess := range run.Sessions() {
				tf.SessionTasks = append(tf.SessionTasks, sess.TaskID)
			}
		}
	}
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
	if !s.nexts.enter(w, c) {
		return
	}
	defer s.nexts.leave(c)
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
