package bot

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// The Workspaces a preset makes are throwaway git repositories on this machine: Setup makes each
// with one commit, and the bots append to their workpapers and commit, as a person keeping a
// client folder would. git runs apart from the user's own settings, so a signing key or a hook
// of theirs never touches them.

// repoLocks serialise the writes to one repository among the bots of a run.
var repoLocks sync.Map // path → *sync.Mutex

func lockRepo(dir string) func() {
	m, _ := repoLocks.LoadOrStore(dir, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// git runs git in dir as who.
func git(ctx context.Context, dir, who string, args ...string) error {
	email := strings.ToLower(strings.ReplaceAll(who, " ", "-")) + "@bots.darkory.invalid"
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME="+who, "GIT_AUTHOR_EMAIL="+email, "GIT_COMMITTER_NAME="+who, "GIT_COMMITTER_EMAIL="+email)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// isRepo says whether dir is the top of a git repository.
func isRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// makeRepo makes dir a git repository whose first commit, on main, holds files, unless it is one
// already. A directory there that is not a repository is refused rather than written into.
func makeRepo(ctx context.Context, dir string, files map[string]string) error {
	defer lockRepo(dir)()
	if isRepo(dir) {
		return nil
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return fmt.Errorf("%s is a directory with files in it but not a git repository; remove it or choose another workspace root", dir)
	} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		path := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(files[p]), 0o644); err != nil {
			return err
		}
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"add", "-A"}, {"commit", "-q", "-m", "Start the folders"}} {
		if err := git(ctx, dir, "tools/bots", args...); err != nil {
			return err
		}
	}
	return nil
}

// errNoCheckout: the Workspace's path is not on this machine.
var errNoCheckout = errors.New("the Workspace is not on this machine")

// appendWorkpaper adds a dated line saying what who did on the Task key to the workpaper rel in the
// repository dir, commits it, and returns the file's content, for Evidence.
func appendWorkpaper(ctx context.Context, dir, rel, key, who, entry string) (string, error) {
	defer lockRepo(dir)()
	// A bot stopping mid-write must not kill git and leave its index locked for the next one.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if !isRepo(dir) {
		return "", errNoCheckout
	}
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	_, err = fmt.Fprintf(f, "%s  %s  %s: %s\n", time.Now().Format("2006-01-02 15:04"), key, who, entry)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if err := git(ctx, dir, who, "add", "--", filepath.ToSlash(rel)); err != nil {
		return "", err
	}
	if err := git(ctx, dir, who, "commit", "-q", "-m", key+": "+entry, "--", filepath.ToSlash(rel)); err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	return string(b), err
}
