// Package gitinfo reads what Darkory needs to know about a git repository to name it as a
// Workspace: where its root is, what to call it, and its default branch. It runs git.
package gitinfo

import (
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Repo is a git repository on this machine.
type Repo struct {
	// Root is the repository's top directory: the working tree, or a linked worktree.
	Root string
	// DefaultBranch is the branch origin's HEAD names, else the branch checked out, else main.
	DefaultBranch string
}

// Find returns the repository dir is in, and false when it is in none or git cannot be run.
func Find(ctx context.Context, dir string) (Repo, bool) {
	root, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil || root == "" {
		return Repo{}, false
	}
	return Repo{Root: filepath.Clean(root), DefaultBranch: defaultBranch(ctx, root)}, true
}

func defaultBranch(ctx context.Context, root string) string {
	// origin/HEAD is what a clone calls the default; strip the remote's name.
	if ref, err := git(ctx, root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if _, branch, ok := strings.Cut(ref, "/"); ok && branch != "" {
			return branch
		}
	}
	if branch, err := git(ctx, root, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil && branch != "" {
		return branch
	}
	return "main"
}

func git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
	return strings.TrimSpace(string(out)), err
}

var notInName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// Name is a Workspace name for the repository at root: its directory's name, with anything a
// Workspace name cannot hold turned into dashes.
func Name(root string) string {
	name := strings.TrimLeft(notInName.ReplaceAllString(filepath.Base(root), "-"), "._-")
	if len(name) > 63 {
		name = name[:63]
	}
	if name == "" {
		return "repo"
	}
	return name
}
