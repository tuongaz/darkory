package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
)

// What a session leaves behind for later, in <data>/sessions/<TASK-KEY>: the logs it could not
// attach yet, and the Step it built the Task at.

// keptDir holds a Task's session logs waiting to be attached: each <name> beside <name>.json.
const keptDir = "kept"

// keptLog is a session log waiting to be attached to Task, as the agent Member whose session it
// was, under the Shift's Claim (empty in a log kept before the Runner named it).
type keptLog struct {
	Task, Agent, Name string
	Claim             string `json:",omitempty"`
	At                time.Time
}

// keepLog keeps a session's log until it can be attached, and wakes attachKept.
func (r *Runner) keepLog(a *agent, task, claim, name string, content []byte) error {
	dir := filepath.Join(r.cfg.Data, "sessions", task, keptDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
		return err
	}
	b, err := json.Marshal(keptLog{Task: task, Agent: a.me.Member.ID, Name: name, Claim: claim, At: time.Now().UTC()})
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
			r.log.Warn("a kept Shift log's record does not read", "file", meta, "err", err)
			continue
		}
		var a *agent
		for _, x := range r.agents {
			if shortid.Canonical(x.me.Member.ID) == shortid.Canonical(k.Agent) { // a log kept before ids were short has the long form
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
		err = a.rec.Attach(ctx, k.Task, k.Name, client.EvidenceKindLog, k.Claim, content)
		switch {
		case err == nil:
			os.Remove(strings.TrimSuffix(meta, ".json"))
			os.Remove(meta)
			os.Remove(filepath.Dir(meta))
			r.log.Info("attached a kept Shift log", "agent", a.name(), "task", k.Task, "evidence", k.Name)
		case refusedBy(err, client.ErrorCodeNotHolder):
			// Still held by another; it comes back when that Claim ends.
		case ctx.Err() == nil:
			r.log.Debug("attaching a kept Shift log", "task", k.Task, "evidence", k.Name, "err", err)
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

// noteReviewing records, as a review session starts and before its agent runs, the commit the
// review is shown on each branch, in a Note by the reviewer: "Reviewing <branch> at <sha> in
// <Workspace>." A later merge calls the Task reviewed work only where its branch is still that
// commit (reviewed in merge.go): a commit after it, the reviewer's own included, however dated,
// is not what was reviewed. Written before the agent starts, it is the first such Note of the
// Claim, which is the one the merge reads.
func (s *session) noteReviewing(ctx context.Context) {
	if len(s.checkouts) == 0 || s.d.Task.SkillID == nil {
		return
	}
	if sk, ok := s.r.skill(ctx, s.rec, *s.d.Task.SkillID); !ok || !s.r.isReview(ctx, s.rec, sk) {
		return
	}
	var lines []string
	for _, c := range s.checkouts {
		if sha := s.tips[c.Workspace.Path+"\x00"+c.Branch]; sha != "" {
			lines = append(lines, fmt.Sprintf("Reviewing %s at %s in %s.", c.Branch, sha, c.Workspace.Name))
		}
	}
	if len(lines) == 0 {
		return
	}
	if err := s.rec.Note(ctx, s.key, strings.Join(lines, "\n")); err != nil {
		s.log.Warn("recording the commit the review is shown", "err", err)
	}
}
