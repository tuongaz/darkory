package bot

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Retro takes Retrospective Tasks through next (it holds retro), reads the Feature's Observations
// and, when some say a company Skill didn't work, proposes that Skill's next version with what
// they said, then hands the Retrospective over to skill-review. With nothing to change it
// completes the Retrospective with a Note.
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
			return true, r.release(ctx, d.Task.Key, "I only run Retrospectives.")
		}
		return true, r.retro(ctx, d)
	})
}

func (r *Retro) retro(ctx context.Context, d *client.TaskDetail) error {
	key := d.Task.Key
	wctx, stop := r.hold(ctx, d)
	defer stop()
	res, err := r.c.ListFeatureObservationsWithResponse(wctx, d.Feature.ID, &client.ListFeatureObservationsParams{})
	if err := check(res, err, http.StatusOK); err != nil {
		return gone(wctx, err)
	}
	obs := res.JSON200.Items
	worked := 0
	// The company Skill to improve: the first one an Observation says didn't work, with what the
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
			if s.Skill.Kind == client.Company {
				skill = s
			}
		}
		if skill != nil && *o.SkillID == skill.Skill.ID {
			lessons = append(lessons, o.Body)
		}
	}
	r.say("read", key, "%s on %s: %d worked, %d didn't", count(len(obs), "Observation"), d.Feature.Key, worked, len(obs)-worked)
	if !sleep(wctx, r.work()) {
		return nil
	}
	if skill == nil {
		stop()
		if ctx.Err() != nil {
			return nil
		}
		_, err := r.complete(ctx, key, fmt.Sprintf("Read %s; no company Skill needs a change.", count(len(obs), "Observation")))
		return gone(ctx, err)
	}
	body := skill.Current.Body + "\n\nFrom the Retrospective of " + d.Feature.Key + ":\n- " + strings.Join(lessons, "\n- ")
	pres, err := r.c.ProposeSkillVersionWithResponse(wctx, key, &client.ProposeSkillVersionParams{},
		client.ProposeSkillVersionBody{Skill: skill.Skill.Name, BasedOnVersion: skill.Skill.CurrentVersion, Body: body})
	if err := check(pres, err, http.StatusCreated); err != nil {
		return gone(wctx, err)
	}
	r.say("proposed", key, "%s v%d against v%d, adding what %s said", skill.Skill.Name, skill.Skill.CurrentVersion+1, skill.Skill.CurrentVersion,
		count(len(lessons), "Observation"))
	stop()
	if ctx.Err() != nil {
		return nil
	}
	return gone(ctx, r.handover(ctx, key, SkillSkillReview, "", fmt.Sprintf("Proposed %s v%d from %s that didn't work.",
		skill.Skill.Name, skill.Skill.CurrentVersion+1, count(len(lessons), "Observation"))))
}
