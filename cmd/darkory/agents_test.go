package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/cli"
)

// darkory join needs a Task, and says so when the Runner runs no session on it.
func TestJoinNeedsASession(t *testing.T) {
	var stderr bytes.Buffer
	var ex *cli.ExitError
	if err := run([]string{"join"}, &bytes.Buffer{}, &stderr); !errors.As(err, &ex) || ex.Code != cli.ExitUsage {
		t.Fatalf("no Task: %v", err)
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	stderr.Reset()
	if err := run([]string{"join", "WEB-12", "--data", t.TempDir()}, &bytes.Buffer{}, &stderr); !errors.As(err, &ex) || ex.Code != cli.ExitFailed ||
		!strings.Contains(stderr.String(), "no session dk-WEB-12") {
		t.Fatalf("no session: %v, %s", err, stderr.String())
	}
}

// darkory agents refuses to start with no tokens, and says where it looked.
func TestAgentsNeedsTokens(t *testing.T) {
	data := t.TempDir()
	var stderr bytes.Buffer
	err := run([]string{"agents", "--data", data}, &bytes.Buffer{}, &stderr)
	if err == nil || !strings.Contains(err.Error(), filepath.Join(data, "agents")) {
		t.Fatalf("got %v", err)
	}
	if err := os.MkdirAll(filepath.Join(data, "agents"), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(data, "agents", "builder.token"), []byte("not a token\n"), 0o600)
	if err := run([]string{"agents", "--data", data}, &bytes.Buffer{}, &stderr); err == nil || !strings.Contains(err.Error(), "does not hold a Darkory token") {
		t.Fatalf("a file that is not a token: %v", err)
	}
	var ex *cli.ExitError
	if err := run([]string{"agents", "extra"}, &bytes.Buffer{}, &stderr); !errors.As(err, &ex) || ex.Code != cli.ExitUsage {
		t.Fatalf("a stray argument: %v", err)
	}
}
