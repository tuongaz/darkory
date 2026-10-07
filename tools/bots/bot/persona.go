package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"slices"
	"time"

	"github.com/tuongaz/darkory/client"
)

// Person is a human persona at work, acting through a token of their own as a person in the web
// app would. One who answers looks at their takeable list every Pace.Poll and, Pace.Answer after
// first seeing a question aimed at them or a Task needing a Skill they work, claims it, writes a
// Note (the answer, or what they did, with the workpaper attached) and completes it. One who owns
// looks over the Features they own every Pace.Round: they ship each whose Tasks have all ended
// (one that ships when done has shipped itself), and move one unblocked Task waiting in a
// backlog Status, of a Feature whose Break down has ended, to the first todo Status. A human
// reports no model label.
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

// do claims the Task key, notes and completes it.
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
	// A Claim with a timeout ends when the token is revoked, so none is left held when the run stops.
	wctx, stop := h.hold(ctx, d)
	defer stop()
	// The time to answer was the wait before the Claim; writing it takes a moment.
	if !sleep(wctx, h.cfg.Pace.Step) {
		return nil
	}
	note := ""
	if d.Task.AimedAtID != nil {
		note = h.preset.answer(d.Task.Title)
	} else {
		step := h.step(d)
		if step == nil {
			note = "Done as the Task describes."
		} else {
			note = or(step.Entry, "Done as the Task describes.")
			if step.Workpaper != "" && len(d.Workspaces) > 0 {
				content, err := appendWorkpaper(wctx, d.Workspaces[0].Path, step.Workpaper, key, h.m.Name, note)
				switch {
				case err == nil:
					if err := h.attach(wctx, key, path.Base(step.Workpaper), content); err != nil {
						return gone(wctx, err)
					}
				case !errors.Is(err, errNoCheckout):
					return gone(wctx, err)
				}
			}
		}
	}
	if err := h.note(wctx, key, note); err != nil {
		return gone(wctx, err)
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	cres, err := h.c.CompleteTaskWithResponse(ctx, key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})
	if err := check(cres, err, http.StatusOK); err != nil {
		return gone(ctx, err)
	}
	h.say("completed", key, "now %s", h.statusName(ctx, cres.JSON200.StatusID))
	return nil
}

// look ships the persona's Features whose Tasks have all ended, then moves one Task waiting in a
// backlog Status to the first todo Status.
func (h *Person) look(ctx context.Context) error {
	open := client.FeatureStateOpen
	res, err := h.c.ListFeaturesWithResponse(ctx, &client.ListFeaturesParams{Owner: &h.m.ID, State: &open, Limit: ptr(500)})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	features := res.JSON200.Items
	for _, f := range features {
		if f.TaskCounts.Open > 0 {
			continue
		}
		sres, err := h.c.ShipFeatureWithResponse(ctx, f.Key, &client.ShipFeatureParams{})
		if err := check(sres, err, http.StatusOK); err != nil {
			// Shipped by ship-when-done, or a Task filed, since the list was read.
			if c := Code(err); c == client.ErrorCodeEnded || c == client.ErrorCodeTasksOpen {
				continue
			}
			return fmt.Errorf("shipping %s: %w", f.Key, err)
		}
		retro := "it has no Retrospective"
		if !f.Quick {
			retro = "its Retrospective waits for retro"
		}
		h.say("shipped", "", "%s %q, every Task having ended; %s", f.Key, f.Title, retro)
	}
	list, err := h.listStatuses(ctx)
	if err != nil {
		return err
	}
	todo, todoName := firstOfKind(list, client.StatusKindTodo)
	backlog := map[string]string{}
	for _, s := range list {
		if s.Kind == client.StatusKindBacklog {
			backlog[s.ID] = s.Name
		}
	}
	if len(backlog) == 0 || todo == "" {
		return nil
	}
	for _, f := range features {
		if f.TaskCounts.Open == 0 {
			continue
		}
		fres, err := h.c.GetFeatureWithResponse(ctx, f.Key)
		if err := check(fres, err, http.StatusOK); err != nil {
			return err
		}
		tasks := fres.JSON200.Tasks
		// The planner files Tasks into the Backlog before it sets their blockers; once the Break
		// down has ended they are all set.
		if slices.ContainsFunc(tasks, func(t client.Task) bool { return t.Kind == client.Breakdown && t.State == client.TaskStateOpen }) {
			continue
		}
		for _, t := range tasks {
			from, waiting := backlog[t.StatusID]
			if t.State != client.TaskStateOpen || !waiting || t.Blocked {
				continue
			}
			sres, err := h.c.SetTaskStatusWithResponse(ctx, t.Key, &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: todo})
			if err := check(sres, err, http.StatusOK); err != nil {
				return on(t.Key, fmt.Errorf("moving it to %s: %w", todoName, err))
			}
			h.say("moved", t.Key, "%q from %s to %s", t.Title, from, todoName)
			return nil
		}
	}
	return nil
}
