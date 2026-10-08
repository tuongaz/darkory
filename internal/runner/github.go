package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// A Workspace in pull_request mode lands through GitHub: a Parent's Complete opens its branch's
// pull request, and a merged pull request carrying a Task's key completes its review (D14). The runner
// talks to GitHub through the gh CLI, behind GitHub so tests stand in for it.

// PullRequest is a pull request as gh lists it.
type PullRequest struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
	URL         string `json:"url"`
}

// GitHub opens and lists pull requests of the repository at repo.
type GitHub interface {
	// CreatePR opens a pull request of head into base and returns its URL.
	CreatePR(ctx context.Context, repo, base, head, title, body string) (string, error)
	// MergedPRs lists the repository's recently merged pull requests.
	MergedPRs(ctx context.Context, repo string) ([]PullRequest, error)
}

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

func (g ghCLI) MergedPRs(ctx context.Context, repo string) ([]PullRequest, error) {
	out, err := g.gh(ctx, repo, "pr", "list", "--state", "merged", "--json", "number,title,headRefName,url", "--limit", "50")
	if err != nil {
		return nil, err
	}
	var prs []PullRequest
	if err := json.Unmarshal(out, &prs); err != nil {
		return nil, fmt.Errorf("gh pr list: %w", err)
	}
	return prs, nil
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
