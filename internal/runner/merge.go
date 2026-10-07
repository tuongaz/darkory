package runner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// Merges follow the record's two gates (ADR 0014): a review completing merges the Task's branch
// into its Feature's branch, or into the default branch for a quick Feature; Ship merges the
// Feature's branch into the default branch, or opens its pull request. The merger works through
// the Activity entries one at a time, in order, so a review's merge lands before the Ship that
// follows it.

// logError reports a failure the merger met, unless the runner is stopping, which explains it.
func (r *Runner) logError(ctx context.Context, msg string, args ...any) {
	if ctx.Err() == nil {
		r.log.Error(msg, args...)
	}
}

// shipRecord names the Evidence a Ship's merge is recorded in on its Feature, which has no Notes.
func shipRecord(feature string) string { return "merge-" + feature + ".txt" }

func (r *Runner) merger(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case a := <-r.merges:
			switch a.Kind {
			case client.ActivityKindTaskCompleted:
				r.reviewed(ctx, a)
				r.taskEnded(ctx, a.SubjectID)
			case client.ActivityKindTaskDropped:
				r.taskEnded(ctx, a.SubjectID)
			case client.ActivityKindFeatureShipped:
				r.shipped(ctx, a.SubjectID)
			}
		}
	}
}

// taskEnded removes the worktrees of a Task that ended while no session of this runner works it;
// a session removes its own when it ends.
func (r *Runner) taskEnded(ctx context.Context, taskID string) {
	if r.session(taskID) != nil {
		return
	}
	d, err := r.reader.Task(ctx, taskID)
	if err != nil {
		return
	}
	r.RemoveCheckouts(ctx, d.Task.Key)
}

// isReview says whether a Skill is review, or a company Skill built on it: completing a Task under
// it is the review that merges.
func (r *Runner) isReview(ctx context.Context, rec Record, sk client.Skill) bool {
	if sk.Name == "review" {
		return true
	}
	if sk.BaseSkillID != nil {
		if base, ok := r.skill(ctx, rec, *sk.BaseSkillID); ok {
			return base.Name == "review"
		}
	}
	return false
}

// reviewed merges the branch of a Task whose review a Complete just ended.
func (r *Runner) reviewed(ctx context.Context, a client.Activity) {
	rec := r.reader
	claimID, _ := a.Payload["claim_id"].(string)
	d, err := rec.Task(ctx, a.SubjectID)
	if err != nil {
		r.logError(ctx, "reading a completed Task", "task", a.SubjectID, "err", err)
		return
	}
	var claim *client.Claim
	for i := range d.Claims {
		if d.Claims[i].ID == claimID {
			claim = &d.Claims[i]
		}
	}
	if claim == nil || claim.SkillID == nil {
		return
	}
	if sk, ok := r.skill(ctx, rec, *claim.SkillID); !ok || !r.isReview(ctx, rec, sk) {
		return
	}
	r.mergeTask(ctx, d, "")
}

