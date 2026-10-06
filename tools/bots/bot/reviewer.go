package bot

import (
	"context"
	"fmt"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Reviewer takes review and skill-review Tasks through next. A Retrospective handed over with a
// pending Skill proposal it reviews and completes, which publishes the proposed version, or hands
// back to retro when another version was published since the proposal was written; any other
// review it reads and completes with a Note.
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
		return true, on(d.Task.Key, r.review(ctx, d))
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
	// A version published since the proposal was written makes it stale: it goes back to retro
	// to be written again, as the refusal to complete would say.
	if p.BasedOnVersion == s.Skill.CurrentVersion {
		_, err = r.complete(ctx, key, fmt.Sprintf("Reviewed the proposal for %s v%d: it says what the builders missed. Publishing.",
			s.Skill.Name, p.BasedOnVersion+1))
		if err == nil {
			r.say("published", key, "%s v%d", s.Skill.Name, p.BasedOnVersion+1)
			return nil
		}
		if Code(err) != client.ErrorCodeProposalStale {
			return gone(ctx, err)
		}
		if s, err = r.skill(ctx, p.SkillID); err != nil {
			return gone(ctx, err)
		}
	}
	return gone(ctx, r.handover(ctx, key, SkillRetro, "", fmt.Sprintf("%s is at v%d since this proposal was written against v%d; please write it again.",
		s.Skill.Name, s.Skill.CurrentVersion, p.BasedOnVersion)))
}
