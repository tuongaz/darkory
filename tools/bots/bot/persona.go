package bot

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Person is a human persona at work, acting through a token of their own as a person in the web
// app would. One who answers looks at their takeable list every Pace.Poll and, Pace.Answer after
// first seeing a question aimed at them, claims it, writes the answer as a Note and completes it.
// One who works a Skill takes the Tasks at its Steps the same way and works them as an agent
// would (agent.work), with no Observation and no model label: advancing each along its Step's way
// on, or completing it where that is the Step's one way, into Done. One who owns looks over the
// Tasks they own every Pace.Round: they complete each Parent whose Subtasks have all ended (one
// with Auto-complete has completed itself), and move one unblocked Task waiting in the hold, the
// intake, to the Step it is for, once its Parent's Breakdown, if any, has ended.
type Person struct {
	agent
	p Persona
	// due is when each Task seen takeable will be taken, by id.
	due   map[string]time.Time
	works map[string]bool // ids of the Skills the persona works
	round time.Time
}

// NewPerson makes the persona p, acting as m.
func NewPerson(cfg Config, m Member, p Persona) *Person {
	return &Person{agent: newAgent(cfg, m, ""), p: p, due: map[string]time.Time{}}
}

func (h *Person) Run(ctx context.Context) error {
	return h.loop(ctx, func() (bool, error) {
		if h.p.Owns && time.Since(h.round) >= h.cfg.Pace.Round {
			h.round = time.Now()
			if err := h.look(ctx); err != nil {
				return true, err
			}
		}
		if h.p.Answers || len(h.p.Works) > 0 {
			if err := h.answer(ctx); err != nil {
				return true, err
			}
		}
		sleep(ctx, h.cfg.Pace.Poll)
		return true, nil
	})
}

