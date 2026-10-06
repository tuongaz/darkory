package gitinfo

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// A directory in a repository finds its root and default branch: origin's HEAD when there is
// one, else the branch checked out; a directory in none finds nothing.
func TestFind(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	ctx := t.Context()
	if _, ok := Find(ctx, t.TempDir()); ok {
		t.Fatal("found a repository in an empty directory")
	}

	origin := filepath.Join(t.TempDir(), "My Repo!")
	run(t, filepath.Dir(origin), "init", "-q", "-b", "trunk", origin)
	run(t, origin, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "first")
	sub := filepath.Join(origin, "pkg")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	repo, ok := Find(ctx, sub)
	wantRoot, _ := filepath.EvalSymlinks(origin)
	gotRoot, _ := filepath.EvalSymlinks(repo.Root)
	if !ok || gotRoot != wantRoot || repo.DefaultBranch != "trunk" {
		t.Fatalf("found %+v %v", repo, ok)
	}
	if got := Name(repo.Root); got != "My-Repo-" {
		t.Fatalf("named %q", got)
	}

	clone := filepath.Join(t.TempDir(), "clone")
	run(t, filepath.Dir(clone), "clone", "-q", origin, clone)
	run(t, clone, "checkout", "-q", "-b", "feature/x")
	if repo, ok := Find(ctx, clone); !ok || repo.DefaultBranch != "trunk" {
		t.Fatalf("the clone found %+v %v", repo, ok)
	}
	for in, want := range map[string]string{"/src/darkory": "darkory", "/src/.hidden": "hidden", "/src/@@@": "repo", "/x/a b.c": "a-b.c"} {
		if got := Name(in); got != want {
			t.Errorf("Name(%q) = %q, want %q", in, got, want)
		}
	}
}
