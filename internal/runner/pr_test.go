package runner

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// recordingGitHub stands in for gh: it lists the merged pull requests a test sets and records the
// ones the runner opens.
type recordingGitHub struct {
	mu      sync.Mutex
	merged  []PullRequest
	created []string
}

func (g *recordingGitHub) CreatePR(_ context.Context, repo, base, head, title, _ string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.created = append(g.created, base+" <- "+head+": "+title)
	return "https://github.com/acme/web/pull/9", nil
}

func (g *recordingGitHub) MergedPRs(context.Context, string) ([]PullRequest, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.merged), nil
}

func (g *recordingGitHub) merge(pr PullRequest) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.merged = append(g.merged, pr)
}

func (g *recordingGitHub) opened() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.created)
}

// In a pull_request Workspace the runner merges nothing itself (D14): the builder's Handover leaves
// the review waiting; the pull request that carries the Task's key merging on GitHub completes it,
// claimed as an agent that may review, with a Note; and Ship opens the Feature branch's pull
// request instead of merging.
func TestRunnerPullRequestMode(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.ok("ada", "workspace", "set", "web", "--mode", "pull_request")
	f.agent("builder", "handover", "build")
	f.agent("reviewer", "complete", "review")
	f.ok("ada", "agent", "set", "reviewer", "--paused") // no session reviews it: GitHub does
	gh := &recordingGitHub{}
	f.gh = gh
	f.run("builder", "reviewer")
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "drop", "WEB-2", "--reason", "broken down by hand")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	eventually(t, 20*time.Second, "WEB-3 handed over to review", func() bool {
		d := f.task("WEB-3")
		return d.Status.Name == "In review" && d.Task.Claim == nil
	})
	// A pull request with no Task's key, and the Feature's own, are not reviews.
	gh.merge(PullRequest{Number: 5, Title: "Bump the linter", HeadRefName: "chore/lint", URL: "https://github.com/acme/web/pull/5"})
	gh.merge(PullRequest{Number: 7, Title: "WEB-3: Cart page", HeadRefName: "WEB-3/cart-page", URL: "https://github.com/acme/web/pull/7"})
	eventually(t, 20*time.Second, "WEB-3's review completed by its pull request", func() bool { return f.task("WEB-3").Task.State == client.TaskStateDone })
	d := f.task("WEB-3")
	last := d.Claims[len(d.Claims)-1]
	if last.HolderID != f.ids["reviewer"] || !strings.Contains(notesOf(d), "Pull request #7 (https://github.com/acme/web/pull/7) was merged on GitHub") {
		t.Fatalf("WEB-3's last Claim %+v, Notes:\n%s", last, notesOf(d))
	}
	eventually(t, 10*time.Second, "WEB-3's merge Note", func() bool {
		return strings.Contains(notesOf(f.task("WEB-3")), "web: WEB-3/cart-page lands through its pull request.")
	})
	if _, err := runGit(t.Context(), f.repo, "merge-base", "--is-ancestor", "WEB-3/cart-page", "feature/WEB-1"); err == nil {
		t.Fatal("the runner merged a pull_request Workspace's branch itself")
	}

	f.ok("ada", "feature", "ship", "WEB-1")
	eventually(t, 10*time.Second, "the Feature's pull request opened", func() bool { return len(gh.opened()) == 1 })
	if got := gh.opened()[0]; got != "main <- feature/WEB-1: WEB-1: Checkout" {
		t.Fatalf("opened %q", got)
	}
}
