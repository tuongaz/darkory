package bot

import (
	"context"
	"net/http"
	"time"
)

// Lapser claims a Task with a short heartbeat timeout (Pace.LapseTimeout) and never heartbeats,
// as an agent that crashed would. Its Claim lapses, Darkory records the lapse with no actor, and
// the Task waits at its Step again. With Pace.LapseEvery zero it exits once it has
// claimed; otherwise it watches the lapse recorded and claims again every LapseEvery.
type Lapser struct{ agent }

// NewLapser makes a lapser.
func NewLapser(cfg Config, m Member, model string) *Lapser {
	return &Lapser{agent: newAgent(cfg, m, model)}
}

func (l *Lapser) Run(ctx context.Context) error {
	return l.loop(ctx, func() (bool, error) {
		d, err := l.next(ctx, l.cfg.Pace.Wait, l.cfg.Pace.LapseTimeout)
		if err != nil || d == nil {
			return true, err
		}
		claimed := time.Now()
		l.took(d)
		l.say("went silent", d.Task.Key, "it will send no Heartbeat; the Claim lapses in %ds", l.cfg.Pace.LapseTimeout)
		if l.cfg.Pace.LapseEvery == 0 {
			return false, nil
		}
		// A read shows the Claim ended at its expiry at once; its end is recorded when Darkory
		// records the lapse, or someone else holds it.
		deadline := claimed.Add(time.Duration(l.cfg.Pace.LapseTimeout)*time.Second + 10*time.Second)
		for sleep(ctx, l.cfg.Pace.Poll) {
			res, err := l.c.GetTaskWithResponse(ctx, d.Task.Key)
			if err := check(res, err, http.StatusOK); err != nil {
				return true, err
			}
			r := res.JSON200
			how := ""
			for _, cl := range r.Claims {
				if cl.ID == d.Task.Claim.ID && cl.HowEnded != nil {
					how = string(*cl.HowEnded)
				}
			}
			if c := r.Task.Claim; how != "" || (c != nil && c.ID != d.Task.Claim.ID) || time.Now().After(deadline) {
				l.say(or(how, "ended"), d.Task.Key, "the Claim ended %s; the Task waits at %s", or(how, "some other way"), where(r))
				break
			}
		}
		sleep(ctx, time.Until(claimed.Add(l.cfg.Pace.LapseEvery)))
		return true, nil
	})
}