// mergeTask merges a reviewed Task's branch in each of its Workspaces and records how it went.
// via says what completed the review, when it was not a reviewer's Complete.
func (r *Runner) mergeTask(ctx context.Context, d *client.TaskDetail, via string) {
	rec, key := r.reader, d.Task.Key
	f, err := rec.Feature(ctx, d.Feature.Key)
	if err != nil {
		r.logError(ctx, "reading a reviewed Task's Feature", "task", key, "err", err)
		return
	}
	wss, err := rec.Workspaces(ctx, d)
	if err != nil {
		r.logError(ctx, "reading a reviewed Task's Workspaces", "task", key, "err", err)
		return
	}
	var lines []string
	for _, ws := range wss {
		made, err := r.ledger.find(ws.Path, func(m Made) bool { return m.Task == key && strings.HasPrefix(m.Branch, key+"/") })
		if err != nil || len(made) == 0 {
			continue
		}
		branch := made[0].Branch
		if ws.Mode == ModePullRequest {
			lines = append(lines, fmt.Sprintf("%s: %s lands through its pull request%s.", ws.Name, branch, via))
			continue
		}
		def := or(ws.DefaultBranch, defaultBranch(ctx, ws.Path))
		target := FeatureBranch(f.Key)
		unlock := r.lockRepo(ws.Path)
		if f.Quick {
			target = def
		} else if !branchExists(ctx, ws.Path, target) {
			if err := r.makeFeatureBranch(ctx, ws, f.Key); err != nil {
				unlock()
				lines = append(lines, fmt.Sprintf("%s: could not make %s: %v", ws.Name, target, err))
				continue
			}
		}
		res, err := mergeBranch(ctx, ws.Path, branch, target, fmt.Sprintf("Merge %s into %s\n\n%s: %s", branch, target, key, d.Task.Title))
		unlock()
		var dirty ErrDirty
		switch {
		case errors.As(err, &dirty):
			lines = append(lines, fmt.Sprintf("%s: did not merge %s into %s: %v.", ws.Name, branch, target, err))
			r.resolve(ctx, d, f, ws, branch, target, err.Error()+"; commit or stash them, then merge "+branch+" by hand or here.")
		case err != nil:
			lines = append(lines, fmt.Sprintf("%s: could not merge %s into %s: %v", ws.Name, branch, target, err))
			r.logError(ctx, "merging a reviewed Task's branch", "task", key, "workspace", ws.Name, "err", err)
		case res.Conflict != "":
			lines = append(lines, fmt.Sprintf("%s: merging %s into %s conflicted, so nothing was merged.\n%s", ws.Name, branch, target, res.Conflict))
			r.resolve(ctx, d, f, ws, branch, target, res.Conflict)
		case res.Already:
			lines = append(lines, fmt.Sprintf("%s: %s was already merged into %s (%s).", ws.Name, branch, target, short(res.Commit)))
		default:
			lines = append(lines, fmt.Sprintf("Merged %s into %s at %s (%s).", branch, target, short(res.Commit), ws.Name))
			r.log.Info("merged a reviewed Task's branch", "task", key, "workspace", ws.Name, "branch", branch, "into", target, "commit", short(res.Commit))
		}
	}
	if len(lines) == 0 {
		return
	}
	r.recordMerge(ctx, key, d.Feature.Key, strings.Join(lines, "\n"))
}

// short is a commit's short name.
func short(sha string) string { return sha[:min(len(sha), 12)] }

// recordMerge records what a merge did: a Note on the reviewed Task key, which a Member of its
// Feature's Team may write though nobody holds it; or, for a Ship (key the Feature's), Evidence on
// the Feature.
func (r *Runner) recordMerge(ctx context.Context, key, feature, text string) {
	var err error
	if key == feature {
		err = r.reader.AttachFeature(ctx, feature, shipRecord(feature), []byte(text+"\n"))
	} else {
		err = r.reader.Note(ctx, key, text)
	}
	if err != nil {
		r.logError(ctx, "could not record a merge", "on", key, "err", err)
	}
}

// resolve files the work Task that resolves a merge the runner could not make: on the Feature
// while it is open, needing the Skill that built the reviewed Task.
func (r *Runner) resolve(ctx context.Context, d *client.TaskDetail, f *FeatureInfo, ws Workspace, branch, target, conflict string) {
	rec := r.reader
	title := fmt.Sprintf("Resolve the merge of %s into %s", branch, target)
	body := fmt.Sprintf("The review of %s completed, but merging its branch %s into %s in the Workspace %s did not go in, so the runner "+
		"left both branches as they were.\n\n%s\n\nMerge %s into this Task's branch, resolve what conflicts, run the tests, commit, and hand "+
		"over to review: this Task's branch merges into %s when its review completes.", d.Task.Key, branch, target, ws.Name, conflict, branch, target)
	skill := r.buildSkill(ctx, d)
	if f.State != client.FeatureStateOpen {
		r.logError(ctx, "a merge did not go in and its Feature has ended, so no Task can be filed on it; merge it by hand",
			"task", d.Task.Key, "branch", branch, "into", target, "workspace", ws.Name)
		return
	}
	t, err := rec.File(ctx, client.FileTaskBody{Feature: &f.Key, Skill: &skill, Title: title, Description: &body})
	if err != nil {
		r.logError(ctx, "could not file the Task that resolves a merge", "task", d.Task.Key, "err", err)
		return
	}
	r.log.Info("a merge conflicted; filed a Task to resolve it", "task", d.Task.Key, "resolve", t.Key, "branch", branch, "into", target)
}

