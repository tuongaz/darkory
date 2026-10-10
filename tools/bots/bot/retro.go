package bot

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Retro takes Retrospective Subtasks through next (it holds retro), reads the Observations on its
// Parent and the Parent's Subtasks and, when some say an own Skill didn't work, proposes that
// Skill's next version with what they said, then advances the Retrospective along "propose" to
// Skill review. With nothing to change it advances it into Done with a Note.
type Retro struct{ agent }

// NewRetro makes a retro bot.
func NewRetro(cfg Config, m Member, model string) *Retro {
	return &Retro{agent: newAgent(cfg, m, model)}
}

func (r *Retro) Run(ctx context.Context) error {
	return r.loop(ctx, func() (bool, error) {
		d, err := r.next(ctx, r.cfg.Pace.Wait, r.cfg.Pace.Timeout)
		if err != nil || d == nil {
			return true, err
		}
		r.took(d)
		if d.Task.Kind != client.Retrospective {
			return true, on(d.Task.Key, r.release(ctx, d.Task.Key, "I only run Retrospectives."))
		}
		return true, on(d.Task.Key, r.retro(ctx, d))
	})
}

func (r *Retro) retro(ctx context.Context, d *client.TaskDetail) error {
	key := d.Task.Key
	wctx, stop := r.hold(ctx, d)
	defer stop()
	if d.Parent == nil {
		return fmt.Errorf("the Retrospective %s has no Parent", key)
	}
	parent := d.Parent.Key
	res, err := r.c.ListTaskObservationsWithResponse(wctx, d.Parent.ID, &client.ListTaskObservationsParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return gone(wctx, err)
	}
	obs := res.JSON200.Items
	worked := 0
	// The own Skill to improve: the first one an Observation says didn't work, with what the
	// Observations under it said.
	var skill *client.SkillDetail
	var lessons []string
	for _, o := range obs {
		if o.Outcome == client.Worked {
			worked++
			continue
		}
		if o.SkillID == nil {
			continue
		}
		if skill == nil {
			s, err := r.skill(wctx, *o.SkillID)
			if err != nil {
				return gone(wctx, err)
			}
			if s.Skill.Kind == client.Own {
				skill = s
			}
		}
		if skill != nil && *o.SkillID == skill.Skill.ID {
			lessons = append(lessons, o.Body)
		}
	}
	r.say("read", key, "%s on %s: %d worked, %d didn't", count(len(obs), "Observation"), parent, worked, len(obs)-worked)
	if !sleep(wctx, r.busy()) {
		return nil
	}
	if skill == nil {
		stop()
		if ctx.Err() != nil {
			return nil
		}
		_, err := r.advance(ctx, key, intoDone(d), fmt.Sprintf("Read %s; no own Skill needs a change.", count(len(obs), "Observation")))
		return gone(ctx, err)
	}
	// Another Retrospective may publish a version between reading the Skill and proposing; then
	// read it again and propose against the new one.
	for try := 1; ; try++ {
		body := skill.Current.Body + "\n\nFrom the Retrospective of " + parent + ":\n- " + strings.Join(lessons, "\n- ")
		res, err := r.c.ProposeSkillVersionWithResponse(wctx, key, &client.ProposeSkillVersionParams{},
			client.ProposeSkillVersionBody{Skill: skill.Skill.Name, BasedOnVersion: skill.Skill.CurrentVersion, Body: body})
		err = check(res, err, http.StatusCreated)
		if err == nil {
			break
		}
		if Code(err) != client.ErrorCodeProposalStale || try == 3 {
			return gone(wctx, err)
		}
		if skill, err = r.skill(wctx, skill.Skill.ID); err != nil {
			return gone(wctx, err)
		}
	}
	r.say("proposed", key, "%s v%d against v%d, adding what %s said", skill.Skill.Name, skill.Skill.CurrentVersion+1, skill.Skill.CurrentVersion,
		count(len(lessons), "Observation"))
	stop()
	if ctx.Err() != nil {
		return nil
	}
	_, err = r.advance(ctx, key, toReview(d), fmt.Sprintf("Proposed %s v%d from %s that didn't work.",
		skill.Skill.Name, skill.Skill.CurrentVersion+1, count(len(lessons), "Observation")))
	return gone(ctx, err)
}

// toReview is the outcome of a Retrospective's Step that leads on to a Step, Skill review: "propose",
// else the first that does.
func toReview(d *client.TaskDetail) string {
	out := ""
	for _, k := range d.Connectors {
		if k.ToStepID == nil {
			continue
		}
		if k.Name == "propose" {
			return k.Name
		}
		out = or(out, k.Name)
	}
	return out
}
