package server

import (
	"net/http"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

func (s *Server) FileTask(w http.ResponseWriter, r *http.Request, params gen.FileTaskParams) {
	var body gen.FileTaskBody
	out := as(http.StatusCreated, func(d core.TaskDetail) any { return taskDetailOut(d) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, out)
	if !ok {
		return
	}
	nt := core.NewTask{Project: body.Project, Parent: body.Parent, Title: body.Title, Owner: body.Owner, Step: body.Step,
		AutoComplete: body.AutoComplete, Acceptance: body.Acceptance, Workspaces: body.Workspaces, AimedAt: body.Aim,
		Blocks: body.Blocks, Note: body.Note, FromRetrospective: body.FromRetrospective}
	if body.Description != nil {
		nt.Description = *body.Description
	}
	if body.Breakdown != nil {
		nt.Breakdown = *body.Breakdown
	}
	if body.Labels != nil {
		nt.Labels = *body.Labels
	}
	d, err := s.core.FileTask(r.Context(), c, nt, idem)
	s.respond(w, r, out, d, err)
}

// ListTasks lists Tasks by Project and Rank. `claim:is:session` reads the sessions the Runner
// beside this server runs now.
func (s *Server) ListTasks(w http.ResponseWriter, r *http.Request, params gen.ListTasksParams) {
	tf := core.TaskFilter{Project: params.Project, Parent: params.Parent, State: (*string)(params.State), Step: params.Step,
		AimedAt: params.AimedAt, Holder: params.Holder}
	if params.Filter != nil {
		tf.Filters = *params.Filter
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

// RecordNudge is the Runner, through the Session holding a Task's Claim, recording that it nudged
// the agent.
func (s *Server) RecordNudge(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.RecordNudgeParams) {
	var body gen.RecordNudgeBody
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, noContent)
	if !ok {
		return
	}
	s.respond(w, r, noContent, nil, s.core.RecordNudge(r.Context(), c, task, body.Nudge, idem))
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

// taskWrite runs a write on one Task that answers with the Task: decode the body, set up the
// Idempotency-Key, call op, respond.
func taskWrite[B any](s *Server, w http.ResponseWriter, r *http.Request, key *string, op func(c *auth.Caller, body B, idem core.Idem) (core.Task, error)) {
	var body B
	out := as(http.StatusOK, func(t core.Task) any { return taskOut(t) })
	c, idem, ok := s.begin(w, r, key, &body, out)
	if !ok {
		return
	}
	t, err := op(c, body, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) AdvanceTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.AdvanceTaskParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.AdvanceTaskBody, idem core.Idem) (core.Task, error) {
		return s.core.Advance(r.Context(), c, task, deref(body.Outcome), body.Note, idem)
	})
}

func (s *Server) MoveTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.MoveTaskParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.MoveTaskBody, idem core.Idem) (core.Task, error) {
		return s.core.MoveTask(r.Context(), c, task, body.Step, body.Note, idem)
	})
}

func (s *Server) RankTask(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.RankTaskParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.RankTaskBody, idem core.Idem) (core.Task, error) {
		return s.core.RankTask(r.Context(), c, task, body.Position, idem)
	})
}

func (s *Server) PassOwnership(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.PassOwnershipParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.PassOwnershipBody, idem core.Idem) (core.Task, error) {
		return s.core.PassOwnership(r.Context(), c, task, body.Owner, idem)
	})
}

func (s *Server) SetTaskLabels(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.SetTaskLabelsParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.SetTaskLabelsBody, idem core.Idem) (core.Task, error) {
		return s.core.SetTaskLabels(r.Context(), c, task, body.Labels, idem)
	})
}
