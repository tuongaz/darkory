package runner

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
)

// What a session leaves behind for later, in <data>/sessions/<TASK-KEY>: the logs it could not
// attach yet, and the Step it built the Task at.

// keptDir holds a Task's session logs waiting to be attached: each <name> beside <name>.json.
const keptDir = "kept"

// keptLog is a session log waiting to be attached to Task, as the agent Member whose session it was.
type keptLog struct {
	Task, Agent, Name string
	At                time.Time
}

// keepLog keeps a session's log until it can be attached, and wakes attachKept.
func (r *Runner) keepLog(a *agent, task, name string, content []byte) error {
	dir := filepath.Join(r.cfg.Data, "sessions", task, keptDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
		return err
	}
	b, err := json.Marshal(keptLog{Task: task, Agent: a.me.Member.ID, Name: name, At: time.Now().UTC()})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), b, 0o600); err != nil {
		return err
	}
	r.wakeKept()
	return nil
}

// wakeKept has attachKept look at the kept logs now.
func (r *Runner) wakeKept() {
	select {
	case r.kept <- struct{}{}:
	default:
	}
}

// attachKept attaches the kept session logs once their Tasks are free: when it starts, whenever a
// Claim ends, and every Poll. A log waits for as long as its Task is held by another, however
// long, and survives the runner stopping.
func (r *Runner) attachKept(ctx context.Context) {
	t := time.NewTicker(r.t.Poll)
	defer t.Stop()
	for {
		r.attachKeptOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-r.kept:
		}
	}
}

func (r *Runner) attachKeptOnce(ctx context.Context) {
	found, _ := filepath.Glob(filepath.Join(r.cfg.Data, "sessions", "*", keptDir, "*.json"))
	for _, meta := range found {
		b, err := os.ReadFile(meta)
		if err != nil {
			continue
		}
		var k keptLog
		if err := json.Unmarshal(b, &k); err != nil {
			r.log.Warn("a kept session log's record does not read", "file", meta, "err", err)
			continue
		}
		var a *agent
		for _, x := range r.agents {
			if x.me.Member.ID == k.Agent {
				a = x
			}
		}
		if a == nil {
			continue // another runner's agent, or one this runner no longer runs
		}
		content, err := os.ReadFile(strings.TrimSuffix(meta, ".json"))
		if errors.Is(err, fs.ErrNotExist) {
			os.Remove(meta)
			continue
		}
		if err != nil {
			continue
		}
		err = a.rec.Attach(ctx, k.Task, k.Name, content)
		switch {
		case err == nil:
			os.Remove(strings.TrimSuffix(meta, ".json"))
			os.Remove(meta)
			os.Remove(filepath.Dir(meta))
			r.log.Info("attached a kept session log", "agent", a.name(), "task", k.Task, "evidence", k.Name)
		case refusedBy(err, client.ErrorCodeNotHolder):
			// Still held by another; it comes back when that Claim ends.
		case ctx.Err() == nil:
			r.log.Debug("attaching a kept session log", "task", k.Task, "evidence", k.Name, "err", err)
		}
	}
}

// builtFile records, in a Task's session directory, the Step a session last committed to the
// Task's branch at under another Skill than review: its builder's, where a merge that conflicts
// sends its resolution.
const builtFile = "built.json"

type builtRecord struct {
	StepID, Step, Agent string
	At                  time.Time
}

// tips are the commits the checkouts' branches are at, by repository and branch.
func tips(ctx context.Context, cs []Checkout) map[string]string {
	out := map[string]string{}
	for _, c := range cs {
		sha, _ := runGit(ctx, c.Workspace.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+c.Branch)
		out[c.Workspace.Path+"\x00"+c.Branch] = sha
	}
	return out
}

// noteBuilt records the Step the session worked the Task at when it committed to its branch,
// unless it worked under review: a reviewer's commit makes no builder.
func (s *session) noteBuilt(ctx context.Context) {
	if s.d.Step == nil || len(s.checkouts) == 0 {
		return
	}
	if id := s.d.Task.SkillID; id != nil {
		if sk, ok := s.r.skill(ctx, s.rec, *id); ok && s.r.isReview(ctx, s.rec, sk) {
			return
		}
	}
	now := tips(ctx, s.checkouts)
	moved := false
	for k, sha := range now {
		if sha != s.tips[k] {
			moved = true
		}
	}
	if !moved {
		return
	}
	b, err := json.Marshal(builtRecord{StepID: s.d.Step.ID, Step: s.d.Step.Name, Agent: s.a.name(), At: time.Now().UTC()})
	if err == nil {
		err = os.WriteFile(filepath.Join(s.dir, builtFile), b, 0o600)
	}
	if err != nil {
		s.log.Warn("recording the Step the Task was built at", "err", err)
	}
}
