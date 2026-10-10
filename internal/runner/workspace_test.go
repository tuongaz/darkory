package runner

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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

func TestBranchNames(t *testing.T) {
	if got := TaskBranch("MAIN-7", "Support emoji"); got != "main-7-support-emoji" {
		t.Errorf("TaskBranch = %q", got)
	}
	if got := ParentBranch("MAIN-7"); got != "main-7" {
		t.Errorf("ParentBranch = %q", got)
	}
	// No Parent's branch is a Task's, and no Task's branch is another Task's.
	if strings.HasPrefix(ParentBranch("MAIN-7"), taskPrefix("MAIN-7")) || strings.HasPrefix(TaskBranch("MAIN-70", "x"), taskPrefix("MAIN-7")) {
		t.Error("branch names overlap")
	}
}

func TestPlanCheckouts(t *testing.T) {
	web := Workspace{ID: "w1", Name: "web", Kind: "git", Path: "/src/web", Mode: ModePlain, DefaultBranch: "trunk"}
	api := Workspace{ID: "w2", Name: "api server", Kind: "git", Path: "/src/api", Mode: ModePullRequest}
	ledger := Workspace{ID: "w3", Name: "books", Kind: "ledger", Path: "/books"}
	twin := Workspace{ID: "w4", Name: "web", Kind: "git", Path: "/src/web2"}

	got := PlanCheckouts("/d/workspaces/WEB-12", "WEB-12", "Cart page", "WEB-1", []Workspace{web, api, ledger, twin})
	want := []Checkout{
		{Workspace: web, Dir: "/d/workspaces/WEB-12/web", Branch: "web-12-cart-page", Base: "web-1"},
		{Workspace: api, Dir: "/d/workspaces/WEB-12/api-server", Branch: "web-12-cart-page", Base: "web-1"},
		{Workspace: twin, Dir: "/d/workspaces/WEB-12/web-2", Branch: "web-12-cart-page", Base: "web-1"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
	// A Task with no Parent branches from the default branch.
	got = PlanCheckouts("/d/workspaces/WEB-30", "WEB-30", "Fix the typo", "", []Workspace{web, api})
	if got[0].Base != "trunk" || got[1].Base != "main" || got[0].Branch != "web-30-fix-the-typo" {
		t.Fatalf("no Parent: %+v", got)
	}
	if got := PlanCheckouts("/d", "WEB-12", "x", "WEB-1", nil); got != nil {
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

	// A Parent's first Subtask, its Breakdown, makes the Parent's branch from the default branch.
	plan := PlanCheckouts(r.taskDir("WEB-2"), "WEB-2", "Break down: Checkout", "WEB-1", []Workspace{ws})
	got, err := r.Prepare(ctx, "WEB-2", "WEB-1", plan)
	if err != nil {
		t.Fatal(err)
	}
	if !branchExists(ctx, repo, "web-1") || got[0].Branch != "web-2-break-down-checkout" || got[0].Base != "web-1" {
		t.Fatalf("prepared %+v", got)
	}
	if head := mustGit(t, got[0].Dir, "symbolic-ref", "--short", "HEAD"); head != "web-2-break-down-checkout" {
		t.Fatalf("the worktree is on %s", head)
	}
	if b, err := os.ReadFile(filepath.Join(got[0].Dir, "a.txt")); err != nil || string(b) != "one\ntwo\nthree\n" {
		t.Fatalf("the worktree holds %q, %v", b, err)
	}
	made, _ := r.ledger.find(repo, func(Made) bool { return true })
	if len(made) != 2 || made[0].Branch != "web-1" || made[0].Parent != "WEB-1" || made[0].Base != "main" || made[1].Task != "WEB-2" ||
		made[1].Base != "web-1" {
		t.Fatalf("the ledger: %+v", made)
	}

	// Another Subtask works on its own branch from the Parent's.
	commitFile(t, got[0].Dir, "plan.txt", "plan\n", "plan") // on WEB-2's branch, not the Parent's
	plan = PlanCheckouts(r.taskDir("WEB-3"), "WEB-3", "Cart page", "WEB-1", []Workspace{ws})
	got, err = r.Prepare(ctx, "WEB-3", "WEB-1", plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(got[0].Dir, "plan.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("WEB-3's worktree has WEB-2's commit: %v", err)
	}
	commitFile(t, got[0].Dir, "cart.txt", "cart\n", "cart")

	// The review's session finds the worktree its builder left.
	again, err := r.Prepare(ctx, "WEB-3", "WEB-1", PlanCheckouts(r.taskDir("WEB-3"), "WEB-3", "Cart page, renamed", "WEB-1", []Workspace{ws}))
	if err != nil || again[0].Branch != "web-3-cart-page" || again[0].Dir != got[0].Dir {
		t.Fatalf("again: %+v, %v", again, err)
	}
	// Removed, the worktree comes back on the same branch, whatever the title says now.
	r.RemoveCheckouts(ctx, "WEB-3")
	if _, err := os.Stat(TaskDir(r.cfg.Data, "WEB-3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the Task's directory is still there: %v", err)
	}
	if !branchExists(ctx, repo, "web-3-cart-page") {
		t.Fatal("removing the worktree removed the branch")
	}
	again, err = r.Prepare(ctx, "WEB-3", "WEB-1", PlanCheckouts(r.taskDir("WEB-3"), "WEB-3", "Cart page, renamed", "WEB-1", []Workspace{ws}))
	if err != nil || again[0].Branch != "web-3-cart-page" {
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
	mustGit(t, repo, "branch", "web-4-mine", "main")
	_, err = r.Prepare(ctx, "WEB-4", "WEB-1", PlanCheckouts(r.taskDir("WEB-4"), "WEB-4", "Theirs", "WEB-1", []Workspace{ws}))
	if err == nil || !strings.Contains(err.Error(), "web-4-mine") || !strings.Contains(err.Error(), "not made by the runner") {
		t.Fatalf("a person's branch: %v", err)
	}

	// A Task with no Parent branches from main, and no Parent's branch is made.
	got, err = r.Prepare(ctx, "WEB-6", "", PlanCheckouts(r.taskDir("WEB-6"), "WEB-6", "Typo", "", []Workspace{ws}))
	if err != nil || got[0].Base != "main" || got[0].Branch != "web-6-typo" || branchExists(ctx, repo, "web-6") {
		t.Fatalf("no Parent: %+v, %v", got, err)
	}

	// A Task worked, then split by its holder: its Subtasks' Parent branch starts from its own
	// branch, so what it did before the split is kept.
	commitFile(t, got[0].Dir, "typo.txt", "fixed half\n", "half the typo")
	r.RemoveCheckouts(ctx, "WEB-6")
	sub, err := r.Prepare(ctx, "WEB-7", "WEB-6", PlanCheckouts(r.taskDir("WEB-7"), "WEB-7", "The other half", "WEB-6", []Workspace{ws}))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(sub[0].Dir, "typo.txt")); err != nil || string(b) != "fixed half\n" {
		t.Fatalf("the split Task's work is not on its Parent's branch: %q, %v", b, err)
	}
}

// A Task branch an earlier session left is brought up to its base when the Task is taken again:
// moved to it when it has no commits of its own, the base merged into it when it has, and left
// as it was when that merge conflicts.
func TestPrepareBringsATaskBranchUpToItsBase(t *testing.T) {
	repo := gitRepo(t)
	r := newTestRunner(t)
	ws := Workspace{Name: "web", Kind: "git", Path: repo, Mode: ModePlain}
	ctx := t.Context()
	prepare := func(task, title string) Checkout {
		t.Helper()
		got, err := r.Prepare(ctx, task, "WEB-1", PlanCheckouts(r.taskDir(task), task, title, "WEB-1", []Workspace{ws}))
		if err != nil {
			t.Fatal(err)
		}
		return got[0]
	}
	land := func(task, title, file, content string) { // a sibling's work merged into the Parent's branch
		t.Helper()
		c := prepare(task, title)
		commitFile(t, c.Dir, file, content, task)
		if res, err := mergeBranch(ctx, repo, c.Branch, "web-1", "merge "+task); err != nil || res.Conflict != "" {
			t.Fatalf("merging %s: %+v, %v", task, res, err)
		}
		r.RemoveCheckouts(ctx, task)
	}
	has := func(c Checkout, file, want string) {
		t.Helper()
		if b, err := os.ReadFile(filepath.Join(c.Dir, file)); err != nil || string(b) != want {
			t.Fatalf("%s's %s: %q, %v", c.Branch, file, b, err)
		}
	}

	// Taken, then released with nothing done (a question), while the design lands on the Parent's
	// branch: taken again, its branch is the Parent's.
	prepare("WEB-2", "Keys")
	r.RemoveCheckouts(ctx, "WEB-2")
	land("WEB-3", "Design", "design.txt", "design\n")
	c := prepare("WEB-2", "Keys")
	has(c, "design.txt", "design\n")
	if mustGit(t, repo, "rev-parse", c.Branch) != mustGit(t, repo, "rev-parse", "web-1") {
		t.Fatal("a branch with no commits of its own was not moved to its base")
	}

	// With work of its own, in a worktree kept between sessions: the base is merged in.
	commitFile(t, c.Dir, "keys.txt", "keys\n", "keys")
	land("WEB-4", "Health", "health.txt", "health\n")
	c = prepare("WEB-2", "Keys")
	has(c, "health.txt", "health\n")
	has(c, "keys.txt", "keys\n")

	// A merge that conflicts leaves the branch as it was, with nothing half-merged.
	commitFile(t, c.Dir, "a.txt", "mine\n", "mine")
	tip := mustGit(t, repo, "rev-parse", c.Branch)
	land("WEB-5", "Theirs", "a.txt", "theirs\n")
	c = prepare("WEB-2", "Keys")
	if got := mustGit(t, repo, "rev-parse", c.Branch); got != tip {
		t.Fatalf("a conflicting merge moved the branch to %s", got)
	}
	if st := mustGit(t, c.Dir, "status", "--porcelain"); st != "" {
		t.Fatalf("the worktree after a conflicting merge: %q", st)
	}
	has(c, "a.txt", "mine\n")
}

// A session of a Subtask starts once its done siblings are in the Parent's branch: it waits for
// a merge still to come, and not for one the merger tried and could not make.
func TestAwaitMergesWaitsForDoneSiblings(t *testing.T) {
	repo := gitRepo(t)
	r := newTestRunner(t)
	ws := Workspace{Name: "web", Kind: "git", Path: repo, Mode: ModePlain}
	ctx := t.Context()
	sibling := func(task, title string) string {
		t.Helper()
		got, err := r.Prepare(ctx, task, "WEB-1", PlanCheckouts(r.taskDir(task), task, title, "WEB-1", []Workspace{ws}))
		if err != nil {
			t.Fatal(err)
		}
		commitFile(t, got[0].Dir, task+".txt", task+"\n", task)
		return got[0].Branch
	}
	keys := sibling("WEB-2", "Keys")
	parent := &ParentInfo{Key: "WEB-1", Done: []string{"WEB-2"}}

	done := make(chan struct{})
	go func() { r.awaitMerges(ctx, "WEB-3", parent, []Workspace{ws}); close(done) }()
	select {
	case <-done:
		t.Fatal("started before the done sibling merged")
	case <-time.After(600 * time.Millisecond):
	}
	if res, err := mergeBranch(ctx, repo, keys, "web-1", "merge WEB-2"); err != nil || res.Conflict != "" {
		t.Fatalf("merge: %+v, %v", res, err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting after the merge")
	}

	// A sibling whose merge the merger tried, such as one that conflicted, is not waited for.
	sibling("WEB-4", "Limits")
	r.tried["WEB-4"] = true
	start := time.Now()
	r.awaitMerges(ctx, "WEB-5", &ParentInfo{Key: "WEB-1", Done: []string{"WEB-2", "WEB-4"}}, []Workspace{ws})
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("waited %v for a merge already tried", waited)
	}
}

// A ledger written before model v2 names a Feature's branch feature/<KEY> under "Feature": it
// reads, it is kept as written when the ledger grows, and no branch of model v2 matches it.
func TestLedgerReadsEntriesFromBeforeModelV2(t *testing.T) {
	repo := gitRepo(t)
	r := newTestRunner(t)
	old := `{"Branches": [
  {"Repo": "` + repo + `", "Branch": "feature/MAIN-1", "Base": "main", "Feature": "MAIN-1", "At": "2026-10-07T03:00:00Z"},
  {"Repo": "` + repo + `", "Branch": "MAIN-2/cart-page", "Base": "feature/MAIN-1", "Task": "MAIN-2", "At": "2026-10-07T03:01:00Z"}
]}`
	if err := os.MkdirAll(filepath.Dir(r.ledger.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.ledger.path, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "branch", "feature/MAIN-1", "main")
	got, err := r.Prepare(t.Context(), "MAIN-3", "MAIN-1", PlanCheckouts(r.taskDir("MAIN-3"), "MAIN-3", "Totals", "MAIN-1", []Workspace{{Name: "web", Kind: "git", Path: repo}}))
	if err != nil || got[0].Base != "main-1" || got[0].Branch != "main-3-totals" {
		t.Fatalf("prepared %+v, %v", got, err)
	}
	all, err := r.ledger.find("", func(Made) bool { return true })
	if err != nil || len(all) != 4 || all[0].Legacy != "MAIN-1" || all[0].Parent != "" || all[2].Parent != "MAIN-1" || all[2].Branch != "main-1" {
		t.Fatalf("the ledger: %+v, %v", all, err)
	}
	b, _ := os.ReadFile(r.ledger.path)
	if !strings.Contains(string(b), `"Feature": "MAIN-1"`) {
		t.Fatalf("the old entry was not kept as written:\n%s", b)
	}
}

// A repository whose smudge filter needs a key in its git directory, as git-crypt does: a plain
// `git worktree add` fails at the checkout, since a linked worktree's git directory starts empty.
func TestPrepareGivesAWorktreeTheRepositorysFilterKeys(t *testing.T) {
	repo := gitRepo(t)
	ctx := t.Context()
	if err := os.MkdirAll(filepath.Join(repo, ".git", "git-crypt", "keys"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".git", "git-crypt", "keys", "default"), []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "config", "filter.needkey.smudge", `sh -c 'test -f "$(git rev-parse --git-dir)/git-crypt/keys/default" && cat'`)
	mustGit(t, repo, "config", "filter.needkey.clean", "cat")
	mustGit(t, repo, "config", "filter.needkey.required", "true")
	commitFile(t, repo, ".gitattributes", "secret.txt filter=needkey\n", "attributes")
	commitFile(t, repo, "secret.txt", "hush\n", "secret")
	if _, err := runGit(ctx, repo, "worktree", "add", "-b", "plain", filepath.Join(t.TempDir(), "plain"), "main"); err == nil {
		t.Fatal("a plain worktree add did not fail at the smudge filter; the test no longer shows the bug")
	}

	r := newTestRunner(t)
	ws := Workspace{Name: "web", Kind: "git", Path: repo, Mode: ModePlain}
	got, err := r.Prepare(ctx, "WEB-2", "WEB-1", PlanCheckouts(r.taskDir("WEB-2"), "WEB-2", "Break down: Checkout", "WEB-1", []Workspace{ws}))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(got[0].Dir, "secret.txt")); err != nil || string(b) != "hush\n" {
		t.Fatalf("the worktree holds %q, %v", b, err)
	}
	if out := mustGit(t, got[0].Dir, "status", "--porcelain"); out != "" {
		t.Fatalf("the new worktree is dirty:\n%s", out)
	}
	gitDir := mustGit(t, got[0].Dir, "rev-parse", "--path-format=absolute", "--git-dir")
	target, err := filepath.EvalSymlinks(filepath.Join(gitDir, "git-crypt"))
	want, _ := filepath.EvalSymlinks(filepath.Join(repo, ".git", "git-crypt"))
	if err != nil || target != want {
		t.Fatalf("git-crypt in the worktree's git directory resolves to %q, want %q, %v", target, want, err)
	}

	// The worktree of an existing branch of the Task takes the same path.
	r.RemoveCheckouts(ctx, "WEB-2")
	again, err := r.Prepare(ctx, "WEB-2", "WEB-1", PlanCheckouts(r.taskDir("WEB-2"), "WEB-2", "Break down: Checkout", "WEB-1", []Workspace{ws}))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(again[0].Dir, "secret.txt")); err != nil || string(b) != "hush\n" {
		t.Fatalf("the second worktree holds %q, %v", b, err)
	}
}

func TestMergeBranch(t *testing.T) {
	repo := gitRepo(t)
	ctx := t.Context()
	mustGit(t, repo, "branch", "web-1", "main")
	wt := filepath.Join(t.TempDir(), "wt")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "web-3-cart", wt, "web-1")
	commitFile(t, wt, "cart.txt", "cart\n", "cart")

	// Into a branch checked out nowhere: no checkout is touched, and the merge has two parents.
	head := mustGit(t, repo, "rev-parse", "HEAD")
	res, err := mergeBranch(ctx, repo, "web-3-cart", "web-1", "Merge web-3-cart into web-1")
	if err != nil || res.Conflict != "" || res.Already {
		t.Fatalf("got %+v, %v", res, err)
	}
	if tip := mustGit(t, repo, "rev-parse", "web-1"); tip != res.Commit {
		t.Fatalf("web-1 is at %s, the merge %s", tip, res.Commit)
	}
	if parents := strings.Fields(mustGit(t, repo, "rev-list", "--parents", "-n1", res.Commit)); len(parents) != 3 {
		t.Fatalf("the merge has parents %v; want two (--no-ff)", parents[1:])
	}
	if mustGit(t, repo, "rev-parse", "HEAD") != head || mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatal("the merge touched the repository's checkout")
	}
	// Again: nothing to do.
	if res, err := mergeBranch(ctx, repo, "web-3-cart", "web-1", "again"); err != nil || !res.Already {
		t.Fatalf("again: %+v, %v", res, err)
	}

	// A conflict leaves both branches where they were.
	wt2 := filepath.Join(t.TempDir(), "wt2")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "web-4-edit", wt2, "main")
	commitFile(t, wt2, "a.txt", "one\nTWO\nthree\n", "edit two")
	wt3 := filepath.Join(t.TempDir(), "wt3")
	mustGit(t, repo, "worktree", "add", "-q", "-b", "web-5-edit", wt3, "web-1")
	commitFile(t, wt3, "a.txt", "one\n2\nthree\n", "edit two too")
	if _, err := mergeBranch(ctx, repo, "web-5-edit", "web-1", "WEB-5"); err != nil {
		t.Fatal(err)
	}
	before := mustGit(t, repo, "rev-parse", "web-1")
	res, err = mergeBranch(ctx, repo, "web-4-edit", "web-1", "WEB-4")
	if err != nil || res.Conflict == "" || !strings.Contains(res.Conflict, "a.txt") || !strings.Contains(res.Conflict, "CONFLICT") {
		t.Fatalf("a conflict: %+v, %v", res, err)
	}
	if after := mustGit(t, repo, "rev-parse", "web-1"); after != before {
		t.Fatal("a conflicting merge moved the target")
	}

	// Into the branch the repository has checked out: merged there, while it is clean.
	res, err = mergeBranch(ctx, repo, "web-1", "main", "Complete WEB-1")
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
	res, err = mergeBranch(ctx, repo, "web-4-edit", "main", "WEB-4 into main")
	if err != nil || res.Conflict == "" || mustGit(t, repo, "status", "--porcelain") != "" {
		t.Fatalf("a conflict into main: %+v, %v, status %q", res, err, mustGit(t, repo, "status", "--porcelain"))
	}
	commitFile(t, wt, "more.txt", "more\n", "more")
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("work in progress\n"), 0o600)
	tip := mustGit(t, repo, "rev-parse", "main")
	_, err = mergeBranch(ctx, repo, "web-3-cart", "main", "x")
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

