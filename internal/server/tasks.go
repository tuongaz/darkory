package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/branch"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/shortid"
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
	if body.BlockedBy != nil {
		nt.BlockedBy = *body.BlockedBy
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
		Workflow: params.Workflow, AimedAt: params.AimedAt, Holder: params.Holder}
	if params.Filter != nil {
		tf.Filters = *params.Filter
		if run := s.theRunner(); run != nil {
			for _, sess := range run.Sessions() {
				tf.SessionTasks = append(tf.SessionTasks, shortid.Canonical(sess.TaskID))
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

func (s *Server) SetTaskPullRequest(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.SetTaskPullRequestParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.SetTaskPullRequestBody, idem core.Idem) (core.Task, error) {
		if err := s.mergedOnGitHub(r.Context(), c, task, body); err != nil {
			return core.Task{}, err
		}
		return s.core.SetPullRequest(r.Context(), c, task, core.PullRequest{Number: body.Number, URL: body.URL, State: string(body.State)}, idem)
	})
}

// mergedOnGitHub checks an agent's write of merged on GitHub, through the Runner beside this
// server when one is attached: the pull request must be merged there, and its head branch must
// start with the Task's branch prefix, as the Runner names a Task's branches. An agent writes as
// the Runner's discovery does, so its word that a merge happened is not taken alone. A human's
// write, a write of open, and a write with no Runner attached are not checked.
func (s *Server) mergedOnGitHub(ctx context.Context, c *auth.Caller, ref string, body gen.SetTaskPullRequestBody) error {
	run := s.theRunner()
	if body.State != gen.PullRequestMerged || run == nil {
		return nil
	}
	m, err := s.core.GetMember(ctx, c, c.MemberID)
	if err != nil {
		return err
	}
	if m.Member.Kind != "agent" {
		return nil
	}
	d, err := s.core.GetTask(ctx, c, ref)
	if err != nil {
		return err
	}
	key := d.Task.Key
	rctx, cancel := context.WithTimeout(ctx, s.runnerTimeout)
	defer cancel()
	pr, err := run.PullRequest(rctx, shortid.Of(d.Task.ID).String(), body.Number) // the Runner has ids as the API writes them
	switch {
	case err != nil && rctx.Err() == context.DeadlineExceeded:
		return &core.Error{Code: core.CodeConflict, Message: fmt.Sprintf("the Runner did not answer in %s", inSeconds(s.runnerTimeout))}
	case errors.Is(err, runnerapi.ErrNoPullRequest):
		return &core.Error{Code: core.CodeConflict, Message: fmt.Sprintf("GitHub has no pull request #%d in %s's Workspaces", body.Number, key)}
	case err != nil:
		return &core.Error{Code: core.CodeConflict, Message: err.Error()}
	case pr.State != core.PullRequestMerged:
		return &core.Error{Code: core.CodeConflict, Message: fmt.Sprintf("GitHub has #%d %s, not merged", body.Number, pr.State)}
	case !strings.HasPrefix(pr.Head, branch.Prefix(key)):
		return &core.Error{Code: core.CodeInvalid, Message: fmt.Sprintf("pull request #%d's branch %s is not %s's", body.Number, pr.Head, key)}
	}
	return nil
}

// MergeTaskPullRequest asks the Runner beside this server to merge the Task's open pull request:
// by a human who is the Task's Owner or an admin, never an agent. The Runner is given the number
// the record carries and checks on GitHub that its head is the Task's branch before merging; it
// merges only, and the server then records the merge of that number as the caller, with a Note. Like Nudge and Stop it
// accepts an Idempotency-Key and keeps nothing under it: a repeat finds the pull request merged
// and answers not_found.
func (s *Server) MergeTaskPullRequest(w http.ResponseWriter, r *http.Request, task gen.TaskRef, _ gen.MergeTaskPullRequestParams) {
	ctx, c := r.Context(), caller(r)
	d, err := s.core.GetTask(ctx, c, task)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// One merge of a Task at a time: a second request waits, then finds the pull request merged.
	// A request whose client goes away while it waits stops waiting.
	unlock, err := s.lockMerge(ctx, d.Task.ID)
	if err != nil {
		writeError(w, http.StatusConflict, gen.ErrorCodeConflict, fmt.Sprintf("stopped waiting for another merge of %s: %v", d.Task.Key, err))
		return
	}
	defer unlock()
	t, pr, err := s.core.MayMergePullRequest(ctx, c, d.Task.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	run := s.theRunner()
	if run == nil {
		noRunner(w)
		return
	}
	// The Runner has ids as the API writes them.
	rctx, cancel := context.WithTimeout(ctx, s.runnerTimeout)
	defer cancel()
	if err := run.Merge(rctx, shortid.Of(t.ID).String(), pr.Number); err != nil {
		if rctx.Err() == context.DeadlineExceeded {
			writeError(w, http.StatusConflict, gen.ErrorCodeConflict, fmt.Sprintf("the Runner did not answer in %s; look at the pull request "+
				"on GitHub before trying again", inSeconds(s.runnerTimeout)))
			return
		}
		if errors.Is(err, runnerapi.ErrNoPullRequest) {
			writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, fmt.Sprintf("GitHub has no open pull request #%d for %s", pr.Number, t.Key))
			return
		}
		writeError(w, http.StatusConflict, gen.ErrorCodeConflict, err.Error())
		return
	}
	merged, err := s.core.RecordMerge(context.WithoutCancel(ctx), c, t.ID, pr.Number, core.Idem{})
	s.respond(w, r, as(http.StatusOK, func(t core.Task) any { return taskOut(t) }), merged, err)
}

func (s *Server) SetTaskLabels(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.SetTaskLabelsParams) {
	taskWrite(s, w, r, params.IdempotencyKey, func(c *auth.Caller, body gen.SetTaskLabelsBody, idem core.Idem) (core.Task, error) {
		return s.core.SetTaskLabels(r.Context(), c, task, body.Labels, idem)
	})
}

// lockMerge holds the merge of the Task taskID until the returned func is called, so two requests
// cannot both find its pull request open and both have the Runner merge it. It waits for another
// merge of the Task while ctx lasts, and returns ctx's error when ctx ends first.
func (s *Server) lockMerge(ctx context.Context, taskID string) (func(), error) {
	m, _ := s.merging.LoadOrStore(taskID, make(chan struct{}, 1))
	slot := m.(chan struct{})
	select {
	case slot <- struct{}{}:
		return func() { <-slot }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// inSeconds says d in whole seconds, as "90 s"; a shorter d as it is.
func inSeconds(d time.Duration) string {
	if d < time.Second {
		return d.String()
	}
	return fmt.Sprintf("%d s", int(d.Round(time.Second).Seconds()))
}