// buildSkill is the Skill that built a Task: the one its last Claim under a Skill other than
// review was made under; engineer, the roster's, when there is none.
func (r *Runner) buildSkill(ctx context.Context, d *client.TaskDetail) string {
	for i := len(d.Claims) - 1; i >= 0; i-- {
		if id := d.Claims[i].SkillID; id != nil {
			if sk, ok := r.skill(ctx, r.reader, *id); ok && !r.isReview(ctx, r.reader, sk) {
				return sk.Name
			}
		}
	}
	return "engineer"
}

// shipped merges a shipped Feature's branch into the default branch in every Workspace it has
// one, or opens its pull request.
func (r *Runner) shipped(ctx context.Context, featureID string) {
	rec := r.reader
	f, err := rec.Feature(ctx, featureID)
	if err != nil {
		r.logError(ctx, "reading a shipped Feature", "feature", featureID, "err", err)
		return
	}
	if f.Quick {
		return // its one Task merged into the default branch when its review completed
	}
	branch := FeatureBranch(f.Key)
	made, err := r.ledger.find("", func(m Made) bool { return m.Feature == f.Key && m.Branch == branch })
	if err != nil || len(made) == 0 {
		return
	}
	all, _ := rec.AllWorkspaces(ctx)
	var lines []string
	for _, m := range made {
		ws := Workspace{Name: m.Repo, Path: m.Repo, Mode: ModePlain}
		for _, w := range all {
			if samePath(w.Path, m.Repo) {
				ws = w
			}
		}
		def := or(ws.DefaultBranch, m.Base)
		if ws.Mode == ModePullRequest {
			url, err := r.gh.CreatePR(ctx, m.Repo, def, branch, fmt.Sprintf("%s: %s", f.Key, f.Title),
				fmt.Sprintf("Ships %s, %s. Merging this pull request lands it on %s.", f.Key, f.Title, def))
			if err != nil {
				lines = append(lines, fmt.Sprintf("%s: could not open the pull request of %s into %s: %v", ws.Name, branch, def, err))
				r.logError(ctx, "opening a shipped Feature's pull request", "feature", f.Key, "workspace", ws.Name, "err", err)
				continue
			}
			lines = append(lines, fmt.Sprintf("%s: opened %s, the pull request of %s into %s.", ws.Name, url, branch, def))
			continue
		}
		unlock := r.lockRepo(m.Repo)
		res, err := mergeBranch(ctx, m.Repo, branch, def, fmt.Sprintf("Merge %s into %s\n\nShip %s: %s", branch, def, f.Key, f.Title))
		unlock()
		switch {
		case err != nil:
			lines = append(lines, fmt.Sprintf("%s: could not merge %s into %s: %v. Merge it by hand.", ws.Name, branch, def, err))
			r.logError(ctx, "merging a shipped Feature's branch", "feature", f.Key, "workspace", ws.Name, "err", err)
		case res.Conflict != "":
			lines = append(lines, fmt.Sprintf("%s: merging %s into %s conflicted, so nothing was merged; merge it by hand.\n%s", ws.Name, branch, def, res.Conflict))
			r.logError(ctx, "a shipped Feature's branch conflicts with the default branch; merge it by hand", "feature", f.Key, "workspace", ws.Name)
		case res.Already:
			lines = append(lines, fmt.Sprintf("%s: %s was already merged into %s (%s).", ws.Name, branch, def, short(res.Commit)))
		default:
			lines = append(lines, fmt.Sprintf("Merged %s into %s at %s (%s).", branch, def, short(res.Commit), ws.Name))
			r.log.Info("shipped a Feature's branch", "feature", f.Key, "workspace", ws.Name, "into", def, "commit", short(res.Commit))
		}
	}
	r.recordMerge(ctx, f.Key, f.Key, strings.Join(lines, "\n"))
}

