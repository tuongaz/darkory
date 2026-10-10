package runner

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/branch"
)

// A session works in <data>/workspaces/<TASK-KEY>, which holds one git worktree per Workspace the
// Task names, each on a branch named after the Task, <key>-<slug>, made from its Parent's branch
// <parent-key> when it is a Subtask, else from the default branch (ADR 0015). Everything under
// <data>/workspaces is the runner's. It records every branch it makes in a ledger there, and never
// touches a branch the ledger does not hold, except to merge into the default branch when a Task
// with no Parent, or a Parent, completes.

// Checkout is one Workspace in a session's directory.
type Checkout struct {
	Workspace Workspace
	// Dir is the worktree, <data>/workspaces/<TASK-KEY>/<workspace name>.
	Dir string
	// Branch is the Task's branch, <task-key>-<slug of its title>.
	Branch string
	// Base is the branch Branch is made from and merges into: its Parent's branch, or the default
	// branch for a Task with no Parent.
	Base string
}

// ParentBranch is the branch a Parent's Subtasks start from and merge into (branch.Parent).
func ParentBranch(parent string) string { return branch.Parent(parent) }

// TaskBranch is the branch a Task works on (branch.Task).
func TaskBranch(key, title string) string { return branch.Task(key, title) }

// taskPrefix starts the name of every branch of a Task (branch.Prefix).
func taskPrefix(key string) string { return branch.Prefix(key) }

// Slug is title made short and plain for a branch (branch.Slug).
func Slug(title string) string { return branch.Slug(title) }

// dirName is a Workspace's name as a directory name.
func dirName(name string) string {
	b := []byte(name)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			b[i] = '-'
		}
	}
	s := strings.Trim(string(b), ".")
	if s == "" {
		return "workspace"
	}
	return s
}

// TaskDir is a Task's directory where it was before the Workspaces root could be set, under data;
// it is also where the Workspaces root defaults to for a data directory outside any checkout.
func TaskDir(data, task string) string { return filepath.Join(data, "workspaces", task) }

// DefaultWorkspaces is where Task directories go for the data directory data: <data>/workspaces,
// unless data is inside a git checkout or under a directory holding a CLAUDE.md. A session works
// in its Task's directory, and Claude Code reads every CLAUDE.md from there up to the root, so a
// session under another project would take that project's rules for its own. There it is
// ~/.darkory/workspaces/<data's name>-<a hash of data's path>, one per data directory.
func DefaultWorkspaces(data string) string {
	inside := false
	if out, err := exec.Command("git", "-C", data, "rev-parse", "--is-inside-work-tree").Output(); err == nil && strings.TrimSpace(string(out)) == "true" {
		inside = true
	}
	for dir := data; !inside; {
		if _, err := os.Stat(filepath.Join(dir, "CLAUDE.md")); err == nil {
			inside = true
		}
		up := filepath.Dir(dir)
		if up == dir {
			break
		}
		dir = up
	}
	home, err := os.UserHomeDir()
	if !inside || err != nil {
		return filepath.Join(data, "workspaces")
	}
	sum := sha256.Sum256([]byte(data))
	return filepath.Join(home, ".darkory", "workspaces", fmt.Sprintf("%s-%x", dirName(filepath.Base(data)), sum[:4]))
}

// taskDir is a Task's directory, holding its checkouts and the session's working directory: under
// the Workspaces root, or under <data>/workspaces when an earlier session left its worktrees there,
// so a Task begun before the root moved keeps working where it was until it ends.
func (r *Runner) taskDir(task string) string {
	if old := TaskDir(r.cfg.Data, task); old != filepath.Join(r.cfg.Workspaces, task) {
		if _, err := os.Stat(filepath.Join(old, checkoutsFile)); err == nil {
			return old
		}
	}
	return filepath.Join(r.cfg.Workspaces, task)
}