// Task directories go under the data directory unless it is inside a git checkout or under a
// CLAUDE.md, where a session would read another project's rules: then under ~/.darkory, one
// directory per data directory.
func TestDefaultWorkspaces(t *testing.T) {
	isolateGit(t)
	home := t.TempDir()
	t.Setenv("HOME", home)

	plain := t.TempDir()
	if got := DefaultWorkspaces(plain); got != filepath.Join(plain, "workspaces") {
		t.Fatalf("a data directory outside any checkout: %s", got)
	}

	repo := t.TempDir()
	mustGit(t, repo, "init", "-q", "-b", "main")
	inRepo := filepath.Join(repo, ".dev")
	if err := os.MkdirAll(inRepo, 0o700); err != nil {
		t.Fatal(err)
	}
	got := DefaultWorkspaces(inRepo)
	if !strings.HasPrefix(got, filepath.Join(home, ".darkory", "workspaces", "dev-")) {
		t.Fatalf("a data directory inside a checkout: %s", got)
	}
	if other := DefaultWorkspaces(filepath.Join(repo, ".dev2")); other == got {
		t.Fatal("two data directories share a Workspaces root")
	}

	project := t.TempDir()
	writeTestFile(t, filepath.Join(project, "CLAUDE.md"), "Another project's rules.\n")
	underRules := filepath.Join(project, "deep", "data")
	if got := DefaultWorkspaces(underRules); !strings.HasPrefix(got, filepath.Join(home, ".darkory", "workspaces", "data-")) {
		t.Fatalf("a data directory under a CLAUDE.md: %s", got)
	}
}

