//go:build unix

// Command devrun builds a Go program, runs it, and builds and restarts it whenever a watched
// source file changes. `make dev` uses it for the server, so a change to the Go code needs no
// manual rebuild. It needs nothing beyond the Go toolchain.
//
//	go run ./tools/devrun -o .dev/bin/darkory -pkg ./cmd/darkory -- serve --data .dev
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	out := flag.String("o", ".dev/bin/app", "where to write the built binary")
	pkg := flag.String("pkg", ".", "the package to build")
	watch := flag.String("watch", "cmd,internal,client,api", "comma-separated directories to watch")
	every := flag.Duration("every", 500*time.Millisecond, "how often to look for changes")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *out, *pkg, strings.Split(*watch, ","), *every, flag.Args()); err != nil {
		fmt.Fprintln(os.Stderr, "devrun:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, out, pkg string, dirs []string, every time.Duration, args []string) error {
	var child *exec.Cmd
	last := snapshot(dirs)
	start := func() {
		logf("building %s", pkg)
		build := exec.CommandContext(ctx, "go", "build", "-o", out, pkg)
		build.Stdout, build.Stderr = os.Stdout, os.Stderr
		if err := build.Run(); err != nil {
			logf("build failed; waiting for the next change")
			return
		}
		child = exec.Command(out, args...)
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := child.Start(); err != nil {
			logf("starting %s: %v", out, err)
			child = nil
			return
		}
		logf("running %s %s", out, strings.Join(args, " "))
	}
	start()
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			halt(child)
			return nil
		case <-tick.C:
			now := snapshot(dirs)
			if now == last {
				continue
			}
			last = now
			logf("a source file changed; restarting")
			halt(child)
			child = nil
			start()
		}
	}
}

// snapshot summarises the watched files: a change to any of their names, sizes or times
// changes it.
func snapshot(dirs []string) string {
	var b strings.Builder
	for _, d := range dirs {
		_ = filepath.WalkDir(d, func(path string, e fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if e.IsDir() {
				if name := e.Name(); path != d && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "testdata") {
					return filepath.SkipDir
				}
				return nil
			}
			if !watched(path) {
				return nil
			}
			if info, err := e.Info(); err == nil {
				fmt.Fprintf(&b, "%s %d %d\n", path, info.Size(), info.ModTime().UnixNano())
			}
			return nil
		})
	}
	return b.String()
}

// watched reports whether a change to path should rebuild: Go sources other than tests, and
// what the binary embeds (migrations, the spec).
func watched(path string) bool {
	switch filepath.Ext(path) {
	case ".go":
		return !strings.HasSuffix(path, "_test.go")
	case ".sql", ".yaml", ".html", ".tmpl":
		return true
	}
	return false
}

// halt stops the child and everything it started, giving it time to shut down cleanly.
func halt(child *exec.Cmd) {
	if child == nil || child.Process == nil {
		return
	}
	pgid := -child.Process.Pid
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		var exit *exec.ExitError
		if err != nil && !errors.As(err, &exit) {
			logf("waiting for the program: %v", err)
		}
	case <-time.After(10 * time.Second):
		logf("the program did not stop within 10 s; killing it")
		_ = syscall.Kill(pgid, syscall.SIGKILL)
		<-done
	}
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "\033[2m[devrun]\033[0m "+format+"\n", a...)
}
