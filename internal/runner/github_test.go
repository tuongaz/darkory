//go:build !windows

package runner

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGh puts a gh on the PATH that logs its arguments to a file and answers what script says,
// a shell fragment that sees its arguments in "$*".
func fakeGh(t *testing.T, script string) (argsLog string) {
	t.Helper()
	dir := t.TempDir()
	argsLog = filepath.Join(dir, "args")
	body := "#!/bin/sh\necho \"$*\" >> '" + argsLog + "'\n" + script + "\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return argsLog
}

func ghArgs(t *testing.T, log string) []string {
	t.Helper()
	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// The Runner reads pull requests with one gh call each: the repository's latest hundred in every
// state, those of one branch, and one by number; it merges one with a merge commit, and gh's own
// words come back when GitHub refuses.
func TestGhCLI(t *testing.T) {
	const list = `[{"number":7,"title":"DARK-3: Fix","headRefName":"dark-3-fix","baseRefName":"main","url":"https://github.com/acme/web/pull/7","state":"MERGED"},
{"number":8,"title":"Bump","headRefName":"chore/bump","baseRefName":"main","url":"https://github.com/acme/web/pull/8","state":"OPEN",
"headRefOid":"abc","isCrossRepository":true,"headRepositoryOwner":{"login":"mallory"}}]`
	log := fakeGh(t, `case "$*" in
pr\ list*) echo '`+list+`' ;;
pr\ view*) echo '{"number":7,"headRefName":"dark-3-fix","baseRefName":"main","url":"https://github.com/acme/web/pull/7","state":"OPEN"}' ;;
pr\ merge*) echo 'X Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created.' >&2; exit 1 ;;
esac`)
	g, ctx, repo := ghCLI{}, t.Context(), t.TempDir()

	prs, err := g.PullRequests(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(prs) != 2 || prs[0] != (PullRequest{Number: 7, Title: "DARK-3: Fix", HeadRefName: "dark-3-fix", BaseRefName: "main",
		URL: "https://github.com/acme/web/pull/7", State: "MERGED"}) || prs[1].State != "OPEN" || !prs[1].IsCrossRepository ||
		prs[1].HeadRepositoryOwner.Login != "mallory" || prs[1].HeadRefOid != "abc" {
		t.Fatalf("PullRequests: %+v", prs)
	}
	if _, err := g.PullRequestsForBranch(ctx, repo, "dark-3-fix"); err != nil {
		t.Fatal(err)
	}
	pr, err := g.PullRequest(ctx, repo, 7)
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 7 || pr.State != "OPEN" || pr.HeadRefName != "dark-3-fix" || pr.BaseRefName != "main" {
		t.Fatalf("PullRequest: %+v", pr)
	}
	// GitHub's refusal is its own sentence, with nothing of gh's around it; the log keeps it all.
	err = g.MergePR(ctx, repo, 7, "abc123")
	if err == nil || err.Error() != "Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created." {
		t.Fatalf("MergePR's refusal: %v", err)
	}
	var ge *ghError
	if !errors.As(err, &ge) || ge.Error() != "gh pr merge 7: exit status 1: X Pull request acme/web#7 is not mergeable: the merge commit cannot be cleanly created." {
		t.Fatalf("the refusal's gh error: %v", ge)
	}

	want := []string{
		"pr list --state all --limit 200 --json " + prFields,
		"pr list --head dark-3-fix --state all --json " + prFields,
		"pr view 7 --json " + prFields,
		"pr merge 7 --merge --match-head-commit abc123",
	}
	if got := ghArgs(t, log); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("gh was run as\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