// answer takes the first Task whose time has come, of those aimed at the persona or needing a
// Skill they work, and does it.
func (h *Person) answer(ctx context.Context) error {
	if h.works == nil {
		res, err := h.c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
		if err := check(res, err, http.StatusOK); err != nil {
			return err
		}
		h.works = map[string]bool{}
		for _, s := range res.JSON200.Items {
			if slices.Contains(h.p.Works, s.Name) {
				h.works[s.ID] = true
			}
		}
	}
	res, err := h.c.ListTakeableTasksWithResponse(ctx, &client.ListTakeableTasksParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	now := time.Now()
	var next *client.Task
	seen := map[string]bool{}
	for _, t := range res.JSON200.Items {
		aimed := t.AimedAtID != nil && *t.AimedAtID == h.m.ID
		if !(aimed && h.p.Answers) && !(t.SkillID != nil && h.works[*t.SkillID]) {
			continue
		}
		seen[t.ID] = true
		if _, ok := h.due[t.ID]; !ok {
			h.due[t.ID] = now.Add(h.between(h.cfg.Pace.Answer))
		}
		if next == nil && !now.Before(h.due[t.ID]) {
			next = &t
		}
	}
	for id := range h.due {
		if !seen[id] {
			delete(h.due, id)
		}
	}
	if next == nil {
		return nil
	}
	delete(h.due, next.ID)
	return on(next.Key, h.do(ctx, next.Key))
}

// do claims the Task key and does it: a question answered with a Note and completed, any other
// Task worked as its Item says.
func (h *Person) do(ctx context.Context, key string) error {
	timeout := h.cfg.Pace.Timeout
	res, err := h.c.ClaimTaskWithResponse(ctx, key, &client.ClaimTaskParams{}, client.ClaimTaskBody{HeartbeatTimeoutSeconds: &timeout})
	if err := check(res, err, http.StatusOK); err != nil {
		// Someone else took it, or it was blocked or moved, since the list was read.
		if c := Code(err); c == client.ErrorCodeAlreadyClaimed || c == client.ErrorCodeNotTakeable {
			return nil
		}
		return err
	}
	d := res.JSON200
	h.took(d)
	if d.Task.AimedAtID == nil {
		return h.work(ctx, d, false)
	}
	// A Claim with a timeout ends when the token is revoked, so none is left held when the run stops.
	wctx, stop := h.hold(ctx, d)
	defer stop()
	// The time to answer was the wait before the Claim; writing it takes a moment.
	if !sleep(wctx, h.cfg.Pace.Step) {
		return nil
	}
	if err := h.note(wctx, key, h.preset.answer(d.Task.Title)); err != nil {
		return gone(wctx, err)
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	_, err = h.complete(ctx, key, "")
	return gone(ctx, err)
}

// look completes the persona's Parents whose Subtasks have all ended, then moves one Task waiting
// in the hold to the Step it is for.
func (h *Person) look(ctx context.Context) error {
	filter := []string{"owner:is:" + h.m.ID, "top:is:true"}
	open := client.TaskStateOpen
	res, err := h.c.ListTasksWithResponse(ctx, &client.ListTasksParams{Filter: &filter, State: &open, Limit: ptr(500)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	tasks := res.JSON200.Items
	for _, t := range tasks {
		if n := t.SubtaskCounts; n == nil || n.Open > 0 {
			continue
		}
		cres, err := h.c.CompleteTaskWithResponse(ctx, t.Key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})
		if err := check(cres, err, http.StatusOK); err != nil {
			// Completed by Auto-complete, or a Subtask filed, since the list was read.
			if c := Code(err); c == client.ErrorCodeEnded || c == client.ErrorCodeTasksOpen {
				continue
			}
			return fmt.Errorf("completing %s: %w", t.Key, err)
		}
		h.say("completed", t.Key, "%q, every Subtask having ended", t.Title)
	}
	hold := h.preset.Hold()
	if hold == "" {
		return nil
	}
	for _, t := range tasks {
		var candidates []client.Task
		parent := ""
		if t.SubtaskCounts == nil {
			candidates = []client.Task{t}
		} else {
			d, err := h.c.GetTaskWithResponse(ctx, t.Key)
			if err := check(d, err, http.StatusOK); err != nil {
				return err
			}
			// The planner files Subtasks into the hold before it sets their blockers; once the
			// Breakdown has ended they are all set.
			if slices.ContainsFunc(d.JSON200.Subtasks, func(s client.Task) bool { return s.Kind == client.Breakdown && s.State == client.TaskStateOpen }) {
				continue
			}
			candidates, parent = d.JSON200.Subtasks, t.Title
		}
		for _, c := range candidates {
			if c.State != client.TaskStateOpen || c.Blocked || c.Claim != nil || h.stepName(ctx, c.ProjectID, c.StepID) != hold {
				continue
			}
			to, err := h.stepFor(ctx, c, parent)
			if err != nil {
				return err
			}
			if to == "" {
				continue
			}
			return h.move(ctx, c.Key, to, "out of "+hold)
		}
	}
	return nil
}

// stepFor is the Step a Task in the hold is for: its Item's, else the first Step of the hold's
// Workflow whose Skill is the Project's own work rather than one Darkory files its Subtasks at. A
// Task's Workflow is that of its Step (ADR 0019), so the hold leads only into its own Workflow.
func (h *Person) stepFor(ctx context.Context, t client.Task, parent string) (string, error) {
	if it := h.preset.item(parent, t.Title, h.ask); it != nil && it.Step != "" {
		return it.Step, nil
	}
	wf, err := h.workflow(ctx, t.ProjectID)
	if err != nil {
		return "", err
	}
	res, err := h.c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return "", err
	}
	builtin := map[string]bool{}
	for _, s := range res.JSON200.Items {
		builtin[s.ID] = s.Builtin
	}
	in := ""
	for _, s := range wf.Steps {
		if s.ID == deref(t.StepID) {
			in = s.WorkflowID
		}
	}
	for _, s := range wf.Steps {
		if s.WorkflowID == in && s.SkillID != nil && !builtin[*s.SkillID] {
			return s.Name, nil
		}
	}
	return "", nil
}