// PlanCheckouts says where each git Workspace of a Task goes, in its directory dir, and on which
// branches: from its Parent's branch when parent names one, else from the default branch.
// Workspaces of other kinds are left out. The default branch of a Workspace that names none is
// main here; Prepare asks the repository.
func PlanCheckouts(dir, task, title, parent string, workspaces []Workspace) []Checkout {
	var out []Checkout
	seen := map[string]bool{}
	for _, ws := range workspaces {
		if ws.Kind != "" && ws.Kind != "git" {
			continue
		}
		name := dirName(ws.Name)
		for i := 2; seen[name]; i++ {
			name = fmt.Sprintf("%s-%d", dirName(ws.Name), i)
		}
		seen[name] = true
		base := or(ws.DefaultBranch, "main")
		if parent != "" {
			base = ParentBranch(parent)
		}
		out = append(out, Checkout{Workspace: ws, Dir: filepath.Join(dir, name), Branch: TaskBranch(task, title), Base: base})
	}
	return out
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// Made is a branch the runner made, as its ledger records it.
type Made struct {
	// Repo is the repository's path; Branch the branch; Base what it was made from.
	Repo, Branch, Base string
	// Task or Parent is the key it was made for: a Task's own branch, or a Parent's.
	Task   string `json:",omitempty"`
	Parent string `json:",omitempty"`
	// Legacy is the key an entry written before model v2 carries under "Feature", for a branch
	// feature/<KEY> made then. Such entries are history: read and kept, and matched by nothing now.
	Legacy string `json:"Feature,omitempty"`
	At     time.Time
}

// ledger is the record of the branches the runner made, kept in <data>/workspaces/branches.json.
type ledger struct {
	mu   sync.Mutex
	path string
}

func (l *ledger) read() ([]Made, error) {
	b, err := os.ReadFile(l.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct{ Branches []Made }
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", l.path, err)
	}
	return doc.Branches, nil
}

// add records m.
func (l *ledger) add(m Made) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	list, err := l.read()
	if err != nil {
		return err
	}
	list = append(list, m)
	b, err := json.MarshalIndent(struct{ Branches []Made }{list}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}

// find returns the branches made in repo that match.
func (l *ledger) find(repo string, match func(Made) bool) ([]Made, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	list, err := l.read()
	if err != nil {
		return nil, err
	}
	var out []Made
	for _, m := range list {
		if (repo == "" || samePath(m.Repo, repo)) && match(m) {
			out = append(out, m)
		}
	}
	return out, nil
}

// made says whether the runner made branch in repo.
func (l *ledger) made(repo, branch string) (bool, error) {
	found, err := l.find(repo, func(m Made) bool { return m.Branch == branch })
	return len(found) > 0, err
}

func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

// checkoutsFile lists a Task directory's worktrees, so they can be removed later.
const checkoutsFile = "checkouts.json"

// Prepare makes the checkouts plan says, reusing what an earlier session of the Task left: its
// worktree, or its branch. The Parent's branch is made when it is missing (makeParentBranch). It
// refuses a Task branch the runner did not make.
func (r *Runner) Prepare(ctx context.Context, task, parent string, plan []Checkout) ([]Checkout, error) {
	dir := r.taskDir(task)
	if len(plan) > 0 {
		dir = filepath.Dir(plan[0].Dir) // the Task's directory the plan was made for
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	out := slices.Clone(plan)
	for i := range out {
		c := &out[i]
		repo := c.Workspace.Path
		// Two sessions of one runner prepare in one repository at once, as two builders on one
		// Parent do; git's worktree list and branches are the repository's own.
		unlock := r.lockRepo(repo)
		err := r.prepareOne(ctx, task, parent, c)
		unlock()
		if err != nil {
			return nil, err
		}
	}
	type entry struct{ Repo, Dir, Branch string }
	var list []entry
	for _, c := range out {
		list = append(list, entry{c.Workspace.Path, c.Dir, c.Branch})
	}
	b, _ := json.MarshalIndent(list, "", "  ")
	return out, os.WriteFile(filepath.Join(dir, checkoutsFile), b, 0o600)
}

// lockRepo holds the runner's lock on a repository until the function it returns is called.
func (r *Runner) lockRepo(repo string) func() {
	r.mu.Lock()
	l, ok := r.repos[filepath.Clean(repo)]
	if !ok {
		l = &sync.Mutex{}
		r.repos[filepath.Clean(repo)] = l
	}
	r.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// prepareOne makes or finds one checkout of a Task.
func (r *Runner) prepareOne(ctx context.Context, task, parent string, c *Checkout) error {
	repo := c.Workspace.Path
	if c.Workspace.DefaultBranch == "" {
		c.Workspace.DefaultBranch = defaultBranch(ctx, repo)
		if c.Base == "main" {
			c.Base = c.Workspace.DefaultBranch
		}
	}
	if _, err := os.Stat(filepath.Join(c.Dir, ".git")); err == nil {
		// An earlier session's worktree, kept while the Task is open.
		if branch, err := runGit(ctx, c.Dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && strings.HasPrefix(branch, taskPrefix(task)) {
			c.Branch = branch
			r.catchUp(ctx, task, c)
			return nil
		}
		return fmt.Errorf("%s exists and is not on a branch of %s; remove it to start again", c.Dir, task)
	}
	runGit(ctx, repo, "worktree", "prune")
	existing, err := branchesWithPrefix(ctx, repo, taskPrefix(task))
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		ok, err := r.ledger.made(repo, existing[0])
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("the branch %s in %s was not made by the runner; it will not work on it", existing[0], repo)
		}
		c.Branch = existing[0]
		if err := addWorktree(ctx, repo, c.Dir, c.Branch); err != nil {
			return err
		}
		r.catchUp(ctx, task, c)
		return nil
	}
	if !branchExists(ctx, repo, c.Base) {
		if parent == "" || c.Base != ParentBranch(parent) {
			return fmt.Errorf("%s has no branch %s", repo, c.Base)
		}
		if err := r.makeParentBranch(ctx, c.Workspace, parent); err != nil {
			return err
		}
	}
	// The branch goes in the ledger before the worktree is made: a worktree that fails to populate
	// would otherwise leave a branch the runner made but will not work on.
	if _, err := runGit(ctx, repo, "branch", c.Branch, startPoint(ctx, c.Workspace, c.Base)); err != nil {
		return err
	}
	if err := r.ledger.add(Made{Repo: repo, Branch: c.Branch, Base: c.Base, Task: task, At: time.Now().UTC()}); err != nil {
		return err
	}
	return addWorktree(ctx, repo, c.Dir, c.Branch)
}

// mergeWait is how long a session's start waits for the merges of its Parent's done Subtasks.
const mergeWait = 30 * time.Second

// awaitMerges waits, at most mergeWait, until the branch of each Subtask of parent that ended
// Done is in the Parent's branch, in each Workspace the runner merges itself, or the merger has
// tried it and could not. A Subtask a sibling blocked is takeable the moment the sibling ends,
// while the merger may not yet have merged it; started then, the session's branch would start
// from the Parent's branch without the very work it waited for.
func (r *Runner) awaitMerges(ctx context.Context, task string, parent *ParentInfo, wss []Workspace) {
	if parent == nil || len(parent.Done) == 0 {
		return
	}
	pending := func() []string {
		var out []string
		for _, ws := range wss {
			if ws.Mode == ModePullRequest {
				continue
			}
			base := ParentBranch(parent.Key)
			for _, key := range parent.Done {
				r.mu.Lock()
				tried := r.tried[key]
				r.mu.Unlock()
				if tried {
					continue
				}
				made, err := r.ledger.find(ws.Path, func(m Made) bool { return m.Task == key && strings.HasPrefix(m.Branch, taskPrefix(key)) })
				if err != nil || len(made) == 0 {
					continue
				}
				if branchExists(ctx, ws.Path, base) && isAncestor(ctx, ws.Path, "refs/heads/"+made[0].Branch, "refs/heads/"+base) {
					continue
				}
				out = append(out, key)
			}
		}
		return out
	}
	waiting := pending()
	if len(waiting) == 0 {
		return
	}
	r.log.Info("waiting for done Subtasks to merge into the Parent's branch", "task", task, "parent", parent.Key, "subtasks", waiting)
	deadline := time.Now().Add(mergeWait)
	for len(waiting) > 0 {
		if time.Now().After(deadline) {
			r.log.Warn("done Subtasks are not in the Parent's branch yet; starting without them", "task", task, "subtasks", waiting)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(250 * time.Millisecond):
		}
		waiting = pending()
	}
}

// catchUp brings a Task branch an earlier session left up to its base, in the checkout c: a Task
// released and taken again later, such as one that waited on a question, or one sent back, would
// otherwise be worked on its base as it was, without the work merged into it since (a sibling
// Subtask's, a design's). A branch with no commits of its own moves to the base; one with its
// own commits takes the base in a merge, and keeps its old start when that conflicts, which the
// merge into the base then meets as any conflict.
func (r *Runner) catchUp(ctx context.Context, task string, c *Checkout) {
	base := startPoint(ctx, c.Workspace, c.Base)
	if _, err := runGit(ctx, c.Dir, "rev-parse", "--verify", "--quiet", base+"^{commit}"); err != nil {
		return
	}
	if isAncestor(ctx, c.Dir, base, "HEAD") {
		return
	}
	how := "fast-forwarded"
	if isAncestor(ctx, c.Dir, "HEAD", base) {
		if _, err := runGit(ctx, c.Dir, "merge", "--ff-only", base); err != nil {
			r.log.Warn("could not bring a Task's branch up to its base", "task", task, "branch", c.Branch, "base", base, "err", err)
			return
		}
	} else {
		how = "merged"
		msg := fmt.Sprintf("Merge %s into %s\n\n%s: taken again, it takes what landed on %s since", base, c.Branch, task, c.Base)
		if _, _, err := gitOutput(ctx, c.Dir, identity(ctx, c.Workspace.Path), "merge", "--no-ff", "--no-edit", "-m", msg, base); err != nil {
			runGit(ctx, c.Dir, "merge", "--abort")
			r.log.Warn("a Task's branch conflicts with its base; it is worked as it was", "task", task, "branch", c.Branch, "base", base, "err", err)
			return
		}
	}
	r.log.Info("brought a Task's branch up to its base", "task", task, "branch", c.Branch, "base", base, "how", how)
}

// startPoint is where a new branch from base starts: base itself, or in a Workspace merged through
// pull requests the remote's base once fetched, since the pull requests merged into it on GitHub
// are there and not in the local branch. An Acceptance so starts from its Parent's branch with
// every Subtask's work in it.
func startPoint(ctx context.Context, ws Workspace, base string) string {
	if ws.Mode != ModePullRequest {
		return base
	}
	if _, err := runGit(ctx, ws.Path, "fetch", "--quiet", "origin", base); err != nil {
		return base
	}
	if _, err := runGit(ctx, ws.Path, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+base); err != nil {
		return base
	}
	return "origin/" + base
}

// makeParentBranch makes a Parent's branch <parent-key>: from the Parent's own branch when it was
// worked before it became a Parent (its holder split it), so that work is kept, else from the
// Workspace's default branch. It pushes it when the Workspace is merged through pull requests,
// so the Subtasks' pull requests have a base.
func (r *Runner) makeParentBranch(ctx context.Context, ws Workspace, parent string) error {
	repo, branch := ws.Path, ParentBranch(parent)
	from := or(ws.DefaultBranch, defaultBranch(ctx, repo))
	own, err := r.ledger.find(repo, func(m Made) bool { return m.Task == parent && strings.HasPrefix(m.Branch, taskPrefix(parent)) })
	if err != nil {
		return err
	}
	start := ""
	if len(own) > 0 && branchExists(ctx, repo, own[0].Branch) {
		from, start = own[0].Branch, own[0].Branch
	} else {
		start = startPoint(ctx, ws, from)
	}
	if _, err := runGit(ctx, repo, "branch", branch, start); err != nil {
		return err
	}
	if err := r.ledger.add(Made{Repo: repo, Branch: branch, Base: from, Parent: parent, At: time.Now().UTC()}); err != nil {
		return err
	}
	r.log.Info("made the Parent's branch", "parent", parent, "workspace", ws.Name, "branch", branch, "from", from)
	if ws.Mode == ModePullRequest {
		if _, err := runGit(ctx, repo, "push", "--set-upstream", "origin", branch); err != nil {
			r.log.Warn("could not push the Parent's branch", "parent", parent, "branch", branch, "err", err)
		}
	}
	return nil
}

// RemoveCheckouts removes a Task's worktrees, keeping their branches. A worktree with uncommitted
// changes stays, and so does the directory holding it.
func (r *Runner) RemoveCheckouts(ctx context.Context, task string) {
	dir := r.taskDir(task)
	b, err := os.ReadFile(filepath.Join(dir, checkoutsFile))
	if errors.Is(err, fs.ErrNotExist) {
		os.Remove(dir)
		return
	}
	if err != nil {
		r.log.Warn("reading a Task's checkouts", "task", task, "err", err)
		return
	}
	var list []struct{ Repo, Dir, Branch string }
	if err := json.Unmarshal(b, &list); err != nil {
		r.log.Warn("reading a Task's checkouts", "task", task, "err", err)
		return
	}
	kept := false
	for _, c := range list {
		if _, err := os.Stat(c.Dir); errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if _, err := runGit(ctx, c.Repo, "worktree", "remove", c.Dir); err != nil {
			r.log.Warn("kept a Task's worktree", "task", task, "dir", c.Dir, "err", err)
			kept = true
		}
	}
	if !kept {
		os.Remove(filepath.Join(dir, checkoutsFile))
		os.Remove(dir)
	}
}
