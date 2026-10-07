package runner

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestSlug(t *testing.T) {
	for title, want := range map[string]string{
		"Cart page":                            "cart-page",
		"  Fix: the API's 500 on /v1/tasks!! ": "fix-the-api-s-500-on-v1-tasks",
		"Break down: Checkout":                 "break-down-checkout",
		"Ünïcode only ✓":                       "n-code-only",
		"!!!":                                  "task",
		"A very long title that keeps going well past forty characters": "a-very-long-title-that-keeps-going-well",
	} {
		if got := Slug(title); got != want {
			t.Errorf("Slug(%q) = %q, want %q", title, got, want)
		}
	}
}

func TestPlanCheckouts(t *testing.T) {
	web := Workspace{ID: "w1", Name: "web", Kind: "git", Path: "/src/web", Mode: ModePlain, DefaultBranch: "trunk"}
	api := Workspace{ID: "w2", Name: "api server", Kind: "git", Path: "/src/api", Mode: ModePullRequest}
	ledger := Workspace{ID: "w3", Name: "books", Kind: "ledger", Path: "/books"}
	twin := Workspace{ID: "w4", Name: "web", Kind: "git", Path: "/src/web2"}

	got := PlanCheckouts("/d", "WEB-12", "Cart page", "WEB-1", false, []Workspace{web, api, ledger, twin})
	want := []Checkout{
		{Workspace: web, Dir: "/d/workspaces/WEB-12/web", Branch: "WEB-12/cart-page", Base: "feature/WEB-1"},
		{Workspace: api, Dir: "/d/workspaces/WEB-12/api-server", Branch: "WEB-12/cart-page", Base: "feature/WEB-1"},
		{Workspace: twin, Dir: "/d/workspaces/WEB-12/web-2", Branch: "WEB-12/cart-page", Base: "feature/WEB-1"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
	// A quick Feature's Task branches from the default branch.
	got = PlanCheckouts("/d", "WEB-30", "Fix the typo", "WEB-29", true, []Workspace{web, api})
	if got[0].Base != "trunk" || got[1].Base != "main" || got[0].Branch != "WEB-30/fix-the-typo" {
		t.Fatalf("quick: %+v", got)
	}
	if got := PlanCheckouts("/d", "WEB-12", "x", "WEB-1", false, nil); got != nil {
		t.Fatalf("no Workspaces: %+v", got)
	}
}

// isolateGit keeps the person's git configuration (signing, hooks, identity) out of a test.
func isolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

// gitRepo makes a repository on main with one commit of a.txt.
func gitRepo(t *testing.T) string {
	t.Helper()
	isolateGit(t)
	repo := t.TempDir()
	mustGit(t, repo, "init", "-q", "-b", "main")
	mustGit(t, repo, "config", "user.name", "Ada")
	mustGit(t, repo, "config", "user.email", "ada@example.com")
	commitFile(t, repo, "a.txt", "one\ntwo\nthree\n", "first")
	return repo
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := runGit(t.Context(), dir, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func commitFile(t *testing.T, dir, name, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, dir, "add", name)
	mustGit(t, dir, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "-q", "-m", msg)
}

func newTestRunner(t *testing.T) *Runner {
	t.Helper()
	r, err := New(Config{Data: t.TempDir(), Host: childHost{}, Darkory: "darkory"})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestPrepareMakesAndReusesCheckouts(t *testing.T) {
	repo := gitRepo(t)
	r := newTestRunner(t)
	ws := Workspace{Name: "web", Kind: "git", Path: repo, Mode: ModePlain}
	ctx := t.Context()

	// The Break down makes the Feature's branch from the default branch.
	plan := PlanCheckouts(r.cfg.Data, "WEB-2", "Break down: Checkout", "WEB-1", false, []Workspace{ws})
	got, err := r.Prepare(ctx, "WEB-2", "WEB-1", plan)
	if err != nil {
		t.Fatal(err)
	}
	if !branchExists(ctx, repo, "feature/WEB-1") || got[0].Branch != "WEB-2/break-down-checkout" {
		t.Fatalf("prepared %+v", got)
	}
	if head := mustGit(t, got[0].Dir, "symbolic-ref", "--short", "HEAD"); head != "WEB-2/break-down-checkout" {
		t.Fatalf("the worktree is on %s", head)
	}
	if b, err := os.ReadFile(filepath.Join(got[0].Dir, "a.txt")); err != nil || string(b) != "one\ntwo\nthree\n" {
		t.Fatalf("the worktree holds %q, %v", b, err)
	}
	made, _ := r.ledger.find(repo, func(Made) bool { return true })
	if len(made) != 2 || made[0].Branch != "feature/WEB-1" || made[0].Feature != "WEB-1" || made[1].Task != "WEB-2" {
		t.Fatalf("the ledger: %+v", made)
	}

	// A build Task works on its own branch from the Feature's.
	commitFile(t, got[0].Dir, "plan.txt", "plan\n", "plan") // on WEB-2's branch, not the Feature's
	plan = PlanCheckouts(r.cfg.Data, "WEB-3", "Cart page", "WEB-1", false, []Workspace{ws})
	got, err = r.Prepare(ctx, "WEB-3", "WEB-1", plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(got[0].Dir, "plan.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("WEB-3's worktree has WEB-2's commit: %v", err)
	}
	commitFile(t, got[0].Dir, "cart.txt", "cart\n", "cart")

	// The review's session finds the worktree its builder left.
	again, err := r.Prepare(ctx, "WEB-3", "WEB-1", PlanCheckouts(r.cfg.Data, "WEB-3", "Cart page, renamed", "WEB-1", false, []Workspace{ws}))
	if err != nil || again[0].Branch != "WEB-3/cart-page" || again[0].Dir != got[0].Dir {
		t.Fatalf("again: %+v, %v", again, err)
	}
	// Removed, the worktree comes back on the same branch, whatever the title says now.
	r.RemoveCheckouts(ctx, "WEB-3")
	if _, err := os.Stat(TaskDir(r.cfg.Data, "WEB-3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the Task's directory is still there: %v", err)
	}
	if !branchExists(ctx, repo, "WEB-3/cart-page") {
		t.Fatal("removing the worktree removed the branch")
	}
	again, err = r.Prepare(ctx, "WEB-3", "WEB-1", PlanCheckouts(r.cfg.Data, "WEB-3", "Cart page, renamed", "WEB-1", false, []Workspace{ws}))
	if err != nil || again[0].Branch != "WEB-3/cart-page" {
		t.Fatalf("after removal: %+v, %v", again, err)
	}
	if _, err := os.Stat(filepath.Join(again[0].Dir, "cart.txt")); err != nil {
		t.Fatalf("the branch's commit is not in the new worktree: %v", err)
	}

	// A worktree with uncommitted work is kept.
	os.WriteFile(filepath.Join(again[0].Dir, "a.txt"), []byte("changed\n"), 0o600)
	r.RemoveCheckouts(ctx, "WEB-3")
	if _, err := os.Stat(again[0].Dir); err != nil {
		t.Fatalf("a worktree with uncommitted changes was removed: %v", err)
	}

	// A branch with a Task's key that the runner did not make is left alone.
	mustGit(t, repo, "branch", "WEB-4/mine", "main")
	_, err = r.Prepare(ctx, "WEB-4", "WEB-1", PlanCheckouts(r.cfg.Data, "WEB-4", "Theirs", "WEB-1", false, []Workspace{ws}))
	if err == nil || !strings.Contains(err.Error(), "WEB-4/mine") || !strings.Contains(err.Error(), "not made by the runner") {
		t.Fatalf("a person's branch: %v", err)
	}

	// A quick Feature's Task branches from main, and no Feature branch is made.
	got, err = r.Prepare(ctx, "WEB-6", "WEB-5", PlanCheckouts(r.cfg.Data, "WEB-6", "Typo", "WEB-5", true, []Workspace{ws}))
	if err != nil || got[0].Base != "main" || branchExists(ctx, repo, "feature/WEB-5") {
		t.Fatalf("quick: %+v, %v", got, err)
	}
}

func TestMergeBranch(t *testing.T) {
	repo := gitRepo(t)
	ctx := t.Context()
	mustGit(t, repo, "branch", "feature/WEB-1", "main")
	wt := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "WEB-3/cart", wt, "feature/WEB-1")
	commitFile(t, wt, "cart.txt", "cart\n", "cart")

	// Into a branch checked out nowhere: no checkout is touched, and the merge has two parents.
	head := mustGit(t, repo, "rev-parse", "HEAD")
	res, err := mergeBranch(ctx, repo, "WEB-3/cart", "feature/WEB-1", "Merge WEB-3/cart into feature/WEB-1")
	if err != nil || res.Conflict != "" || res.Already {
		t.Fatalf("got %+v, %v", res, err)
	}
	if tip := mustGit(t, repo, "rev-parse", "feature/WEB-1"); tip != res.Commit {
		t.Fatalf("feature/WEB-1 is at %s, the merge %s", tip, res.Commit)
	}
	if parents := strings.Fields(mustGit(t, repo, "rev-list", "--parents", "-n1", res.Commit)); len(parents) != 3 {
		t.Fatalf("the merge has parents %v; want two (--no-ff)", parents[1:])
	}
	if mustGit(t, repo, "rev-parse", "HEAD") != head || mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatal("the merge touched the repository's checkout")
	}
	// Again: nothing to do.
	if res, err := mergeBranch(ctx, repo, "WEB-3/cart", "feature/WEB-1", "again"); err != nil || !res.Already {
		t.Fatalf("again: %+v, %v", res, err)
	}

	// A conflict leaves both branches where they were.
	wt2 := filepath.Join(t.TempDir(), "wt2")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "WEB-4/edit", wt2, "main")
	commitFile(t, wt2, "a.txt", "one\nTWO\nthree\n", "edit two")
	wt3 := filepath.Join(t.TempDir(), "wt3")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "WEB-5/edit", wt3, "feature/WEB-1")
	commitFile(t, wt3, "a.txt", "one\n2\nthree\n", "edit two too")
	if _, err := mergeBranch(ctx, repo, "WEB-5/edit", "feature/WEB-1", "WEB-5"); err != nil {
		t.Fatal(err)
	}
	before := mustGit(t, repo, "rev-parse", "feature/WEB-1")
	res, err = mergeBranch(ctx, repo, "WEB-4/edit", "feature/WEB-1", "WEB-4")
	if err != nil || res.Conflict == "" || !strings.Contains(res.Conflict, "a.txt") || !strings.Contains(res.Conflict, "CONFLICT") {
		t.Fatalf("a conflict: %+v, %v", res, err)
	}
	if after := mustGit(t, repo, "rev-parse", "feature/WEB-1"); after != before {
		t.Fatal("a conflicting merge moved the target")
	}

	// Into the branch the repository has checked out: merged there, while it is clean.
	res, err = mergeBranch(ctx, repo, "feature/WEB-1", "main", "Ship WEB-1")
	if err != nil || res.Conflict != "" {
		t.Fatalf("into main: %+v, %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "cart.txt")); string(b) != "cart\n" {
		t.Fatalf("main's checkout has cart.txt %q", b)
	}
	if mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatal("main's checkout is not clean after the merge")
	}
	// A conflict there is aborted; uncommitted changes refuse the merge.
	res, err = mergeBranch(ctx, repo, "WEB-4/edit", "main", "WEB-4 into main")
	if err != nil || res.Conflict == "" || mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatalf("a conflict into main: %+v, %v, status %q", res, err, mustGit(t, repo, "status", "--porcelain"))
	}
	commitFile(t, wt, "more.txt", "more\n", "more")
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("work in progress\n"), 0o600)
	tip := mustGit(t, repo, "rev-parse", "main")
	_, err = mergeBranch(ctx, repo, "WEB-3/cart", "main", "x")
	var dirty ErrDirty
	if !errors.As(err, &dirty) || dirty.Branch != "main" || mustGit(t, repo, "rev-parse", "main") != tip {
		t.Fatalf("a dirty checkout: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "a.txt")); string(b) != "work in progress\n" {
		t.Fatalf("the person's uncommitted change is gone: %q", b)
	}
}

func TestDefaultBranch(t *testing.T) {
	repo := gitRepo(t)
	ctx := t.Context()
	if got := defaultBranch(ctx, repo); got != "main" {
		t.Fatalf("got %s", got)
	}
	mustGit(t, repo, "branch", "-m", "main", "trunk")
	if got := defaultBranch(ctx, repo); got != "trunk" {
		t.Fatalf("a repository on trunk: %s", got)
	}
}
