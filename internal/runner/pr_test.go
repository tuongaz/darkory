package runner

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// recordingGitHub stands in for gh: it lists the pull requests a test sets, newest first, records
// the ones the runner opens and merges, and refuses a merge with refuse when it is set.
type recordingGitHub struct {
	mu      sync.Mutex
	prs     []PullRequest
	created []string
	merges  []int64
	refuse  string
}

func (g *recordingGitHub) CreatePR(_ context.Context, repo, base, head, title, _ string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.created = append(g.created, base+" <- "+head+": "+title)
	return "https://github.com/acme/web/pull/9", nil
}

func (g *recordingGitHub) PullRequests(context.Context, string) ([]PullRequest, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := slices.Clone(g.prs)
	slices.Reverse(out)
	return out, nil
}

func (g *recordingGitHub) PullRequestsForBranch(ctx context.Context, repo, branch string) ([]PullRequest, error) {
	all, _ := g.PullRequests(ctx, repo)
	return slices.DeleteFunc(all, func(pr PullRequest) bool { return pr.HeadRefName != branch }), nil
}

func (g *recordingGitHub) PullRequest(_ context.Context, _ string, n int64) (PullRequest, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, pr := range g.prs {
		if pr.Number == n {
			return pr, nil
		}
	}
	return PullRequest{}, fmt.Errorf("gh pr view: exit status 1: GraphQL: Could not resolve to a PullRequest with the number of %d.", n)
}

func (g *recordingGitHub) MergePR(_ context.Context, _ string, n int64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.refuse != "" {
		return errors.New(g.refuse)
	}
	g.merges = append(g.merges, n)
	for i := range g.prs {
		if g.prs[i].Number == n {
			g.prs[i].State = PRMerged
		}
	}
	return nil
}

// open adds pr to GitHub, open; set replaces the one of its number, or adds it.
func (g *recordingGitHub) open(pr PullRequest) {
	pr.State = PROpen
	g.set(pr)
}

// merge adds pr to GitHub merged, or merges the one of its number.
func (g *recordingGitHub) merge(pr PullRequest) {
	pr.State = PRMerged
	g.set(pr)
}

func (g *recordingGitHub) set(pr PullRequest) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for i := range g.prs {
		if g.prs[i].Number == pr.Number {
			g.prs[i] = pr
			return
		}
	}
	g.prs = append(g.prs, pr)
}

func (g *recordingGitHub) opened() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.created)
}

// In a pull_request Workspace the runner merges nothing itself (D14): the builder's advance leaves
// the Subtask waiting at Review; the pull request whose head is its branch merging on GitHub
// advances it into Done, claimed as an agent that may review, with a Note, and the merge's Note
// names that pull request; the Parent's own pull request is no review; and the Parent's Complete
// opens its branch's pull request into main instead of merging.
func TestRunnerPullRequestMode(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.ok("ada", "workspace", "set", "web", "--mode", "pull_request")
	f.agent("builder", "advance", "engineer")
	f.agent("reviewer", "advance", "review")
	f.ok("ada", "agent", "set", "reviewer", "--paused") // no session reviews it: GitHub does
	gh := &recordingGitHub{}
	f.gh = gh
	f.run("builder", "reviewer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--parent", "WEB-1", "--title", "Cart page")
	eventually(t, 20*time.Second, "WEB-2 advanced to Review", func() bool {
		d := f.task("WEB-2")
		return d.Step != nil && d.Step.Name == "Review" && d.Task.Claim == nil
	})
	if !branchExists(t.Context(), f.repo, "web-1") {
		t.Fatal("no Parent's branch for the pull request's base")
	}
	// A pull request with no Task's key, and the Parent's own, are not reviews.
	gh.merge(PullRequest{Number: 5, Title: "Bump the linter", HeadRefName: "chore/lint", URL: "https://github.com/acme/web/pull/5"})
	gh.merge(PullRequest{Number: 6, Title: "WEB-1: Checkout", HeadRefName: "web-1", URL: "https://github.com/acme/web/pull/6"})
	gh.merge(PullRequest{Number: 7, Title: "WEB-2: Cart page", HeadRefName: "web-2-cart-page", URL: "https://github.com/acme/web/pull/7"})
	eventually(t, 20*time.Second, "WEB-2's review completed by its pull request", func() bool { return f.task("WEB-2").Task.State == client.TaskStateDone })
	d := f.task("WEB-2")
	last := d.Claims[len(d.Claims)-1]
	if last.HolderID != f.ids["reviewer"] || !strings.Contains(notesOf(d), "Pull request #7 (https://github.com/acme/web/pull/7) was merged on GitHub") {
		t.Fatalf("WEB-2's last Claim %+v, Notes:\n%s", last, notesOf(d))
	}
	eventually(t, 10*time.Second, "WEB-2's merge Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-2")), "web: web-2-cart-page was merged into web-1 through pull request #7 (https://github.com/acme/web/pull/7).")
	})
	if _, err := runGit(t.Context(), f.repo, "merge-base", "--is-ancestor", "web-2-cart-page", "web-1"); err == nil {
		t.Fatal("the runner merged a pull_request Workspace's branch itself")
	}

	f.ok("ada", "complete", "WEB-1")
	eventually(t, 10*time.Second, "the Parent's pull request opened", func() bool { return len(gh.opened()) == 1 })
	if got := gh.opened()[0]; got != "main <- web-1: WEB-1: Checkout" {
		t.Fatalf("opened %q", got)
	}
	eventually(t, 10*time.Second, "the Parent's Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-1")), "web: opened https://github.com/acme/web/pull/9, the pull request of web-1 into main.")
	})
}

// A done Task whose branch has nothing ahead of its base lands nothing: the merge Note says so
// instead of promising a pull request; a branch with commits still lands through its pull request.
func TestPullRequestLineSaysWhenNothingLanded(t *testing.T) {
	repo := gitRepo(t)
	mustGit(t, repo, "branch", "dark-3-triage")
	mustGit(t, repo, "branch", "dark-3-build")
	mustGit(t, repo, "checkout", "-q", "dark-3-build")
	commitFile(t, repo, "b.txt", "x\n", "work")
	mustGit(t, repo, "checkout", "-q", "main")
	r := &Runner{gh: &recordingGitHub{}}
	ws := Workspace{Name: "darkory", Path: repo, Mode: ModePullRequest}

	got := r.pullRequestLine(t.Context(), ws, "dark-3-triage", "main", "")
	if !strings.Contains(got, "has no commits ahead of main, so nothing landed") || strings.Contains(got, "lands in main") {
		t.Errorf("a branch with nothing ahead: %q", got)
	}
	got = r.pullRequestLine(t.Context(), ws, "dark-3-build", "main", "")
	if !strings.Contains(got, "lands in main through its pull request") {
		t.Errorf("a branch with commits: %q", got)
	}
}
