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
	"strings"

	"github.com/tuongaz/darkory/internal/update"
	"github.com/tuongaz/darkory/internal/version"
)

const updateUsage = `Usage: darkory update [--check] [--version v1.2.3]

Replaces this binary with the latest release, or the one named, once the release's signature
and checksum verify. Older releases are refused, and a prerelease installs only when named.
Homebrew and container installs update with their own tools; this says which command to run.

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
	want := fs.String("version", "", "install this release instead of the latest; the only way to install a prerelease")
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return updateBinary(ctx, updateTarget{current: version.Version, exe: exe, publicKey: update.PublicKey, getenv: os.Getenv, fileExists: update.FileExists},
		*check, *want, stdout)
}

// updateTarget is the binary `darkory update` replaces: this one, or a stand-in in tests.
type updateTarget struct {
	// current is the binary's version and exe its path, with symlinks resolved.
	current, exe string
	// publicKey is the release key compiled into the binary.
	publicKey string
	// getenv and fileExists tell what kind of install this is (update.DetectInstall).
	getenv     func(string) string
	fileExists func(string) bool
}

// updateBinary replaces t's binary with the latest release, or with the release want names
// (which may be a prerelease), or only says what it would do when check is set.
func updateBinary(ctx context.Context, t updateTarget, check bool, want string, stdout io.Writer) error {
	if want != "" && !update.ValidTag("v"+strings.TrimPrefix(want, "v")) {
		return fmt.Errorf("--version takes a version such as v1.2.3 or v1.3.0-rc.1, got %+.40q", want)
	}
	update.RemoveOld(t.exe)
	kind := update.DetectInstall(t.exe, t.getenv, t.fileExists)
	if kind != update.Standalone && !check {
		return fmt.Errorf("this darkory came from %s; update it with: %s", kind, kind.UpdateCommand())
	}
	current := t.current
	if update.IsDevBuild(current) {
		return fmt.Errorf("this is a development build (%s), which does not update; install a release with the install script", current)
	}
	key, keyErr := update.ParsePublicKey(t.publicKey)
	if keyErr != nil && !check {
		return keyErr
	}

	client := update.NewClient(t.getenv)
	var rel update.Release
	var err error
	if want == "" {
		rel, err = client.Latest(ctx)
	} else {
		rel, err = client.Release(ctx, want)
	}
	switch {
	case errors.Is(err, update.ErrNoRelease) && want != "":
		return fmt.Errorf("there is no release %s", want)
	case errors.Is(err, update.ErrNoRelease):
		return errors.New("no release has been published yet")
	case errors.Is(err, update.ErrPrerelease):
		return fmt.Errorf("%w; to install it anyway, name it with --version", err)
	case err != nil:
		return err
	}

	switch {
	case update.SameVersion(rel.Version, current):
		fmt.Fprintf(stdout, "darkory %s is installed; nothing to update\n", current)
		return nil
	case !update.Newer(rel.Version, current) && want != "":
		return fmt.Errorf("%s is older than this darkory, %s; to go back, reinstall with the install script and DARKORY_VERSION=%s", rel.Version, current, rel.Version)
	case !update.Newer(rel.Version, current):
		fmt.Fprintf(stdout, "darkory %s is newer than the latest release, %s; nothing to update\n", current, rel.Version)
		return nil
	case check && keyErr != nil:
		fmt.Fprintf(stdout, "darkory %s is available (this is %s); this build cannot check releases, so reinstall with the install script\n", rel.Version, current)
		return nil
	case check:
		fmt.Fprintln(stdout, update.Notice(update.Status{Current: current, Latest: rel.Version}, kind))
		return nil
	}

	u := &update.Updater{Client: client, PublicKey: key, Current: current, Executable: t.exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	fmt.Fprintf(stdout, "Updating darkory %s to %s...\n", current, rel.Version)
	if err := u.Apply(ctx, rel); err != nil {
		return fmt.Errorf("not updated: %w", err)
	}
	fmt.Fprintf(stdout, "Updated %s to darkory %s. Restart a running `darkory serve` to use it.\n", t.exe, rel.Version)
	return nil
}