// pollPullRequests completes the review of a Task whose pull request was merged on GitHub, in
// every Workspace in pull_request mode, every Poll.
func (r *Runner) pollPullRequests(ctx context.Context) {
	t := time.NewTicker(r.t.Poll)
	defer t.Stop()
	seen := map[string]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.pollOnce(ctx, seen)
		}
	}
}

func (r *Runner) pollOnce(ctx context.Context, seen map[string]bool) {
	all, err := r.reader.AllWorkspaces(ctx)
	if err != nil {
		return
	}
	for _, ws := range all {
		if ws.Mode != ModePullRequest {
			continue
		}
		prs, err := r.gh.MergedPRs(ctx, ws.Path)
		if err != nil {
			r.log.Warn("listing merged pull requests", "workspace", ws.Name, "err", err)
			continue
		}
		for _, pr := range prs {
			id := fmt.Sprintf("%s#%d", ws.Path, pr.Number)
			key := or(KeyOf(pr.HeadRefName), KeyOf(pr.Title))
			if seen[id] || key == "" || strings.HasPrefix(pr.HeadRefName, "feature/") {
				continue
			}
			if r.completeByPR(ctx, key, pr) {
				seen[id] = true
			}
		}
	}
}

// completeByPR completes the review of Task key, whose pull request pr was merged. It says
// whether the pull request needs no more looking at.
func (r *Runner) completeByPR(ctx context.Context, key string, pr PullRequest) bool {
	d, err := r.reader.Task(ctx, key)
	if err != nil {
		return remote.CodeOf(err) == client.ErrorCodeNotFound
	}
	if d.Task.State != client.TaskStateOpen {
		return true
	}
	if d.Task.SkillID == nil {
		return true
	}
	if sk, ok := r.skill(ctx, r.reader, *d.Task.SkillID); !ok || !r.isReview(ctx, r.reader, sk) {
		return false // not at review yet; look again next time
	}
	note := fmt.Sprintf("Pull request #%d (%s) was merged on GitHub, which completes the review.", pr.Number, pr.URL)
	if s := r.session(d.Task.ID); s != nil {
		// This runner's session holds the review: complete it in that Session.
		if err := s.rec.Complete(ctx, key, note); err != nil {
			r.logError(ctx, "completing a review whose pull request merged", "task", key, "err", err)
			return false
		}
		return true
	}
	if d.Task.Claim != nil {
		return false // someone else holds it; look again next time
	}
	for _, a := range r.agents {
		rec, err := r.dial(a.token, remote.NewSessionID())
		if err != nil {
			continue
		}
		if _, err := rec.Claim(ctx, key, r.t.ClaimTimeout, ""); err != nil {
			continue
		}
		err = rec.Complete(ctx, key, note)
		rec.CloseSession(context.WithoutCancel(ctx))
		if err != nil {
			r.logError(ctx, "completing a review whose pull request merged", "task", key, "agent", a.name(), "err", err)
			return false
		}
		r.log.Info("completed a review whose pull request merged", "task", key, "agent", a.name(), "pr", pr.Number)
		return true
	}
	r.log.Warn("no agent of this runner may take a review whose pull request merged", "task", key, "pr", pr.Number)
	return false
}
