package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/cli"
)

// darkory mcp refuses a plain http URL to a host other than this machine, which would send the
// token in clear text, and warns that --token shows the token in the process list (security
// review L10).
func TestMCPRefusesPlainHTTPToAnotherHost(t *testing.T) {
	t.Setenv("DARKORY_URL", "http://darkory.example:7357")
	t.Setenv("DARKORY_TOKEN", "")
	t.Setenv("DARKORY_INSECURE", "")
	var stderr bytes.Buffer
	err := runMCP([]string{"--token", "dk_secret"}, &stderr)
	var ex *cli.ExitError
	if !errors.As(err, &ex) || ex.Code != cli.ExitUsage {
		t.Fatalf("runMCP: %v, want exit %d", err, cli.ExitUsage)
	}
	if out := stderr.String(); !strings.Contains(out, "clear text") || !strings.Contains(out, "--insecure") ||
		!strings.Contains(out, "warning: --token") || strings.Contains(out, "dk_secret") {
		t.Errorf("stderr: %q", out)
	}
}
