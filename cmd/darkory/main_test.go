package main

import (
	"bytes"
	"io"
	"log/slog"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/wake"
)

func TestInitRunsOnce(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	if err := run([]string{"init", "--data", dir, "--org", "Acme", "--name", "ada"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	printed := out.String()
	for _, want := range []string{`"Acme"`, "First Member: ada (human, admin)", "dk_", "http://127.0.0.1:7357/v1/login-links/"} {
		if !strings.Contains(printed, want) {
			t.Fatalf("init printed no %q:\n%s", want, printed)
		}
	}
	err := run([]string{"init", "--data", dir}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "runs once") {
		t.Fatalf("a second init: %v", err)
	}
}

// serve prints a login link for the Member init created each time it starts, and opens it unless
// told not to.
func TestServePrintsAStartupLink(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"init", "--data", dir, "--name", "ada"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	st, err := openStore(ctx, config.Store{DataDir: dir, Database: filepath.Join(dir, "darkory.db")}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	svc := core.New(st, clock.Real{}, wake.New(), nil)

	var opened []string
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	link := regexp.MustCompile(`http://127\.0\.0\.1:9999/v1/login-links/\S+`)
	for _, open := range []bool{true, false} {
		var out bytes.Buffer
		printStartupLink(ctx, svc, "http://127.0.0.1:9999", open, &out, slog.New(slog.DiscardHandler))
		if !strings.Contains(out.String(), "Sign in as ada") || !link.MatchString(out.String()) {
			t.Fatalf("serve printed %q", out.String())
		}
	}
	if len(opened) != 1 || !link.MatchString(opened[0]) {
		t.Fatalf("opened %v, want the first link only", opened)
	}
}
