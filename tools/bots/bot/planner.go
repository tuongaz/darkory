package bot

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Planner takes Breakdown Subtasks through next (it holds only breakdown) and files its Parent's
// Subtasks from a plan: some at the Step that works them, some ahead in the hold, with the QA
// waiting on the builds. It advances the Breakdown into Done with a Note listing what it filed.
type Planner struct {
	agent
	ask string
	// Plan makes the plan for a Parent, by its title; DefaultPlan unless set.
	Plan func(parent, ask string) []Item
}

// NewPlanner makes a planner whose plans aim their questions at ask.
func NewPlanner(cfg Config, m Member, model, ask string) *Planner {
	return &Planner{agent: newAgent(cfg, m, model), ask: ask, Plan: DefaultPlan}
}

// Item is one Task of a plan.
type Item struct {
	// Ref names the Item for the other Items' BlockedBy.
	Ref         string
	Title       string
	Description string
	// Step is the Step of the Workflow the Task is worked at first.
	Step string
	// Backlog files it ahead, into the Workflow's hold (the intake), where next does not offer it.
	Backlog bool
	// BlockedBy are the Refs of the Items that must end before this one is takeable.
	BlockedBy []string
	// Workspaces are the Workspaces the Task names; none names its Parent's.
	Workspaces []string

	// What a worker does with the Task, where its description does not say: Question is asked
	// the first time it is worked (at Question.Step, when set); Outcome is the outcome it is
	// advanced along once done (the Step's first, when empty); Entry is the line appended to the
	// Workpaper, a file in the Task's first Workspace, which is then attached as Evidence, or
	// Entries[step] at that Step.
	Question  *Question
	Outcome   string
	Workpaper string
	Entry     string
	Entries   map[string]string
	// HandBack is what a reviewer says, advancing the Task along "needs changes", the first time
	// they review it; Fix is the line its worker then appends before advancing it again.
	HandBack, Fix string
}

// entry is the line a worker writes about the Item at the Step step.
func (it *Item) entry(step string) string {
	if e, ok := it.Entries[step]; ok {
		return e
	}
	return it.Entry
}

// DefaultPlan breaks a Parent into two builds under the company Skill, one with a question for
// ask; a QA waiting on both; and a help page, a demo and a polish filed ahead into the Backlog.
// Every build goes to review when built.
func DefaultPlan(parent, ask string) []Item {
	t := parent
	return []Item{
		{Ref: "api", Title: "Build the API for " + t, Step: StepBuild, Description: "The endpoints " + t + " needs, with tests."},
		{Ref: "screen", Title: "Build the screen for " + t, Step: StepBuild,
			Description: "The page for " + t + ".\n" + questionLine(ask, "Should "+t+" work for someone who is signed out?")},
		{Ref: "qa", Title: "QA " + t, Step: StepQA, Description: "Try " + t + " end to end.", BlockedBy: []string{"api", "screen"}},
		{Ref: "help", Title: "Write the help page for " + t, Step: StepDocs, Description: "Once it is built.", Backlog: true},
		{Ref: "demo", Title: "Record a demo of " + t, Step: StepDocs, Description: "For the release notes.", Backlog: true},
		{Ref: "polish", Title: "Polish " + t, Step: StepBuild, Description: "What review finds worth a second pass.", Backlog: true},
	}
}

func (p *Planner) Run(ctx context.Context) error {
	return p.loop(ctx, func() (bool, error) {
		d, err := p.next(ctx, p.cfg.Pace.Wait, p.cfg.Pace.Timeout)
		if err != nil || d == nil {
			return true, err
		}
		p.took(d)
		if d.Task.Kind != client.Breakdown || d.Parent == nil {
			return true, on(d.Task.Key, p.release(ctx, d.Task.Key, "I only break Tasks down."))
		}
		return true, on(d.Task.Key, p.breakDown(ctx, d))
	})
}

// breakDown files the plan for the Breakdown's Parent, then advances the Breakdown into Done.
func (p *Planner) breakDown(ctx context.Context, d *client.TaskDetail) error {
	wctx, stop := p.hold(ctx, d)
	defer stop()
	items := p.Plan(d.Parent.Title, p.ask)
	filed, waiting, ahead, err := fileItems(wctx, &p.agent, d.Parent.Key, d.Task.ProjectID, items, p.preset.Workflow.Hold())
	if err != nil {
		return gone(wctx, err)
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	_, err = p.advance(ctx, d.Task.Key, "", fmt.Sprintf("Filed %d Subtasks (%s), with %d waiting on others and %d in %s until someone moves them.",
		len(filed), strings.Join(filed, ", "), waiting, ahead, or(p.preset.Workflow.Hold(), "the hold")))
	return gone(ctx, err)
}

// fileItems files items as Subtasks of the Parent parent, as a: an Item that waits on others, or
// is filed ahead, goes to the hold, and one that waits only on others is moved to its Step once
// its blockers are set, so nobody takes it in between. It returns the keys filed, how many wait
// on others and how many were filed ahead.
func fileItems(ctx context.Context, a *agent, parent, project string, items []Item, hold string) (filed []string, waiting, ahead int, err error) {
	keys := map[string]string{}
	for _, s := range items {
		if s.Backlog {
			ahead++
		} else if len(s.BlockedBy) > 0 {
			waiting++
		}
		if !sleep(ctx, a.cfg.Pace.Step) {
			return filed, waiting, ahead, nil
		}
		step := s.Step
		if (s.Backlog || len(s.BlockedBy) > 0) && hold != "" {
			step = hold
		}
		body := client.FileTaskBody{Parent: &parent, Title: s.Title, Description: &s.Description, Step: &step}
		if len(s.Workspaces) > 0 {
			body.Workspaces = &s.Workspaces
		}
		res, err := a.c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, body)
		if err := check(res, err, http.StatusCreated); err != nil {
			return filed, waiting, ahead, fmt.Errorf("filing %q: %w", s.Title, err)
		}
		key := res.JSON201.Task.Key
		keys[s.Ref] = key
		filed = append(filed, key)
		a.say("filed", key, "%q under %s, at %s", s.Title, parent, a.stepName(ctx, project, res.JSON201.Task.StepID))
	}
	for _, s := range items {
		for _, ref := range s.BlockedBy {
			res, err := a.c.AddBlockerWithResponse(ctx, keys[s.Ref], keys[ref], &client.AddBlockerParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return filed, waiting, ahead, fmt.Errorf("blocking %s by %s: %w", keys[s.Ref], keys[ref], err)
			}
			a.say("blocked", keys[s.Ref], "by %s", keys[ref])
		}
		if len(s.BlockedBy) > 0 && !s.Backlog && hold != "" {
			if err := a.move(ctx, keys[s.Ref], s.Step, "now that what it waits on is set"); err != nil {
				return filed, waiting, ahead, err
			}
		}
	}
	return filed, waiting, ahead, nil
}
