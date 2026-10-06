package bot

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Planner takes Break down Tasks through next (it holds only breakdown) and files the Feature's
// Tasks from a plan: some into Todo, some ahead into the Backlog, with the review and QA waiting
// on the builds. It completes the Break down with a Note listing what it filed.
type Planner struct {
	agent
	ask string
	// Plan makes the plan for a Feature; DefaultPlan unless set.
	Plan func(f client.Feature, ask string) []Step
}

// NewPlanner makes a planner whose plans aim their questions at ask.
func NewPlanner(cfg Config, m Member, model, ask string) *Planner {
	return &Planner{agent: newAgent(cfg, m, model), ask: ask, Plan: DefaultPlan}
}

// Step is one Task of a plan.
type Step struct {
	// Ref names the Step for the other Steps' BlockedBy.
	Ref         string
	Title       string
	Skill       string
	Description string
	// Backlog files it ahead, into the first backlog Status, where next does not offer it.
	Backlog bool
	// BlockedBy are the Refs of the Steps that must end before this one is takeable.
	BlockedBy []string
}

// DefaultPlan breaks a Feature into two builds under the company Skill, one handed over to review
// when built and one with a question for ask; a review and QA waiting on both; and a help page, a
// demo and a polish filed ahead into the Backlog.
func DefaultPlan(f client.Feature, ask string) []Step {
	t := f.Title
	return []Step{
		{Ref: "api", Title: "Build the API for " + t, Skill: SkillCompany,
			Description: "The endpoints " + t + " needs, with tests.\n" + handoverLine(SkillReview)},
		{Ref: "screen", Title: "Build the screen for " + t, Skill: SkillCompany,
			Description: "The page for " + t + ".\n" + questionLine(ask, "Should "+t+" work for someone who is signed out?")},
		{Ref: "review", Title: "Review " + t, Skill: SkillReview, Description: "Read both builds and their logs.", BlockedBy: []string{"api", "screen"}},
		{Ref: "qa", Title: "QA " + t, Skill: SkillQA, Description: "Try " + t + " end to end.", BlockedBy: []string{"api", "screen"}},
		{Ref: "help", Title: "Write the help page for " + t, Skill: SkillDocs, Description: "Once it is built.", Backlog: true},
		{Ref: "demo", Title: "Record a demo of " + t, Skill: SkillDocs, Description: "For the release notes.", Backlog: true},
		{Ref: "polish", Title: "Polish " + t, Skill: SkillCompany, Description: "What review finds worth a second pass.", Backlog: true},
	}
}

func (p *Planner) Run(ctx context.Context) error {
	return p.loop(ctx, func() (bool, error) {
		d, err := p.next(ctx, p.cfg.Pace.Wait, p.cfg.Pace.Timeout)
		if err != nil || d == nil {
			return true, err
		}
		p.took(d)
		if d.Task.Kind != client.Breakdown {
			return true, p.release(ctx, d.Task.Key, "I only break Features down.")
		}
		return true, p.breakDown(ctx, d)
	})
}

// breakDown files the plan for d's Feature. A Step that waits on others is filed into the Backlog
// and moved to Todo once its blockers are set, so nobody takes it in between.
func (p *Planner) breakDown(ctx context.Context, d *client.TaskDetail) error {
	wctx, stop := p.hold(ctx, d)
	defer stop()
	list, err := p.listStatuses(wctx)
	if err != nil {
		return gone(wctx, err)
	}
	backlog, _ := firstOfKind(list, client.StatusKindBacklog)
	todo, todoName := firstOfKind(list, client.StatusKindTodo)
	steps := p.Plan(d.Feature, p.ask)
	keys := map[string]string{}
	var filed []string
	waiting, ahead := 0, 0
	for _, s := range steps {
		if s.Backlog {
			ahead++
		} else if len(s.BlockedBy) > 0 {
			waiting++
		}
		if !sleep(wctx, p.cfg.Pace.Step) {
			return nil
		}
		status := todo
		if (s.Backlog || len(s.BlockedBy) > 0) && backlog != "" {
			status = backlog
		}
		res, err := p.c.FileTaskWithResponse(wctx, &client.FileTaskParams{}, client.FileTaskBody{
			Feature: &d.Feature.Key, Title: s.Title, Skill: &s.Skill, Description: &s.Description, Status: &status})
		if err := check(res, err, http.StatusCreated); err != nil {
			return gone(wctx, fmt.Errorf("filing %q: %w", s.Title, err))
		}
		key := res.JSON201.Task.Key
		keys[s.Ref] = key
		filed = append(filed, key)
		p.say("filed", key, "%q needing %s, in %s", s.Title, s.Skill, res.JSON201.Status.Name)
	}
	for _, s := range steps {
		for _, ref := range s.BlockedBy {
			res, err := p.c.AddBlockerWithResponse(wctx, keys[s.Ref], keys[ref], &client.AddBlockerParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return gone(wctx, fmt.Errorf("blocking %s by %s: %w", keys[s.Ref], keys[ref], err))
			}
			p.say("blocked", keys[s.Ref], "by %s", keys[ref])
		}
		if len(s.BlockedBy) > 0 && !s.Backlog && backlog != "" {
			res, err := p.c.SetTaskStatusWithResponse(wctx, keys[s.Ref], &client.SetTaskStatusParams{}, client.SetTaskStatusBody{Status: todo})
			if err := check(res, err, http.StatusOK); err != nil {
				return gone(wctx, fmt.Errorf("moving %s to %s: %w", keys[s.Ref], todoName, err))
			}
			p.say("moved", keys[s.Ref], "to %s, now that what it waits on is set", todoName)
		}
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	_, err = p.complete(ctx, d.Task.Key, fmt.Sprintf("Filed %d Tasks: %s. %d wait on others; %d wait in the Backlog until someone moves them.",
		len(filed), strings.Join(filed, ", "), waiting, ahead))
	return gone(ctx, err)
}
