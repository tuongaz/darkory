// Command fakeagent stands in for Claude Code under the runner, so the runner's loop is tested
// end to end without a model. Started as an agent's command, it reads the prompt file the runner
// wrote, writes its progress as Claude Code writes a transcript, and acts through the darkory CLI
// in the Session the runner gave it: a Note, a commit in the first Workspace, an Evidence file,
// and then what FAKEAGENT_SCENARIO says:
//
//	complete  (default) complete the Task; a Break down first files the Tasks FAKEAGENT_BREAKDOWN lists
//	handover  hand the Task over to review, Status In review
//	question  file a question aimed at the manager the prompt names, blocking the Task, and exit
//	silent    end the turn without a decision (TURN_ENDED), and answer every nudge the same way
//	hang      stop writing progress and sleep, deaf to /exit
//	busy      keep working, writing progress every 200 ms, until /exit
//	crash     exit 1
//
// The commit is of fakeagent-<KEY>.txt, or of the file FAKEAGENT_FILE names, so two Tasks can
// make a conflict. FAKEAGENT_PROMPT has it ask Claude Code's first-run questions before anything
// else (see firstRun), to test how the runner meets them.
// Like Claude Code it then waits at its prompt until the runner types /exit. It imports nothing
// under internal/.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fakeagent:", err)
		os.Exit(2)
	}
}

type agent struct {
	prompt   string
	progress string
	darkory  string
	key      string
	kind     string
	feature  string
	manager  string
	skill    string
	dirs     []string
}

func run() error {
	promptFile := flag.String("prompt-file", "", "the prompt the runner wrote")
	progress := flag.String("progress", "", "the progress file to write")
	mcpConfig := flag.String("mcp-config", "", "the MCP configuration, whose darkory command is the CLI to use")
	flag.Parse()
	b, err := os.ReadFile(*promptFile)
	if err != nil {
		return err
	}
	a := &agent{prompt: string(b), progress: *progress, darkory: darkoryBinary(*mcpConfig)}
	if err := a.read(); err != nil {
		return err
	}
	scenario := os.Getenv("FAKEAGENT_SCENARIO")
	if scenario == "" {
		scenario = "complete"
	}
	if err := firstRun(os.Getenv("FAKEAGENT_PROMPT")); err != nil {
		return err
	}
	fmt.Printf("fakeagent: working %s (%s) as %s in %v\n", a.key, a.kind, scenario, a.dirs)
	a.user("Work on Task " + a.key)

	if err := a.cli("note", a.key, "fakeagent: read the prompt; starting "+scenario); err != nil {
		return err
	}
	if len(a.dirs) > 0 {
		dir := a.dirs[0]
		name := "fakeagent-" + a.key + ".txt"
		if f := os.Getenv("FAKEAGENT_FILE"); f != "" {
			name = f
		}
		content := fmt.Sprintf("%s worked by fakeagent in session %s\n", a.key, os.Getenv("DARKORY_SESSION"))
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			return err
		}
		if err := a.git(dir, "add", name); err != nil {
			return err
		}
		if err := a.git(dir, "-c", "user.name=fakeagent", "-c", "user.email=fakeagent@darkory.invalid", "commit", "-q", "-m", a.key+": fake work"); err != nil {
			return err
		}
	}
	logFile := filepath.Join(os.TempDir(), fmt.Sprintf("fakeagent-%s-%d.log", a.key, os.Getpid()))
	if err := os.WriteFile(logFile, []byte("ok 1 - the fake test passed\n"), 0o600); err != nil {
		return err
	}
	defer os.Remove(logFile)
	if err := a.cli("attach", a.key, logFile, "--name", "test-"+a.key+".log"); err != nil {
		return err
	}

	switch scenario {
	case "complete":
		if a.kind == "breakdown" {
			if err := a.breakDown(); err != nil {
				return err
			}
		}
		if err := a.cli("complete", a.key, "--note", "fakeagent: done"); err != nil {
			return err
		}
	case "handover":
		if err := a.cli("handover", a.key, "--skill", "review", "--status", "In review", "--note", "fakeagent: built; please review"); err != nil {
			return err
		}
	case "question":
		if err := a.cli("file", "--blocks", a.key, "--aim", a.manager, "--title", "fakeagent: a question about "+a.key); err != nil {
			return err
		}
		a.answer("I asked " + a.manager + " and stop here.")
		return nil
	case "silent":
		a.answer("I am not sure what to do next.")
		a.line("TURN_ENDED")
	case "hang":
		fmt.Println("fakeagent: hanging")
		time.Sleep(time.Hour)
		return nil
	case "busy":
		fmt.Println("fakeagent: busy until /exit")
		go func() {
			for {
				a.tool("sleep 0.2")
				time.Sleep(200 * time.Millisecond)
				a.result("")
			}
		}()
	case "crash":
		fmt.Println("fakeagent: crashing")
		os.Exit(1)
	default:
		return fmt.Errorf("no scenario %q", scenario)
	}
	if scenario != "silent" && scenario != "busy" {
		a.answer("Done with " + a.key + ".")
	}
	return a.wait(scenario)
}

