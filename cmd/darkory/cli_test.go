package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// help lists every command, server and CLI alike, and an unknown command is a usage error.
func TestUsageListsEveryCommand(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"help"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []string{"init", "serve", "mcp", "update", "version", "prime", "next", "takeable", "claim", "heartbeat run",
		"release", "advance", "move", "complete", "drop", "take-back", "rank", "owner", "note", "observe", "observations", "attach",
		"evidence get", "file", "block", "unblock", "show", "tasks", "propose", "activity", "project create", "project list",
		"project show", "project add", "project remove", "project set", "workflow show", "workflow set", "label create",
		"label list", "label set", "label delete", "member create", "skill create", "grant", "report-to", "token issue",
		"token revoke", "login", "logout", "me", "session close"} {
		if !strings.Contains(out.String(), "darkory "+cmd) {
			t.Errorf("help lists no %q", cmd)
		}
	}
	for _, gone := range []string{"feature", "team", "handover", "status"} {
		if strings.Contains(out.String(), "darkory "+gone+" ") {
			t.Errorf("help still lists %q", gone)
		}
	}
	for _, args := range [][]string{{"bogus"}, {}} {
		if code := exitCode(run(args, io.Discard, io.Discard)); code != 2 {
			t.Errorf("darkory %v: exit %d, want 2", args, code)
		}
	}
	// A group's name alone reaches internal/cli too, which names its commands.
	var group bytes.Buffer
	if code := exitCode(run([]string{"label"}, io.Discard, &group)); code != 2 || !strings.Contains(group.String(), "darkory label set <task>") {
		t.Errorf("darkory label: exit %d, %q", code, group.String())
	}
	// A CLI command reaches internal/cli, with global flags before it.
	var errw bytes.Buffer
	err := run([]string{"--json", "claim"}, io.Discard, &errw)
	if code := exitCode(err); code != 2 || !strings.Contains(errw.String(), "darkory claim: needs <task>") {
		t.Fatalf("darkory --json claim: exit %d, %q", code, errw.String())
	}
}
