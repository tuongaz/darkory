package bot

import (
	"context"
	"fmt"
	"slices"

	"github.com/tuongaz/darkory/client"
)

// Reviewer takes the Tasks at review and Skill review Steps through next. A Retrospective
// advanced to Skill review with pending Skill proposals it reviews and advances into Done, which
// publishes the proposed versions; when another version was published since a proposal was
// written, Darkory sends the Retrospective back to Retro and the reviewer says so. A Task whose
// Item carries a HandBack it advances along "needs changes" the first time it reviews it; any
// other review it reads and advances into Done with a Note.
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
	if !sleep(wctx, r.busy()) {
		return nil
	}
	var pending []client.SkillProposal
	for _, p := range d.Proposals {
		if p.State == client.Pending {
			pending = append(pending, p)
		}
	}
	// An Item that says what review finds wrong is handed back to its worker the first time.
	if it := r.item(d); it != nil && it.HandBack != "" && back(d) != "" && !hasNote(d, it.HandBack) {
		stop()
		if ctx.Err() != nil {
			return nil
		}
		if _, err := r.advance(ctx, key, back(d), it.HandBack); err != nil {
			return gone(ctx, err)
		}
		r.say("handed back", key, "%q", it.HandBack)
		return nil
	}
	done := or(intoDone(d), onward(d, ""))
	if d.Task.Kind != client.Retrospective || len(pending) == 0 {
		note := fmt.Sprintf("Read %q with its %s and %s; it does what it says.", d.Task.Title, count(len(d.Notes), "Note"),
			count(len(d.Evidence), "Evidence file"))
		if d.Task.Kind == client.Retrospective {
			note = "No Skill proposal is pending on this Retrospective; nothing to publish."
		}
		stop()
		if ctx.Err() != nil {
			return nil
		}
		_, err := r.advance(ctx, key, done, note)
		return gone(ctx, err)
	}
	var names []string
	for _, p := range pending {
		s, err := r.skill(wctx, p.SkillID)
		if err != nil {
			return gone(wctx, err)
		}
		names = append(names, fmt.Sprintf("%s v%d", s.Skill.Name, p.BasedOnVersion+1))
	}
	slices.Sort(names)
	stop()
	if ctx.Err() != nil {
		return nil
	}
	// A version published since a proposal was written makes it stale: Darkory sends the
	// Retrospective back to be written again, with the refusal as its Note.
	_, err := r.advance(ctx, key, done, fmt.Sprintf("Reviewed the proposals (%s), which say what the workers missed, and published them.",
		joinAnd(names)))
	switch {
	case err == nil:
		for _, n := range names {
			r.say("published", key, "%s", n)
		}
		return nil
	case Code(err) == client.ErrorCodeProposalStale:
		r.say("handed back", key, "a proposal went stale before its review: %v", err)
		return nil
	}
	return gone(ctx, err)
}

// joinAnd joins names as "a", "a and b", "a, b and c".
func joinAnd(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	}
	out := names[0]
	for _, n := range names[1 : len(names)-1] {
		out += ", " + n
	}
	return out + " and " + names[len(names)-1]
}
