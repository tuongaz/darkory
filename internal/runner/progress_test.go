package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectSlug(t *testing.T) {
	for cwd, want := range map[string]string{
		"/Users/ada/dev/darkory":                        "-Users-ada-dev-darkory",
		"/Users/ada/.claude/skills":                     "-Users-ada--claude-skills",
		"/private/tmp/dk/workspaces/WEB-12/web_app.v2":  "-private-tmp-dk-workspaces-WEB-12-web-app-v2",
		"/var/folders/qn/T/friction persona/2026-10-03": "-var-folders-qn-T-friction-persona-2026-10-03",
	} {
		if got := ProjectSlug(cwd); got != want {
			t.Errorf("ProjectSlug(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestTranscriptPathResolvesTheWorkingDirectory(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	resolved, _ := filepath.EvalSymlinks(real)
	got := TranscriptPath("/home/a/.claude", link, "sid")
	if want := filepath.Join("/home/a/.claude/projects", ProjectSlug(resolved), "sid.jsonl"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

// Lines as Claude Code 2.1 writes them, cut down to the fields the runner reads.
const (
	userPrompt   = `{"type":"user","isSidechain":false,"message":{"role":"user","content":"Work on Task WEB-12"}}`
	thinking     = `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"…"}]}}`
	toolUse      = `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`
	toolResult   = `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`
	endTurn      = `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}`
	noStopReason = `{"type":"assistant","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}`
	sidechain    = `{"type":"user","isSidechain":true,"message":{"role":"user","content":"subagent prompt"}}`
	title        = `{"type":"ai-title","aiTitle":"Cart page","sessionId":"sid"}`
	cost         = `{"type":"cost-state","sessionId":"sid","totalCostUSD":0.4}`
	attachment   = `{"type":"attachment","isSidechain":false,"attachment":{"type":"todo"}}`
)

func TestTurnHasEnded(t *testing.T) {
	for _, c := range []struct {
		name  string
		lines []string
		want  bool
	}{
		{"empty", nil, false},
		{"the first prompt", []string{userPrompt}, false},
		{"thinking before a tool", []string{userPrompt, thinking}, false},
		{"waiting for a tool", []string{userPrompt, thinking, toolUse}, false},
		{"a tool's result", []string{userPrompt, toolUse, toolResult}, false},
		{"an answer with no tool", []string{userPrompt, toolUse, toolResult, endTurn}, true},
		{"an answer with no stop reason", []string{userPrompt, noStopReason}, true},
		{"bookkeeping after the answer", []string{userPrompt, endTurn, title, attachment, cost}, true},
		{"bookkeeping after a tool result", []string{userPrompt, toolUse, toolResult, cost, title}, false},
		{"a subagent working after the answer", []string{userPrompt, endTurn, sidechain}, true},
		{"a nudge typed after the answer", []string{userPrompt, endTurn, `{"type":"user","message":{"role":"user","content":"You stopped"}}`}, false},
		{"a generic file's marker", []string{`{"step":"note"}`, "TURN_ENDED"}, true},
		{"a generic file working again", []string{"TURN_ENDED", `{"step":"nudged"}`}, false},
		{"a cut first line and garbage", []string{`stop_reason":"end_turn"}}`, "not json", endTurn}, true},
	} {
		got := TurnHasEnded([]byte(strings.Join(c.lines, "\n") + "\n"))
		if got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// A tool call is in flight from the record asking for it until its result: a long call writes
// nothing in between, which is not the agent stalling.
func TestToolCallInFlight(t *testing.T) {
	for _, c := range []struct {
		name  string
		lines []string
		want  bool
	}{
		{"empty", nil, false},
		{"the first prompt", []string{userPrompt}, false},
		{"thinking before a tool", []string{userPrompt, thinking}, false},
		{"waiting for a tool", []string{userPrompt, thinking, toolUse}, true},
		{"bookkeeping while a tool runs", []string{userPrompt, toolUse, cost, title, sidechain}, true},
		{"a tool's result", []string{userPrompt, toolUse, toolResult}, false},
		{"an answer", []string{userPrompt, toolUse, toolResult, endTurn}, false},
		{"a generic file's marker", []string{toolUse, "TURN_ENDED"}, false},
	} {
		if _, got := lastTurn([]byte(strings.Join(c.lines, "\n") + "\n")); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestReadProgress(t *testing.T) {
	path := filepath.Join(t.TempDir(), "p.jsonl")
	r, err := ReadProgress(path)
	if err != nil || r.Exists {
		t.Fatalf("a missing file: %+v, %v", r, err)
	}
	// A transcript longer than the tail the runner reads: its cut first line is skipped.
	big := strings.Repeat(toolResult+"\n", tailBytes/len(toolResult)+10) + endTurn + "\n"
	if err := os.WriteFile(path, []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err = ReadProgress(path)
	if err != nil || !r.Exists || !r.Ended || time.Since(r.Modified) > time.Minute {
		t.Fatalf("got %+v, %v", r, err)
	}
	if err := os.WriteFile(path, []byte(big+toolUse+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, _ = ReadProgress(path); r.Ended || !r.InFlight {
		t.Fatalf("a tool use after the answer: %+v", r)
	}
}
