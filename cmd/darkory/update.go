package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"

	"github.com/tuongaz/darkory/internal/update"
	"github.com/tuongaz/darkory/internal/version"
)

const updateUsage = `Usage: darkory update [--check] [--version v1.2.3]

Replaces this binary with the latest release, or the one named, once the release's signature
and checksum verify. Older releases are refused. Homebrew and container installs update with
their own tools; this says which command to run.

`

// runUpdate is `darkory update` (ADR 0009): Local never updates itself, but an install-script
// binary is replaced on request.
func runUpdate(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprint(stderr, updateUsage)
		fs.PrintDefaults()
	}
	check := fs.Bool("check", false, "say whether a newer release exists, and change nothing")
	want := fs.String("version", "", "install this release instead of the latest")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("update takes no arguments, got %q", fs.Args())
	}

	exe, err := update.Executable()
	if err != nil {
		return err
	}
	update.RemoveOld(exe)
	kind := update.DetectInstall(exe, os.Getenv, update.FileExists)
	if kind != update.Standalone && !*check {
		return fmt.Errorf("this darkory came from %s; update it with: %s", kind, kind.UpdateCommand())
	}
	current := version.Version
	if update.IsDevBuild(current) {
		return fmt.Errorf("this is a development build (%s), which does not update; install a release with the install script", current)
	}
	key, keyErr := update.ParsePublicKey(update.PublicKey)
	if keyErr != nil && !*check {
		return keyErr
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	client := update.NewClient(os.Getenv)
	var rel update.Release
	if *want == "" {
		rel, err = client.Latest(ctx)
	} else {
		rel, err = client.Release(ctx, *want)
	}
	if errors.Is(err, update.ErrNoRelease) {
		if *want != "" {
			return fmt.Errorf("there is no release %s", *want)
		}
		return errors.New("no release has been published yet")
	}
	if err != nil {
		return err
	}

	switch {
	case update.SameVersion(rel.Version, current):
		fmt.Fprintf(stdout, "darkory %s is installed; nothing to update\n", current)
		return nil
	case !update.Newer(rel.Version, current) && *want != "":
		return fmt.Errorf("%s is older than this darkory, %s; to go back, reinstall with the install script and DARKORY_VERSION=%s", rel.Version, current, rel.Version)
	case !update.Newer(rel.Version, current):
		fmt.Fprintf(stdout, "darkory %s is newer than the latest release, %s; nothing to update\n", current, rel.Version)
		return nil
	case *check && keyErr != nil:
		fmt.Fprintf(stdout, "darkory %s is available (this is %s); this build cannot check releases, so reinstall with the install script\n", rel.Version, current)
		return nil
	case *check:
		fmt.Fprintln(stdout, update.Notice(update.Status{Current: current, Latest: rel.Version}, kind))
		return nil
	}

	u := &update.Updater{Client: client, PublicKey: key, Current: current, Executable: exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	fmt.Fprintf(stdout, "Updating darkory %s to %s...\n", current, rel.Version)
	if err := u.Apply(ctx, rel); err != nil {
		return fmt.Errorf("not updated: %w", err)
	}
	fmt.Fprintf(stdout, "Updated %s to darkory %s. Restart a running `darkory serve` to use it.\n", exe, rel.Version)
	return nil
}
