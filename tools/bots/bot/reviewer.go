package bot

import (
	"context"
	"fmt"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Reviewer takes review and skill-review Tasks through next. A Retrospective handed over with a
// pending Skill proposal it reviews and completes, which publishes the proposed version; any
// other review it reads and completes with a Note.
type Reviewer struct{ agent }

// NewReviewer makes a reviewer.
func NewReviewer(cfg Config, m Member, model string) *Reviewer {
	return &Reviewer{agent: newAgent(cfg, m, model)}
}

func (r *Reviewer) Run(ctx context.Context) error {
	return r.loop(ctx, func() (bool, error) {
		d, err := r.next(ctx, r.cfg.Pace.Wait, r.cfg.Pace.Timeout)
		if err != nil || d == nil {
			return true, err
		}
		r.took(d)
		return true, r.review(ctx, d)
	})
}

func (r *Reviewer) review(ctx context.Context, d *client.TaskDetail) error {
	key := d.Task.Key
	wctx, stop := r.hold(ctx, d)
	defer stop()
	if !sleep(wctx, r.work()) {
		return nil
	}
	p := d.Proposal
	if d.Task.Kind != client.Retrospective || p == nil || p.State != client.Pending {
		note := fmt.Sprintf("Read %q with its %s and %s; it does what it says.", d.Task.Title, count(len(d.Notes), "Note"),
			count(len(d.Evidence), "Evidence file"))
		if len(d.Blockers) > 0 {
			var keys []string
			for _, bl := range d.Blockers {
				keys = append(keys, bl.Key)
			}
			note = fmt.Sprintf("Read %s with their Notes and logs; they do what they say.", strings.Join(keys, " and "))
		}
		if d.Task.Kind == client.Retrospective {
			note = "No Skill proposal is pending on this Retrospective; nothing to publish."
		}
		stop()
		if ctx.Err() != nil {
			return nil
		}
		_, err := r.complete(ctx, key, note)
		return gone(ctx, err)
	}
	s, err := r.skill(wctx, p.SkillID)
	if err != nil {
		return gone(wctx, err)
	}
	stop()
	if ctx.Err() != nil {
		return nil
	}
	if _, err := r.complete(ctx, key, fmt.Sprintf("Reviewed the proposal for %s v%d: it says what the builders missed. Publishing.",
		s.Skill.Name, p.BasedOnVersion+1)); err != nil {
		return gone(ctx, err)
	}
	after, err := r.skill(ctx, p.SkillID)
	if err != nil {
		return gone(ctx, err)
	}
	if after.Current.ProposalID != nil && *after.Current.ProposalID == p.ID {
		r.say("published", key, "%s v%d", after.Skill.Name, after.Current.Version)
	} else {
		r.say("refused", key, "completing did not publish %s v%d: the current version is %d", s.Skill.Name, p.BasedOnVersion+1, after.Current.Version)
	}
	return nil
}