// wait sits at the prompt, as Claude Code does, until /exit. A silent agent answers every other
// line by ending its turn again.
func (a *agent) wait(scenario string) error {
	for stdin.Scan() {
		in := strings.TrimSpace(stdin.Text())
		fmt.Printf("fakeagent: read %q\n", in)
		if in == "/exit" {
			return nil
		}
		a.user(in)
		a.answer("Noted.")
		if scenario == "silent" {
			a.line("TURN_ENDED")
		}
	}
	return nil
}

// stdin is the lines typed into the agent.
var stdin = bufio.NewScanner(os.Stdin)

// firstRun asks Claude Code's first-run questions, as its dialogs show them, as mode says:
//
//	claude  as Claude Code 2.1 does: the folder-trust dialog unless $CLAUDE_CONFIG_DIR/.claude.json
//	        trusts the working directory, then the Bypass Permissions mode warning unless its
//	        settings.json has accepted it
//	always  both, whatever the configuration says
//	again   the folder-trust dialog, and once it is accepted the same again
//
// A dialog's highlighted choice is "No, exit": it is accepted by a Down before the Enter, and
// declining it exits 1. An accepted dialog clears the screen, as Claude Code's does.
func firstRun(mode string) error {
	if mode == "" {
		return nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(wd); err == nil {
		wd = real
	}
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	var config struct {
		Projects map[string]struct {
			Trusted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	var settings struct {
		Accepted bool `json:"skipDangerousModePermissionPrompt"`
	}
	if dir != "" {
		if b, err := os.ReadFile(filepath.Join(dir, ".claude.json")); err == nil {
			json.Unmarshal(b, &config)
		}
		if b, err := os.ReadFile(filepath.Join(dir, "settings.json")); err == nil {
			json.Unmarshal(b, &settings)
		}
	}
	trust := " Accessing workspace:\n\n " + wd + "\n\n Quick safety check: Is this a project you created or one you trust?\n\n" +
		" ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n"
	bypass := "  WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ No, exit\n    Yes, I accept\n\n" +
		"  Enter to confirm · Esc to cancel\n"
	var ask []string
	switch mode {
	case "claude":
		if !config.Projects[wd].Trusted {
			ask = append(ask, trust)
		}
		if !settings.Accepted {
			ask = append(ask, bypass)
		}
	case "always":
		ask = []string{trust, bypass}
	case "again":
		ask = []string{trust, trust}
	default:
		return fmt.Errorf("FAKEAGENT_PROMPT: no mode %q", mode)
	}
	for _, dialog := range ask {
		fmt.Print(dialog)
		if !stdin.Scan() || !strings.Contains(stdin.Text(), "\x1b[B") && !strings.Contains(stdin.Text(), "\x1bOB") {
			fmt.Println("fakeagent: declined; exiting")
			os.Exit(1)
		}
		fmt.Print("\x1b[2J\x1b[H")
	}
	return nil
}

var (
	titleLine   = regexp.MustCompile(`(?m)^# ([A-Z][A-Z0-9]*-[0-9]+): `)
	kindLine    = regexp.MustCompile(`(?m)^- Kind: (\S+)$`)
	featureLine = regexp.MustCompile(`(?m)^## Its Feature\n\n- Key: (\S+)$`)
	skillLine   = regexp.MustCompile(`(?m)^- Needs the Skill: (\S+)$`)
	aimLine     = regexp.MustCompile("--aim (\\S+) --title")
	checkout    = regexp.MustCompile(`(?m)^- [^:\n]+: (/\S+), on branch `)
)

// read finds in the prompt what the fake agent needs, and fails when the prompt lacks it.
func (a *agent) read() error {
	m := titleLine.FindStringSubmatch(a.prompt)
	if m == nil {
		return errors.New("the prompt names no Task")
	}
	a.key = m[1]
	a.kind = "work"
	if m := kindLine.FindStringSubmatch(a.prompt); m != nil {
		a.kind = m[1]
	}
	if m := featureLine.FindStringSubmatch(a.prompt); m != nil {
		a.feature = m[1]
	}
	if m := skillLine.FindStringSubmatch(a.prompt); m != nil {
		a.skill = m[1]
	}
	if m := aimLine.FindStringSubmatch(a.prompt); m != nil {
		a.manager = m[1]
	}
	for _, m := range checkout.FindAllStringSubmatch(a.prompt, -1) {
		a.dirs = append(a.dirs, strings.TrimSuffix(m[1], ","))
	}
	for _, want := range []string{"## Working rules", "## How this session ends", "darkory complete " + a.key} {
		if !strings.Contains(a.prompt, want) {
			return fmt.Errorf("the prompt does not say %q", want)
		}
	}
	return nil
}

// breakDown files the Tasks FAKEAGENT_BREAKDOWN lists, as skill:title;skill:title (one engineer
// Task by default), each naming the Workspaces FAKEAGENT_WORKSPACES lists, comma-separated.
func (a *agent) breakDown() error {
	plan := os.Getenv("FAKEAGENT_BREAKDOWN")
	if plan == "" {
		plan = "engineer:Build it"
	}
	for item := range strings.SplitSeq(plan, ";") {
		skill, title, ok := strings.Cut(item, ":")
		if !ok {
			return fmt.Errorf("FAKEAGENT_BREAKDOWN: %q is not skill:title", item)
		}
		args := []string{"file", "--feature", a.feature, "--skill", skill, "--title", title}
		for ws := range strings.SplitSeq(os.Getenv("FAKEAGENT_WORKSPACES"), ",") {
			if ws != "" {
				args = append(args, "--workspace", ws)
			}
		}
		if err := a.cli(args...); err != nil {
			return err
		}
	}
	return nil
}

// cli runs a darkory command, recording it in the progress file as Claude Code records a tool.
func (a *agent) cli(args ...string) error {
	a.tool("darkory " + strings.Join(args, " "))
	cmd := exec.Command(a.darkory, args...)
	out, err := cmd.CombinedOutput()
	fmt.Printf("$ darkory %s\n%s", strings.Join(args, " "), out)
	a.result(string(out))
	if err != nil {
		return fmt.Errorf("darkory %s: %w: %s", strings.Join(args, " "), err, out)
	}
	return nil
}

func (a *agent) git(dir string, args ...string) error {
	a.tool("git " + strings.Join(args, " "))
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	fmt.Printf("$ git %s\n%s", strings.Join(args, " "), out)
	a.result(string(out))
	if err != nil {
		return fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, out)
	}
	return nil
}

// The progress file, written as Claude Code writes its transcript.

func (a *agent) record(v any) {
	b, _ := json.Marshal(v)
	a.line(string(b))
}

func (a *agent) line(s string) {
	if a.progress == "" {
		return
	}
	f, err := os.OpenFile(a.progress, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakeagent:", err)
		return
	}
	defer f.Close()
	fmt.Fprintln(f, s)
}

type message struct {
	Role       string `json:"role"`
	StopReason string `json:"stop_reason,omitempty"`
	Content    any    `json:"content"`
}

func (a *agent) user(text string) {
	a.record(map[string]any{"type": "user", "isSidechain": false, "message": message{Role: "user", Content: text}})
}

func (a *agent) tool(command string) {
	a.record(map[string]any{"type": "assistant", "isSidechain": false, "message": message{Role: "assistant", StopReason: "tool_use",
		Content: []map[string]any{{"type": "tool_use", "id": "t", "name": "Bash", "input": map[string]string{"command": command}}}}})
}

func (a *agent) result(out string) {
	a.record(map[string]any{"type": "user", "isSidechain": false, "message": message{Role: "user",
		Content: []map[string]any{{"type": "tool_result", "tool_use_id": "t", "content": out}}}})
}

func (a *agent) answer(text string) {
	a.record(map[string]any{"type": "assistant", "isSidechain": false, "message": message{Role: "assistant", StopReason: "end_turn",
		Content: []map[string]any{{"type": "text", "text": text}}}})
}

// darkoryBinary is the CLI the fake agent runs: FAKEAGENT_DARKORY, else the command the MCP
// configuration starts darkory mcp with, else darkory on the PATH.
func darkoryBinary(mcpConfig string) string {
	if b := os.Getenv("FAKEAGENT_DARKORY"); b != "" {
		return b
	}
	if mcpConfig != "" {
		var doc struct {
			MCPServers map[string]struct {
				Command string `json:"command"`
			} `json:"mcpServers"`
		}
		if b, err := os.ReadFile(mcpConfig); err == nil && json.Unmarshal(b, &doc) == nil && doc.MCPServers["darkory"].Command != "" {
			return doc.MCPServers["darkory"].Command
		}
	}
	return "darkory"
}