// With a Workspaces root of its own, a Task's checkouts go under it; a Task an earlier session
// left worktrees for under <data>/workspaces keeps working there.
func TestWorkspacesRoot(t *testing.T) {
	repo := gitRepo(t)
	root := t.TempDir()
	r, err := New(Config{Data: t.TempDir(), Workspaces: root, Host: childHost{}, Darkory: "darkory"})
	if err != nil {
		t.Fatal(err)
	}
	ws := Workspace{Name: "web", Kind: "git", Path: repo, Mode: ModePlain}
	ctx := t.Context()

	// A Task begun before the root moved: its worktree is under <data>/workspaces.
	legacy := TaskDir(r.cfg.Data, "WEB-2")
	old, err := r.Prepare(ctx, "WEB-2", "", PlanCheckouts(legacy, "WEB-2", "Cart", "", []Workspace{ws}))
	if err != nil {
		t.Fatal(err)
	}
	if got := r.taskDir("WEB-2"); got != legacy {
		t.Fatalf("a Task with worktrees under the data directory: %s, want %s", got, legacy)
	}
	again, err := r.Prepare(ctx, "WEB-2", "", PlanCheckouts(r.taskDir("WEB-2"), "WEB-2", "Cart", "", []Workspace{ws}))
	if err != nil || again[0].Dir != old[0].Dir {
		t.Fatalf("taken again: %+v, %v", again, err)
	}

	// A new Task goes under the root.
	if got := r.taskDir("WEB-3"); got != filepath.Join(root, "WEB-3") {
		t.Fatalf("a new Task's directory: %s", got)
	}
	got, err := r.Prepare(ctx, "WEB-3", "", PlanCheckouts(r.taskDir("WEB-3"), "WEB-3", "Typo", "", []Workspace{ws}))
	if err != nil || got[0].Dir != filepath.Join(root, "WEB-3", "web") {
		t.Fatalf("prepared under the root: %+v, %v", got, err)
	}
	if b, err := os.ReadFile(filepath.Join(got[0].Dir, "a.txt")); err != nil || string(b) != "one\ntwo\nthree\n" {
		t.Fatalf("the worktree under the root holds %q, %v", b, err)
	}
	r.RemoveCheckouts(ctx, "WEB-3")
	if _, err := os.Stat(filepath.Join(root, "WEB-3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the Task's directory under the root was not removed: %v", err)
	}
}
