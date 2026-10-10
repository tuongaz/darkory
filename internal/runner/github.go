package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// A Workspace in pull_request mode lands through GitHub: a Parent's Complete opens its branch's
// pull request, a Task's pull request is written on the Task, open and then merged, and a merged
// pull request carrying a Task's key completes its review (D14). The runner talks to GitHub
// through the gh CLI, behind GitHub so tests stand in for it.

// PullRequest is a pull request as gh lists it.
type PullRequest struct {
	Number      int64  `json:"number"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
	BaseRefName string `json:"baseRefName"`
	URL         string `json:"url"`
	// State is as gh gives it: OPEN, MERGED or CLOSED.
	State string `json:"state"`
}

// Pull request states as gh gives them.
const (
	PROpen   = "OPEN"
	PRMerged = "MERGED"
	PRClosed = "CLOSED"
)

// GitHub opens, reads and merges pull requests of the repository at repo.
type GitHub interface {
	// CreatePR opens a pull request of head into base and returns its URL.
	CreatePR(ctx context.Context, repo, base, head, title, body string) (string, error)
	// PullRequests lists the repository's latest pull requests, in every state, newest first.
	PullRequests(ctx context.Context, repo string) ([]PullRequest, error)
	// PullRequestsForBranch lists the pull requests whose head is branch, in every state, newest first.
	PullRequestsForBranch(ctx context.Context, repo, branch string) ([]PullRequest, error)
	// PullRequest reads pull request n.
	PullRequest(ctx context.Context, repo string, n int64) (PullRequest, error)
	// MergePR merges pull request n with a merge commit; GitHub's refusal is the error, in its words.
	MergePR(ctx context.Context, repo string, n int64) error
}

// prFields are the fields the Runner reads of a pull request.
const prFields = "number,title,headRefName,baseRefName,url,state"

// ghCLI is GitHub through the gh CLI, signed in as the person running the Install.
type ghCLI struct{}

func (ghCLI) gh(ctx context.Context, repo string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = repo
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("gh %s: %w: %s", strings.Join(args[:min(len(args), 3)], " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func (g ghCLI) CreatePR(ctx context.Context, repo, base, head, title, body string) (string, error) {
	out, err := g.gh(ctx, repo, "pr", "create", "--base", base, "--head", head, "--title", title, "--body", body)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (g ghCLI) list(ctx context.Context, repo string, args ...string) ([]PullRequest, error) {
	out, err := g.gh(ctx, repo, append(append([]string{"pr", "list"}, args...), "--json", prFields)...)
	if err != nil {
		return nil, err
	}
	var prs []PullRequest
	if err := json.Unmarshal(out, &prs); err != nil {
		return nil, fmt.Errorf("gh pr list: %w", err)
	}
	return prs, nil
}

func (g ghCLI) PullRequests(ctx context.Context, repo string) ([]PullRequest, error) {
	return g.list(ctx, repo, "--state", "all", "--limit", "100")
}

func (g ghCLI) PullRequestsForBranch(ctx context.Context, repo, branch string) ([]PullRequest, error) {
	return g.list(ctx, repo, "--head", branch, "--state", "all")
}

func (g ghCLI) PullRequest(ctx context.Context, repo string, n int64) (PullRequest, error) {
	out, err := g.gh(ctx, repo, "pr", "view", strconv.FormatInt(n, 10), "--json", prFields)
	if err != nil {
		return PullRequest{}, err
	}
	var pr PullRequest
	if err := json.Unmarshal(out, &pr); err != nil {
		return PullRequest{}, fmt.Errorf("gh pr view: %w", err)
	}
	return pr, nil
}

func (g ghCLI) MergePR(ctx context.Context, repo string, n int64) error {
	_, err := g.gh(ctx, repo, "pr", "merge", strconv.FormatInt(n, 10), "--merge")
	return err
}

var keyPattern = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]*-[0-9]+)(?:[-/:\s]|$)`)

// KeyOf is the Task key a branch or pull request title starts with, in upper case, as
// web-12-cart-page, web-12 (a Parent's branch) or "WEB-12: Cart page"; empty when it carries none.
func KeyOf(s string) string {
	if m := keyPattern.FindStringSubmatch(s); m != nil {
		return strings.ToUpper(m[1])
	}
	return ""
}
