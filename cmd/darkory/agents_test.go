package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/cli"
)

// darkory attach with one Task joins its session; with a file it attaches Evidence, as before.
func TestAttachJoinsASessionOrAttachesEvidence(t *testing.T) {
	for _, c := range []struct {
		args []string
		join bool
	}{
		{[]string{"WEB-12"}, true},
		{[]string{"WEB-12", "--readonly"}, true},
		{[]string{"--readonly", "WEB-12", "--data", "/srv/dk"}, true},
		{[]string{"WEB-12", "report.txt"}, false},
		{[]string{"WEB-12", "report.txt", "--name", "r.txt"}, false},
		{[]string{"WEB-12", "--name", "r.txt", "report.txt"}, false},
		{[]string{"WEB-1", "shot.png", "--feature"}, false},
		{nil, false},
	} {
		if got := attachesSession(c.args); got != c.join {
			t.Errorf("attachesSession(%q) = %v, want %v", c.args, got, c.join)
		}
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
