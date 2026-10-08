package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// Merges follow the record (ADR 0015): a worked Task ending Done merges its branch into its base,
// its Parent's branch for a Subtask or the default branch for a Task with no Parent, whoever
// completed it: a review's advance into Done normally, its holder's own, without review,
// otherwise, which the merge's Note then says. A Parent's Complete merges its branch into the
// default branch, or opens its pull request. In a Workspace merged through pull requests GitHub
// merges, and the runner reads the merged pull request carrying the Task's key. The merger works
// through the Activity entries one at a time, in order, so a Subtask's merge lands before the
// Complete of its Parent that follows it.

// logError reports a failure the merger met, unless the runner is stopping, which explains it.
func (r *Runner) logError(ctx context.Context, msg string, args ...any) {
	if ctx.Err() == nil {
		r.log.Error(msg, args...)
	}
}

func (r *Runner) merger(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case a := <-r.merges:
			switch a.Kind {
			case client.ActivityKindTaskCompleted:
				d, err := r.reader.Task(ctx, a.SubjectID)
				if err != nil {
					r.logError(ctx, "reading a completed Task", "task", a.SubjectID, "err", err)
					continue
				}
				if len(d.Subtasks) > 0 {
					r.parentCompleted(ctx, a, d)
					continue
				}
				r.completed(ctx, a, d)
				r.taskEnded(ctx, a.SubjectID)
			case client.ActivityKindTaskDropped:
				r.taskEnded(ctx, a.SubjectID)
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
// it is the review a merge normally follows.
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

// merged says whether a Task of kind has its branch merged when it ends Done: worked Tasks and an
// Acceptance, whose fixes are work like any other. A Breakdown's or a Retrospective's branch only
// holds what its agent read.
func merged(kind client.TaskKind) bool { return kind == client.Work || kind == client.Acceptance }

// completed merges the branch of a Task that just ended Done.
func (r *Runner) completed(ctx context.Context, a client.Activity, d *client.TaskDetail) {
	if !merged(d.Task.Kind) {
		return
	}
	rec := r.reader
	claimID, _ := a.Payload["claim_id"].(string)
	var claim *client.Claim
	for i := range d.Claims {
		if d.Claims[i].ID == claimID {
			claim = &d.Claims[i]
		}
	}
	by := ptrValue(a.ActorID)
	skill, review := "", false
	if claim != nil {
		by = claim.HolderID
		if claim.SkillID != nil {
			if sk, ok := r.skill(ctx, rec, *claim.SkillID); ok {
				skill, review = sk.Name, r.isReview(ctx, rec, sk)
			}
		}
	}
	unreviewed := ""
	if !review {
		unreviewed = "completed by " + r.memberName(ctx, by)
		if skill != "" {
			unreviewed += " under " + skill
		}
		unreviewed += ", without review"
	}
	r.mergeTask(ctx, r.actingAs(by), d, unreviewed)
}

func ptrValue[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

// memberName names a Member by id: one of the runner's agents, else from the Organisation's list.
func (r *Runner) memberName(ctx context.Context, id string) string {
	for _, a := range r.agents {
		if a.me.Member.ID == id {
			return a.name()
		}
	}
	if members, err := r.reader.Members(ctx); err == nil {
		for _, m := range members {
			if m.ID == id {
				return m.Name
			}
		}
	}
	return or(id, "someone")
}

// actingAs is the Record of the runner's agent member whose advance or Complete merged, the
// reviewer normally, so the merge's Notes and Tasks are that agent's; the runner's reader when the
// completer is not one of its agents.
func (r *Runner) actingAs(member string) Record {
	for _, a := range r.agents {
		if a.me.Member.ID == member {
			return a.rec
		}
	}
	return r.reader
}

// mergeTask merges a done Task's branch into its base in each of its Workspaces, or reads its
// merged pull request, and records how it went in a Note on the Task, as rec. unreviewed says who
// completed it, and under which Skill, when it was not a review's.
func (r *Runner) mergeTask(ctx context.Context, rec Record, d *client.TaskDetail, unreviewed string) {
	how := ""
	if unreviewed != "" {
		how = "; " + unreviewed
	}
	key := d.Task.Key
	parent, err := rec.Parent(ctx, d)
	if err != nil {
		r.logError(ctx, "reading a done Task's Parent", "task", key, "err", err)
		return
	}
	wss, err := rec.Workspaces(ctx, d)
	if err != nil {
		r.logError(ctx, "reading a done Task's Workspaces", "task", key, "err", err)
		return
	}
	var lines []string
	for _, ws := range wss {
		made, err := r.ledger.find(ws.Path, func(m Made) bool { return m.Task == key && strings.HasPrefix(m.Branch, taskPrefix(key)) })
		if err != nil || len(made) == 0 {
			continue
		}
		branch, target := made[0].Branch, made[0].Base
		if ws.Mode == ModePullRequest {
			lines = append(lines, r.pullRequestLine(ctx, ws, branch, target, how))
			continue
		}
		unlock := r.lockRepo(ws.Path)
		if parent != nil && target == ParentBranch(parent.Key) && !branchExists(ctx, ws.Path, target) {
			if err := r.makeParentBranch(ctx, ws, parent.Key); err != nil {
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
			line := fmt.Sprintf("%s: did not merge %s into %s: %v.", ws.Name, branch, target, err)
			lines = append(lines, line+r.resolve(ctx, rec, d, parent, ws, branch, target, err.Error()+"; commit or stash them, then merge "+branch+" by hand or here.", unreviewed))
		case err != nil:
			lines = append(lines, fmt.Sprintf("%s: could not merge %s into %s: %v", ws.Name, branch, target, err))
			r.logError(ctx, "merging a done Task's branch", "task", key, "workspace", ws.Name, "err", err)
		case res.Conflict != "":
			line := fmt.Sprintf("%s: merging %s into %s conflicted, so nothing was merged.", ws.Name, branch, target)
			lines = append(lines, line+r.resolve(ctx, rec, d, parent, ws, branch, target, res.Conflict, unreviewed)+"\n"+res.Conflict)
		case res.Already:
			lines = append(lines, fmt.Sprintf("%s: %s was already merged into %s (%s).", ws.Name, branch, target, short(res.Commit)))
		default:
			lines = append(lines, fmt.Sprintf("Merged %s into %s at %s (%s)%s.", branch, target, short(res.Commit), ws.Name, how))
			r.log.Info("merged a done Task's branch", "task", key, "workspace", ws.Name, "branch", branch, "into", target, "commit", short(res.Commit),
				"reviewed", unreviewed == "")
		}
	}
	if len(lines) == 0 {
		return
	}
	r.recordMerge(ctx, rec, key, strings.Join(lines, "\n"))
}

// pullRequestLine says how a done Task's branch lands in a Workspace merged through pull requests:
// the merged pull request whose head is the branch, or that it lands when its pull request merges.
func (r *Runner) pullRequestLine(ctx context.Context, ws Workspace, branch, target, how string) string {
	prs, err := r.gh.MergedPRs(ctx, ws.Path)
	if err == nil {
		for _, pr := range prs {
			if pr.HeadRefName == branch {
				return fmt.Sprintf("%s: %s was merged into %s through pull request #%d (%s)%s.", ws.Name, branch, target, pr.Number, pr.URL, how)
			}
		}
	}
	return fmt.Sprintf("%s: %s lands in %s through its pull request, not merged on GitHub yet%s.", ws.Name, branch, target, how)
}

// short is a commit's short name.
func short(sha string) string { return sha[:min(len(sha), 12)] }

// recordMerge records what a merge did in a Note on the done Task key, which a Member of its
// Project may write though nobody holds it.
func (r *Runner) recordMerge(ctx context.Context, rec Record, key, text string) {
	if err := rec.Note(ctx, key, text); err != nil {
		r.logError(ctx, "could not record a merge", "on", key, "err", err)
	}
}

// resolve files the Task that resolves a merge of a done Task's branch the runner could not make,
// at the Step a session of this runner last committed to that branch at (its builder's), else the
// Project's first work Step; it says so in the words it returns for the merge's Note. A done Task
// stays done (CONTEXT.md: a Task ends done or dropped), so its work goes on in the new Task, whose
// branch merges into the done Task's base while that base is open: the Parent's branch, under the
// Parent. When the Parent has ended (the conflicting Subtask's end completed it) the new Task
// stands alone on a branch from the default branch and carries the work there, the Parent's own
// merge having gone without it (parentCompleted). unreviewed is as for mergeTask.
func (r *Runner) resolve(ctx context.Context, rec Record, d *client.TaskDetail, parent *ParentInfo, ws Workspace, branch, target, conflict, unreviewed string) string {
	key := d.Task.Key
	done := fmt.Sprintf("The review of %s advanced it into Done", key)
	if unreviewed != "" {
		done = fmt.Sprintf("%s was %s", key, unreviewed)
	}
	title := fmt.Sprintf("Resolve the merge of %s into %s", branch, target)
	work := fmt.Sprintf("Merge %s into this Task's branch, resolve what conflicts, run the tests, commit, and advance it as any "+
		"work: this Task's branch merges into %s when it is done.", branch, target)
	// It works in the Workspace the merge did not go into, whatever its Parent or Project names.
	nt := client.FileTaskBody{Title: title, Workspaces: &[]string{ws.ID}}
	switch {
	case parent != nil && parent.Open:
		nt.Parent = &parent.ID
	case parent != nil:
		def := or(ws.DefaultBranch, defaultBranch(ctx, ws.Path))
		nt.Title, nt.Project = fmt.Sprintf("Resolve the merge of %s into %s", branch, def), &d.Task.ProjectID
		work = fmt.Sprintf("%s has ended, so its branch %s merged into %s without %s's work, and this Task stands alone, on a "+
			"branch from %s. Merge %s into this Task's branch, resolve what conflicts, run the tests, commit, and advance it as any "+
			"work: this Task's branch merges into %s when it is done, carrying %s's work there.", parent.Key, target, def, key, def,
			branch, def, key)
	default:
		nt.Project = &d.Task.ProjectID
	}
	body := fmt.Sprintf("%s, but merging its branch %s into %s in the Workspace %s did not go in, so the runner "+
		"left both branches as they were.\n\n%s\n\n%s", done, branch, target, ws.Name, conflict, work)
	nt.Description = &body
	step, stepName := r.builtAt(key)
	if step != "" {
		nt.Step = &step
	}
	t, err := rec.File(ctx, nt)
	if err != nil && step != "" && refusedBy(err, client.ErrorCodeNotFound, client.ErrorCodeInvalid, client.ErrorCodeNoStep) {
		// The Step went from the Workflow since: the Project's first work Step then.
		nt.Step, stepName = nil, ""
		t, err = rec.File(ctx, nt)
	}
	if err != nil {
		r.logError(ctx, "could not file the Task that resolves a merge; merge it by hand", "task", key, "branch", branch, "into", target,
			"workspace", ws.Name, "err", err)
		return " No Task could be filed to resolve it; merge it by hand."
	}
	r.log.Info("a merge did not go in; filed a Task to resolve it", "task", key, "resolve", t.Key, "branch", branch, "into", target)
	where := ""
	if stepName != "" {
		where = " at " + stepName + ", where it was built,"
	}
	return fmt.Sprintf(" Filed %s%s to resolve it.", t.Key, where)
}

// parentCompleted merges a completed Parent's branch into the default branch in every Workspace
// it has one, or opens its pull request, and records it in a Note on the Parent, which names any
// done Subtask whose work the branch lacks (its merge conflicted).
func (r *Runner) parentCompleted(ctx context.Context, a client.Activity, d *client.TaskDetail) {
	key := d.Task.Key
	branch := ParentBranch(key)
	made, err := r.ledger.find("", func(m Made) bool { return m.Parent == key && m.Branch == branch })
	if err != nil || len(made) == 0 {
		return
	}
	rec := r.actingAs(ptrValue(a.ActorID))
	all, _ := rec.AllWorkspaces(ctx)
	var lines []string
	for _, m := range made {
		ws := Workspace{Name: m.Repo, Path: m.Repo, Mode: ModePlain}
		for _, w := range all {
			if samePath(w.Path, m.Repo) {
				ws = w
			}
		}
		def := or(ws.DefaultBranch, defaultBranch(ctx, m.Repo))
		if ws.Mode == ModePullRequest {
			url, err := r.gh.CreatePR(ctx, m.Repo, def, branch, fmt.Sprintf("%s: %s", key, d.Task.Title),
				fmt.Sprintf("Completes %s, %s. Merging this pull request lands its Subtasks' work on %s.", key, d.Task.Title, def))
			if err != nil {
				lines = append(lines, fmt.Sprintf("%s: could not open the pull request of %s into %s: %v", ws.Name, branch, def, err))
				r.logError(ctx, "opening a completed Parent's pull request", "parent", key, "workspace", ws.Name, "err", err)
				continue
			}
			lines = append(lines, fmt.Sprintf("%s: opened %s, the pull request of %s into %s.", ws.Name, url, branch, def))
			continue
		}
		// A done Subtask whose merge into the branch conflicted is missing from it: the merge goes on
		// without that work, which the Task resolving the conflict carries into the default branch.
		without := ""
		if missing := r.unmerged(ctx, d, m.Repo, branch); len(missing) > 0 {
			without = fmt.Sprintf(" It went without the work of %s, whose merge into %s conflicted; the Task filed to resolve that carries "+
				"it into %s.", strings.Join(missing, ", "), branch, def)
		}
		unlock := r.lockRepo(m.Repo)
		res, err := mergeBranch(ctx, m.Repo, branch, def, fmt.Sprintf("Merge %s into %s\n\nComplete %s: %s", branch, def, key, d.Task.Title))
		unlock()
		switch {
		case err != nil:
			lines = append(lines, fmt.Sprintf("%s: could not merge %s into %s: %v. Merge it by hand.", ws.Name, branch, def, err))
			r.logError(ctx, "merging a completed Parent's branch", "parent", key, "workspace", ws.Name, "err", err)
		case res.Conflict != "":
			lines = append(lines, fmt.Sprintf("%s: merging %s into %s conflicted, so nothing was merged; merge it by hand.\n%s", ws.Name, branch, def, res.Conflict))
			r.logError(ctx, "a completed Parent's branch conflicts with the default branch; merge it by hand", "parent", key, "workspace", ws.Name)
		case res.Already:
			lines = append(lines, fmt.Sprintf("%s: %s was already merged into %s (%s).%s", ws.Name, branch, def, short(res.Commit), without))
		default:
			lines = append(lines, fmt.Sprintf("Merged %s into %s at %s (%s).%s", branch, def, short(res.Commit), ws.Name, without))
			r.log.Info("merged a completed Parent's branch", "parent", key, "workspace", ws.Name, "into", def, "commit", short(res.Commit))
		}
	}
	r.recordMerge(ctx, rec, key, strings.Join(lines, "\n"))
}

// unmerged are the keys of a Parent's Subtasks that ended Done with a branch in repo whose work is
// not in the Parent's branch.
func (r *Runner) unmerged(ctx context.Context, d *client.TaskDetail, repo, branch string) []string {
	var out []string
	for _, st := range d.Subtasks {
		if st.State != client.TaskStateDone || !merged(st.Kind) {
			continue
		}
		made, err := r.ledger.find(repo, func(m Made) bool { return m.Task == st.Key && m.Base == branch })
		if err != nil {
			continue
		}
		for _, m := range made {
			if branchExists(ctx, repo, m.Branch) && !isAncestor(ctx, repo, m.Branch, branch) {
				out = append(out, st.Key)
				break
			}
		}
	}
	return out
}

// pollPullRequests completes a Task at a review Step whose pull request was merged on GitHub, in
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
			if seen[id] || key == "" || pr.HeadRefName == ParentBranch(key) {
				// A Parent's own pull request lands it; there is nothing to complete.
				continue
			}
			if r.completeByPR(ctx, key, pr) {
				seen[id] = true
			}
		}
	}
}

// completeByPR completes Task key, whose pull request pr was merged, when it waits at a review
// Step: it advances it along the one Connector out of that Step into Done. It says whether the
// pull request needs no more looking at.
func (r *Runner) completeByPR(ctx context.Context, key string, pr PullRequest) bool {
	d, err := r.reader.Task(ctx, key)
	if err != nil {
		return remote.CodeOf(err) == client.ErrorCodeNotFound
	}
	if d.Task.State != client.TaskStateOpen || len(d.Subtasks) > 0 {
		return true
	}
	if d.Task.SkillID == nil {
		return false // at a hold or aimed; it may reach review later
	}
	if sk, ok := r.skill(ctx, r.reader, *d.Task.SkillID); !ok || !r.isReview(ctx, r.reader, sk) {
		return false // not at review yet; look again next time
	}
	s := r.session(d.Task.ID)
	if s == nil && d.Task.Claim != nil {
		return false // someone else holds it; look again next time
	}
	var done []string
	for _, k := range d.Connectors {
		if k.ToStepID == nil {
			done = append(done, k.Name)
		}
	}
	if len(done) != 1 {
		note := fmt.Sprintf("Pull request #%d (%s) was merged on GitHub, but %d ways lead from %s into Done, so the runner "+
			"cannot tell which the merge means: advance %s by hand.", pr.Number, pr.URL, len(done), stepName(d), key)
		rec := r.reader
		if s != nil {
			rec = s.rec
		}
		if err := rec.Note(ctx, key, note); err != nil {
			r.logError(ctx, "noting a merged pull request the runner cannot act on", "task", key, "err", err)
		}
		return true
	}
	note := fmt.Sprintf("Pull request #%d (%s) was merged on GitHub, which completes the review.", pr.Number, pr.URL)
	if s != nil {
		// This runner's session holds the review: advance it in that Session.
		if err := s.rec.Advance(ctx, key, done[0], note); err != nil {
			r.logError(ctx, "completing a review whose pull request merged", "task", key, "err", err)
			return false
		}
		return true
	}
	for _, a := range r.agents {
		rec, err := r.dial(a.token, remote.NewSessionID())
		if err != nil {
			continue
		}
		if _, err := rec.Claim(ctx, key, r.t.ClaimTimeout, ""); err != nil {
			continue
		}
		err = rec.Advance(ctx, key, done[0], note)
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

// builtAt is the Step a session of this runner last committed to Task key's branch at, by id and
// name; empty when none did.
func (r *Runner) builtAt(key string) (id, name string) {
	b, err := os.ReadFile(filepath.Join(r.cfg.Data, "sessions", key, builtFile))
	if err != nil {
		return "", ""
	}
	var rec builtRecord
	if json.Unmarshal(b, &rec) != nil {
		return "", ""
	}
	return rec.StepID, rec.Step
}
