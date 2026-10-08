package runner

import (
	"context"

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

// pausedNote is the Note of a Task released because its agent was paused while next waited.
const pausedNote = "The agent was paused while it waited for this Task, so the Runner released it without starting a Shift."

// run pulls Tasks through next and works each in a session, until ctx ends. A paused agent takes
// no work; its settings are read again before every next.
func (a *agent) run(ctx context.Context) {
	r := a.r
	log := r.log.With("agent", a.name())
	var pull Record // the Session the next Claim is made in; a fresh one after every Claim
	unset := false  // said that the agent has no settings
	defer func() {
		// Stopping, the Session waiting for the next Claim is closed, not left to go idle.
		if pull != nil {
			r.closeSession(ctx, pull, "the Session waiting for the next Task")
		}
	}()
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
			// An admin may give it settings later (darkory agent set).
			if !unset {
				log.Warn("the agent has no agent settings, so the runner starts no Shift for it until it has")
				unset = true
			}
			sleep(ctx, r.t.Wait)
			continue
		}
		unset = false
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
		// next may have waited a while: an agent paused meanwhile starts no session.
		if now, ok, err := a.rec.Agent(ctx, a.me.Member.ID); err == nil && (!ok || now.Paused) {
			log.Info("the agent was paused while it waited for a Task; releasing it unworked", "task", d.Task.Key)
			if err := rec.Release(context.WithoutCancel(ctx), d.Task.Key, pausedNote); err != nil {
				log.Warn("releasing a Task taken while the agent was being paused", "task", d.Task.Key, "err", err)
			}
			r.closeSession(ctx, rec, "the Session that took a Task while the agent was being paused", "task", d.Task.Key)
			continue
		}
		if !newSession(a, rec, d, set).run(ctx) {
			// The same failure would meet the next Task: pause before taking one.
			sleep(ctx, r.t.Nudge)
		}
		// The Claim has ended; closing the Session ends one the runner failed to release, and keeps
		// the Member's list of Sessions short.
		r.closeSession(ctx, rec, "the session's Darkory Session", "task", d.Task.Key)
	}
}
