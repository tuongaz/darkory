package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// A session works in <data>/workspaces/<TASK-KEY>, which holds one git worktree per Workspace the
// Task names, each on a branch named after the Task, made from the Feature's branch or, for a
// quick Feature, the default branch (ADR 0014). Everything under <data>/workspaces is the
// runner's. It records every branch it makes in a ledger there, and never touches a branch the
// ledger does not hold, except to merge into the default branch at Ship.

// Checkout is one Workspace in a session's directory.
type Checkout struct {
	Workspace Workspace
	// Dir is the worktree, <data>/workspaces/<TASK-KEY>/<workspace name>.
	Dir string
	// Branch is the Task's branch, <TASK-KEY>/<slug of its title>.
	Branch string
	// Base is the branch Branch is made from: feature/<FEATURE-KEY>, or the default branch for a
	// quick Feature.
	Base string
}

// FeatureBranch is the branch a Feature's Tasks merge into.
func FeatureBranch(feature string) string { return "feature/" + feature }

// TaskBranch is the branch a Task works on: its key, then its title made short and plain.
func TaskBranch(key, title string) string { return key + "/" + Slug(title) }

// Slug is title in lower case, with every run of other characters than letters and digits made
// one '-', cut at 40 characters on a word boundary; "task" when nothing is left.
func Slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
			continue
		}
		dash = true
	}
	s := b.String()
	if len(s) > 40 {
		s = s[:40]
		if i := strings.LastIndexByte(s, '-'); i > 20 {
			s = s[:i]
		}
		s = strings.TrimRight(s, "-")
	}
	if s == "" {
		return "task"
	}
	return s
}

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

// TaskDir is a Task's directory under data.
func TaskDir(data, task string) string { return filepath.Join(data, "workspaces", task) }

// PlanCheckouts says where each git Workspace of a Task goes and on which branches. Workspaces of
// other kinds are left out. The default branch of a Workspace that names none is main here;
// Prepare asks the repository.
func PlanCheckouts(data, task, title, feature string, quick bool, workspaces []Workspace) []Checkout {
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
		base := FeatureBranch(feature)
		if quick {
			base = or(ws.DefaultBranch, "main")
		}
		out = append(out, Checkout{Workspace: ws, Dir: filepath.Join(TaskDir(data, task), name), Branch: TaskBranch(task, title), Base: base})
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
	// Task or Feature is the key it was made for.
	Task    string `json:",omitempty"`
	Feature string `json:",omitempty"`
	At      time.Time
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
// worktree, or its branch. The Feature's branch is made from the default branch when it is
// missing. It refuses a Task branch the runner did not make.
func (r *Runner) Prepare(ctx context.Context, task, feature string, plan []Checkout) ([]Checkout, error) {
	dir := TaskDir(r.cfg.Data, task)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	out := slices.Clone(plan)
	for i := range out {
		c := &out[i]
		repo := c.Workspace.Path
		// Two sessions of one runner prepare in one repository at once, as two builders on one
		// Feature do; git's worktree list and branches are the repository's own.
		unlock := r.lockRepo(repo)
		err := r.prepareOne(ctx, task, feature, c)
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
func (r *Runner) prepareOne(ctx context.Context, task, feature string, c *Checkout) error {
	repo := c.Workspace.Path
	if c.Workspace.DefaultBranch == "" {
		c.Workspace.DefaultBranch = defaultBranch(ctx, repo)
		if c.Base == "main" {
			c.Base = c.Workspace.DefaultBranch
		}
	}
	if _, err := os.Stat(filepath.Join(c.Dir, ".git")); err == nil {
		// An earlier session's worktree, kept while the Task is open.
		if branch, err := runGit(ctx, c.Dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && strings.HasPrefix(branch, task+"/") {
			c.Branch = branch
			return nil
		}
		return fmt.Errorf("%s exists and is not on a branch of %s; remove it to start again", c.Dir, task)
	}
	runGit(ctx, repo, "worktree", "prune")
	existing, err := branchesWithPrefix(ctx, repo, task+"/")
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
		if _, err := runGit(ctx, repo, "worktree", "add", c.Dir, c.Branch); err != nil {
			return err
		}
		return nil
	}
	if !branchExists(ctx, repo, c.Base) {
		if c.Base != FeatureBranch(feature) {
			return fmt.Errorf("%s has no branch %s", repo, c.Base)
		}
		if err := r.makeFeatureBranch(ctx, c.Workspace, feature); err != nil {
			return err
		}
	}
	if _, err := runGit(ctx, repo, "worktree", "add", "-b", c.Branch, c.Dir, c.Base); err != nil {
		return err
	}
	if err := r.ledger.add(Made{Repo: repo, Branch: c.Branch, Base: c.Base, Task: task, At: time.Now().UTC()}); err != nil {
		return err
	}
	return nil
}

// makeFeatureBranch makes feature/<KEY> from the Workspace's default branch, and pushes it when
// the Workspace is merged through pull requests, so they have a base.
func (r *Runner) makeFeatureBranch(ctx context.Context, ws Workspace, feature string) error {
	repo, branch := ws.Path, FeatureBranch(feature)
	def := or(ws.DefaultBranch, defaultBranch(ctx, repo))
	if _, err := runGit(ctx, repo, "branch", branch, def); err != nil {
		return err
	}
	if err := r.ledger.add(Made{Repo: repo, Branch: branch, Base: def, Feature: feature, At: time.Now().UTC()}); err != nil {
		return err
	}
	r.log.Info("made the Feature's branch", "feature", feature, "workspace", ws.Name, "branch", branch, "from", def)
	if ws.Mode == ModePullRequest {
		if _, err := runGit(ctx, repo, "push", "--set-upstream", "origin", branch); err != nil {
			r.log.Warn("could not push the Feature's branch", "feature", feature, "branch", branch, "err", err)
		}
	}
	return nil
}

// RemoveCheckouts removes a Task's worktrees, keeping their branches. A worktree with uncommitted
// changes stays, and so does the directory holding it.
func (r *Runner) RemoveCheckouts(ctx context.Context, task string) {
	dir := TaskDir(r.cfg.Data, task)
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
