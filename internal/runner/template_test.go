package runner

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

var values = Values{PromptFile: "/d/sessions/WEB-12/prompt.md", Workspace: "/d/workspaces/WEB-12/web",
	SessionID: "0199e1a2-0000-7000-8000-000000000001", Model: "claude-sonnet-5-5", MCPConfig: "/d/sessions/WEB-12/mcp.json", Task: "WEB-12"}

func TestRenderTheDefaultCommand(t *testing.T) {
	got, err := Render("", nil, true, values)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"claude", "--session-id", values.SessionID, "--model", "claude-sonnet-5-5", "--dangerously-skip-permissions",
		"--mcp-config", "/d/sessions/WEB-12/mcp.json", "--append-system-prompt-file", "/d/sessions/WEB-12/prompt.md",
		"Work on Task WEB-12: the system prompt holds the Task, its record and the rules for ending it."}
	if !slices.Equal(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}

	// No model: the flag goes with its value. Not unattended: no permission skip.
	v := values
	v.Model = ""
	got, err = Render("/opt/bin/claude", nil, false, v)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(got, "--model") || slices.Contains(got, "--dangerously-skip-permissions") || got[0] != "/opt/bin/claude" {
		t.Fatalf("got %q", got)
	}
	if !slices.Contains(got, "--session-id") {
		t.Fatalf("a claude at another path keeps the default arguments: %q", got)
	}
}

func TestRenderAnotherCommand(t *testing.T) {
	got, err := Render("{workspace}/bin/agent", []string{"--prompt={prompt_file}", "--settings", `{"x":{"y":1}}`, "{model}", "run {task} in {workspace}"}, true, values)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/d/workspaces/WEB-12/web/bin/agent", "--prompt=/d/sessions/WEB-12/prompt.md", "--settings", `{"x":{"y":1}}`,
		"claude-sonnet-5-5", "run WEB-12 in /d/workspaces/WEB-12/web"}
	if !slices.Equal(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	// Another command with no arguments gets none.
	got, err = Render("fakeagent", nil, true, values)
	if err != nil || !slices.Equal(got, []string{"fakeagent"}) {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := Render("agent", []string{"{promptfile}"}, true, values); err == nil || !strings.Contains(err.Error(), "{promptfile} is not a placeholder") {
		t.Fatalf("a misspelt placeholder: %v", err)
	}
}

func TestShellJoinRoundTrips(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	args := []string{"plain", "with space", "it's", `"double"`, "$HOME", "`tick`", "a\nb", "", "--x={y}"}
	out, err := exec.Command(sh, "-c", `f() { for a in "$@"; do printf '%s\0' "$a"; done; }; f `+ShellJoin(args)).Output()
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00")
	if !slices.Equal(got, args) {
		t.Fatalf("got %q\nwant %q", got, args)
	}
}
