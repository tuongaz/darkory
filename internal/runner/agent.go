package runner

import (
	"context"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// agent is one agent Member the runner runs: one session at a time (D11).
type agent struct {
	r     *Runner
	token string
	me    client.Me
	// rec is the agent in a Session of the runner's own, for reading.
	rec Record
}

func (a *agent) name() string { return a.me.Member.Name }

// run pulls Tasks through next and works each in a session, until ctx ends. A paused agent takes
// no work; its settings are read again before every next.
func (a *agent) run(ctx context.Context) {
	r := a.r
	log := r.log.With("agent", a.name())
	var pull Record // the Session the next Claim is made in; a fresh one after every Claim
	for ctx.Err() == nil {
		set, ok, err := a.rec.Agent(ctx, a.me.Member.ID)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if stopped(err) {
				log.Error("the Install no longer accepts this agent's token; the runner stops running it", "err", err)
				return
			}
			log.Warn("reading the agent's settings", "err", err)
			sleep(ctx, r.t.Retry)
			continue
		}
		if !ok {
			log.Warn("the Member has no agent settings; the runner does not run it")
			return
		}
		if set.Paused {
			sleep(ctx, r.t.Tick)
			continue
		}
		if pull == nil {
			if pull, err = r.dial(a.token, remote.NewSessionID()); err != nil {
				log.Error("dialling the Install", "err", err)
				return
			}
		}
		d, err := pull.Next(ctx, r.t.Wait, r.t.ClaimTimeout, set.Model)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if stopped(err) {
				log.Error("the Install no longer accepts this agent's token; the runner stops running it", "err", err)
				return
			}
			log.Warn("next", "err", err)
			sleep(ctx, r.t.Retry)
			continue
		}
		if d == nil {
			continue
		}
		rec := pull
		pull = nil
		if !newSession(a, rec, d, set).run(ctx) {
			// The same failure would meet the next Task: pause before taking one.
			sleep(ctx, r.t.Nudge)
		}
		// The Claim has ended; closing the Session ends one the runner failed to release, and keeps
		// the Member's list of Sessions short.
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		if err := rec.CloseSession(cctx); err != nil && !stopped(err) {
			log.Warn("closing the session's Darkory Session", "task", d.Task.Key, "err", err)
		}
		cancel()
	}
}
