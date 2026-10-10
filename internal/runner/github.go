package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
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
	// HeadRefOid is the commit its head is at.
	HeadRefOid string `json:"headRefOid"`
	// IsCrossRepository says its head is in a fork, HeadRepositoryOwner's: never a Task's.
	IsCrossRepository   bool `json:"isCrossRepository"`
	HeadRepositoryOwner struct {
		Login string `json:"login"`
	} `json:"headRepositoryOwner"`
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
	// MergePR merges pull request n with a merge commit, only while its head is at the commit
	// head; GitHub's refusal is the error, in its words.
	MergePR(ctx context.Context, repo string, n int64, head string) error
}

// prFields are the fields the Runner reads of a pull request.
const prFields = "number,title,headRefName,baseRefName,url,state,headRefOid,isCrossRepository,headRepositoryOwner"

// ghCLI is GitHub through the gh CLI, signed in as the person running the Install.
type ghCLI struct{}

// ghError is gh failing: the command, how it ended, and what it said on stderr. Its text is all of
// it, for logs.
type ghError struct {
	Args   []string
	Err    error
	Stderr string
}

func (e *ghError) Error() string {
	return fmt.Sprintf("gh %s: %v: %s", strings.Join(e.Args[:min(len(e.Args), 3)], " "), e.Err, e.Stderr)
}

func (e *ghError) Unwrap() error { return e.Err }

// githubRefusal is GitHub refusing an act: its text is GitHub's own sentence, as the Owner reads
// it, without gh's command or its leading "X "; the gh error under it is for logs.
type githubRefusal struct{ gh *ghError }

func (e *githubRefusal) Error() string {
	if e.gh.Stderr == "" {
		return e.gh.Error()
	}
	return strings.TrimPrefix(e.gh.Stderr, "X ")
}

func (e *githubRefusal) Unwrap() error { return e.gh }

func (ghCLI) gh(ctx context.Context, repo string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = repo
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, &ghError{Args: args, Err: err, Stderr: strings.TrimSpace(stderr.String())}
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

func (g ghCLI) MergePR(ctx context.Context, repo string, n int64, head string) error {
	_, err := g.gh(ctx, repo, "pr", "merge", strconv.FormatInt(n, 10), "--merge", "--match-head-commit", head)
	var ge *ghError
	if errors.As(err, &ge) {
		return &githubRefusal{gh: ge}
	}
	return err
}
