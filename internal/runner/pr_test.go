package runner

import (
	"context"
	"slices"
	"sync"
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
