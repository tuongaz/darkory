package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Git runs git for the runner. Merges carry an author: the repository's own user.name and
// user.email when it has them, else "Darkory runner", so a machine with no git identity still
// merges.

// runGit runs git in dir and returns its standard output, trimmed.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	out, _, err := gitOutput(ctx, dir, nil, args...)
	return out, err
}

// gitOutput runs git in dir with env added to the environment. A failure carries git's
// standard error; the exit code is 1 for a merge-tree conflict.
func gitOutput(ctx context.Context, dir string, env []string, args ...string) (string, int, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	cmd.Env = append(cmd.Env, env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	out := strings.TrimSpace(stdout.String())
	if err != nil {
		code := -1
		var ex *exec.ExitError
		if errors.As(err, &ex) {
			code = ex.ExitCode()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = out
		}
		return out, code, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, msg)
	}
	return out, 0, nil
}

// identity is the environment that names the author of the runner's commits, when the
// repository names none.
func identity(ctx context.Context, repo string) []string {
	if email, _ := runGit(ctx, repo, "config", "--get", "user.email"); email != "" {
		return nil
	}
	return []string{"GIT_AUTHOR_NAME=Darkory runner", "GIT_AUTHOR_EMAIL=runner@darkory.invalid",
		"GIT_COMMITTER_NAME=Darkory runner", "GIT_COMMITTER_EMAIL=runner@darkory.invalid"}
}

// branchExists says whether repo has the local branch name.
func branchExists(ctx context.Context, repo, name string) bool {
	_, err := runGit(ctx, repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

// branchesWithPrefix lists repo's local branches whose names start with prefix.
func branchesWithPrefix(ctx context.Context, repo, prefix string) ([]string, error) {
	out, err := runGit(ctx, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"+prefix)
	if err != nil || out == "" {
		return nil, err
	}
	return strings.Split(out, "\n"), nil
}

// defaultBranch is the branch Ship lands on in repo when the Workspace does not say: the remote's
// HEAD, else main or master, else the branch checked out.
func defaultBranch(ctx context.Context, repo string) string {
	if ref, err := runGit(ctx, repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if _, name, ok := strings.Cut(ref, "/"); ok && branchExists(ctx, repo, name) {
			return name
		}
	}
	for _, name := range []string{"main", "master"} {
		if branchExists(ctx, repo, name) {
			return name
		}
	}
	if name, err := runGit(ctx, repo, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		return name
	}
	return "main"
}

// checkedOut maps each branch checked out in a worktree of repo to that worktree's path.
func checkedOut(ctx context.Context, repo string) (map[string]string, error) {
	out, err := runGit(ctx, repo, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	at := map[string]string{}
	var path string
	for l := range strings.Lines(out) {
		l = strings.TrimSpace(l)
		switch {
		case strings.HasPrefix(l, "worktree "):
			path = strings.TrimPrefix(l, "worktree ")
		case strings.HasPrefix(l, "branch refs/heads/"):
			at[strings.TrimPrefix(l, "branch refs/heads/")] = path
		}
	}
	return at, nil
}

// MergeResult is how a merge went.
type MergeResult struct {
	// Commit is the merge commit, or the target's tip when there was nothing to merge.
	Commit string
	// Already says source was merged into target before.
	Already bool
	// Conflict says what conflicted, when the merge was abandoned; empty when it went in.
	Conflict string
}

// ErrDirty is a merge refused because its target is checked out with uncommitted changes.
type ErrDirty struct{ Branch, Worktree string }

func (e ErrDirty) Error() string {
	return fmt.Sprintf("%s is checked out in %s with uncommitted changes", e.Branch, e.Worktree)
}

// mergeBranch merges source into target in repo with a merge commit (--no-ff), as ADR 0014's
// merges are. A target checked out in a worktree, as the default branch usually is in the
// repository a person works in, is merged there, and only when that worktree has no uncommitted
// changes; a conflict there is aborted. A target checked out nowhere is merged without a checkout:
// git merge-tree writes the merged tree, commit-tree the commit, and the branch moves only if it
// has not moved meanwhile. A conflict leaves everything as it was and is returned in the result.
func mergeBranch(ctx context.Context, repo, source, target, message string) (MergeResult, error) {
	old, err := runGit(ctx, repo, "rev-parse", "--verify", "refs/heads/"+target)
	if err != nil {
		return MergeResult{}, err
	}
	src, err := runGit(ctx, repo, "rev-parse", "--verify", "refs/heads/"+source)
	if err != nil {
		return MergeResult{}, err
	}
	if _, err := runGit(ctx, repo, "merge-base", "--is-ancestor", src, old); err == nil {
		return MergeResult{Commit: old, Already: true}, nil
	}
	env := identity(ctx, repo)
	at, err := checkedOut(ctx, repo)
	if err != nil {
		return MergeResult{}, err
	}
	if wt, ok := at[target]; ok {
		if dirty, err := runGit(ctx, wt, "status", "--porcelain", "--untracked-files=no"); err != nil {
			return MergeResult{}, err
		} else if dirty != "" {
			return MergeResult{}, ErrDirty{Branch: target, Worktree: wt}
		}
		if out, _, err := gitOutput(ctx, wt, env, "merge", "--no-ff", "--no-edit", "-m", message, source); err != nil {
			files, _ := runGit(ctx, wt, "diff", "--name-only", "--diff-filter=U")
			if _, aerr := runGit(ctx, wt, "merge", "--abort"); aerr != nil && files == "" {
				// Not a conflict: the merge failed before it began.
				return MergeResult{}, err
			}
			return MergeResult{Conflict: conflictText(files, out+"\n"+err.Error())}, nil
		}
		sha, err := runGit(ctx, wt, "rev-parse", "HEAD")
		return MergeResult{Commit: sha}, err
	}
	out, code, err := gitOutput(ctx, repo, env, "merge-tree", "--write-tree", "--name-only", old, src)
	if code == 1 {
		files, msgs, _ := strings.Cut(out, "\n\n")
		_, files, _ = strings.Cut(files, "\n") // the first line is the tree
		return MergeResult{Conflict: conflictText(files, msgs)}, nil
	}
	if err != nil {
		return MergeResult{}, err
	}
	tree, _, _ := strings.Cut(out, "\n")
	sha, _, err := gitOutput(ctx, repo, env, "commit-tree", tree, "-p", old, "-p", src, "-m", message)
	if err != nil {
		return MergeResult{}, err
	}
	if _, err := runGit(ctx, repo, "update-ref", "refs/heads/"+target, sha, old); err != nil {
		return MergeResult{}, err
	}
	return MergeResult{Commit: sha}, nil
}

// conflictText says what conflicted: the files, then git's messages.
func conflictText(files, messages string) string {
	var b strings.Builder
	if files = strings.TrimSpace(files); files != "" {
		b.WriteString("Conflicting files:\n")
		for f := range strings.Lines(files) {
			b.WriteString("  " + strings.TrimSpace(f) + "\n")
		}
	}
	if messages = strings.TrimSpace(messages); messages != "" {
		b.WriteString("\ngit said:\n" + messages + "\n")
	}
	return strings.TrimSpace(b.String())
}
