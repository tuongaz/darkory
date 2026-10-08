package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/cli"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
)

// These tests run the runner against a real server in the test process, with tools/fakeagent as
// the agents' command and the test binary standing in for darkory (TestMain), on both engines.
// e2e/runner_test.go runs the same with the built binary.
//
// model v2: the runner's end-to-end tests went until M3 rebuilds its branches and merges on
// Parents and Steps (the runner reads Features, and fakeagent hands over and files with Skills):
// TestRunnerWorksAFeature, TestRunnerMergesATaskCompletedWithoutReview,
// TestRunnerStartsTheNextSessionOnceTheEarlierEnds, TestRunnerSessionStates,
// TestRunnerReleasesASilentSession, TestRunnerInTmux and TestRunnerTerminal here;
// TestRunnerPullRequestMode in pr_test.go; TestRunnerUsesThePersonsClaudeCodeConfiguration,
// TestRunnerAnswersOneFirstRunPrompt and TestRunnerNeverAnswersAfterTheFirstTurn in
// claude_test.go. Their fixture stays for M3.

const asDarkory = "RUNNER_TEST_AS_DARKORY"

func TestMain(m *testing.M) {
	if os.Getenv(asDarkory) == "1" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		err := cli.Run(ctx, os.Args[1:], cli.OSEnv())
		stop()
		if ex, ok := err.(*cli.ExitError); ok {
			os.Exit(ex.Code)
		}
		os.Exit(0)
	}
	code := m.Run()
	if fakeDir != "" {
		os.RemoveAll(fakeDir)
	}
	os.Exit(code)
}

var (
	fakeOnce sync.Once
	fakeDir  string
	fakeBin  string
	fakeErr  error
)

// fakeAgent builds tools/fakeagent once per run.
func fakeAgent(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		if fakeDir, fakeErr = os.MkdirTemp("", "fakeagent-"); fakeErr != nil {
			return
		}
		fakeBin = filepath.Join(fakeDir, "fakeagent")
		out, err := exec.Command("go", "build", "-o", fakeBin, "github.com/tuongaz/darkory/tools/fakeagent").CombinedOutput()
		if err != nil {
			fakeErr = fmt.Errorf("building fakeagent: %v\n%s", err, out)
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakeBin
}

// testTimings make a session take about a second.
var testTimings = Timings{Wait: time.Second, ClaimTimeout: 3 * time.Second, Tick: 100 * time.Millisecond, Stale: 1500 * time.Millisecond,
	Nudge: 400 * time.Millisecond, Exit: 2 * time.Second, Poll: 200 * time.Millisecond, Retry: 200 * time.Millisecond}

// fixture is an Install with a git repository as Project WEB's default Workspace, ada as its human
// admin, and the agents the runner runs, set up through /v1 as a person would.
type fixture struct {
	t        *testing.T
	srv      *server.Server
	ts       *httptest.Server
	timings  Timings
	tokens   map[string]string
	ids      map[string]string
	repo     string
	data     string
	progress string
	log      *lockedBuffer
	gh       GitHub
}

func newFixture(t *testing.T, st *store.Store) *fixture {
	t.Helper()
	fakeAgent(t)
	disk, err := blob.NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(st, server.Options{Blobs: disk, KeepAlive: 100 * time.Millisecond})
	init, err := srv.Core().Init(t.Context(), "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	f := &fixture{t: t, srv: srv, ts: ts, timings: testTimings, tokens: map[string]string{"ada": init.Token.Secret}, ids: map[string]string{"ada": init.Member.ID},
		repo: gitRepo(t), data: t.TempDir(), progress: t.TempDir(), log: &lockedBuffer{}, gh: &fakeGitHub{}}
	f.ok("ada", "project", "create", "WEB", "Web", "--member", "ada")
	f.ok("ada", "skill", "create", "build", "--kind", "generic", "--body", "Build it, with tests.")
	f.ok("ada", "skill", "create", "review", "--kind", "generic", "--body", "Review it.")
	f.ok("ada", "workspace", "add", "web", "--path", f.repo)
	f.ok("ada", "project", "set", "WEB", "--workspace", "web")
	return f
}

// agent makes an agent Member in WEB with skills, reporting to ada, whose command is the fake
// agent in scenario.
func (f *fixture) agent(name, scenario string, skills ...string) {
	f.t.Helper()
	var m client.Member
	f.json(&m, "ada", "member", "create", name, "--kind", "agent")
	f.ok("ada", "project", "add", "WEB", name)
	f.ok("ada", "report-to", name, "ada")
	for _, s := range skills {
		f.ok("ada", "grant", name, s)
	}
	var tok client.IssuedToken
	f.json(&tok, "ada", "token", "issue", name, "--name", "runner")
	f.tokens[name], f.ids[name] = tok.Secret, m.ID
	f.setScenario(name, scenario)
}

// setScenario gives an agent the fake agent as its command, in scenario.
func (f *fixture) setScenario(name, scenario string) {
	f.t.Helper()
	progress := filepath.Join(f.progress, "{session_id}.jsonl")
	f.ok("ada", "agent", "set", name, "--command", fakeBin, "--model", "fake-1", "--unattended", "--progress-file", progress,
		"--arg=--prompt-file", "--arg={prompt_file}", "--arg=--progress", "--arg="+progress, "--arg=--mcp-config", "--arg={mcp_config}",
		"--env", "FAKEAGENT_SCENARIO="+scenario, "--env", asDarkory+"=1", "--env", "FAKEAGENT_BREAKDOWN=build:Cart page")
}

// run starts the runner with the named agents' tokens, sessions as child processes; it stops
// when the test ends.
func (f *fixture) run(agents ...string) *Runner {
	f.t.Helper()
	return f.runWith("off", agents...)
}

// runWith is run with tmux on or off.
func (f *fixture) runWith(tmux string, agents ...string) *Runner {
	f.t.Helper()
	var tokens []Token
	for _, a := range agents {
		tokens = append(tokens, Token{Name: a, Secret: f.tokens[a]})
	}
	exe, err := os.Executable()
	if err != nil {
		f.t.Fatal(err)
	}
	r, err := New(Config{URL: f.ts.URL, Data: f.data, Tokens: tokens, Timings: f.timings, Tmux: tmux, Darkory: exe,
		Log: slog.New(slog.NewTextHandler(f.log, nil)), GitHub: f.gh})
	if err != nil {
		f.t.Fatal(err)
	}
	f.srv.AttachRunner(r)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	f.t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				f.t.Errorf("the runner: %v", err)
			}
		case <-time.After(30 * time.Second):
			f.t.Error("the runner did not stop")
		}
		if f.t.Failed() {
			f.t.Logf("the runner's log:\n%s", f.log)
		}
	})
	return r
}

type fakeGitHub struct{}

func (*fakeGitHub) CreatePR(context.Context, string, string, string, string, string) (string, error) {
	return "", fmt.Errorf("no GitHub here")
}
func (*fakeGitHub) MergedPRs(context.Context, string) ([]PullRequest, error) { return nil, nil }

// ok runs a CLI command as member, in-process.
func (f *fixture) ok(member string, args ...string) string {
	f.t.Helper()
	var out, errw bytes.Buffer
	env := cli.Env{Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errw, Getenv: func(k string) string {
		return map[string]string{"DARKORY_URL": f.ts.URL, "DARKORY_TOKEN": f.tokens[member], "DARKORY_SESSION": member + "-cli"}[k]
	}}
	if err := cli.Run(f.t.Context(), args, env); err != nil {
		f.t.Fatalf("%s: darkory %s: %v\n%s%s", member, strings.Join(args, " "), err, out.String(), errw.String())
	}
	return out.String()
}

func (f *fixture) json(v any, member string, args ...string) {
	f.t.Helper()
	out := f.ok(member, append(args, "--json")...)
	if err := json.Unmarshal([]byte(out), v); err != nil {
		f.t.Fatalf("darkory %s --json: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func (f *fixture) task(key string) client.TaskDetail {
	f.t.Helper()
	var d client.TaskDetail
	f.json(&d, "ada", "show", key)
	return d
}

// parent reads a Parent, with its Subtasks and its own Evidence.
func (f *fixture) parent(key string) client.TaskDetail { return f.task(key) }

func notesOf(d client.TaskDetail) string {
	var b strings.Builder
	for _, n := range d.Notes {
		b.WriteString(n.Body + "\n")
	}
	return b.String()
}

func evidenceNames(list []client.Evidence) []string {
	var names []string
	for _, e := range list {
		names = append(names, e.Filename)
	}
	return names
}

// sessionLogs counts the names that are a session log of agent on task, session-<KEY>-<agent>-<HHMMSS>.log.
func sessionLogs(names []string, task, agent string) int {
	re := regexp.MustCompile(`^session-` + regexp.QuoteMeta(task) + `-` + regexp.QuoteMeta(agent) + `-[0-9]{6}\.log$`)
	n := 0
	for _, name := range names {
		if re.MatchString(name) {
			n++
		}
	}
	return n
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func eventually(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within %s", what, d)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// logTime is when the runner's log first says msg (a prefix) for agent.
func logTime(t *testing.T, log, msg, agent string) time.Time {
	t.Helper()
	for l := range strings.Lines(log) {
		if strings.Contains(l, `msg="`+msg) && strings.Contains(l, " agent="+agent+" ") {
			at, _, _ := strings.Cut(strings.TrimPrefix(l, "time="), " ")
			ts, err := time.Parse(time.RFC3339Nano, at)
			if err != nil {
				t.Fatalf("the log's time %q: %v", at, err)
			}
			return ts
		}
	}
	t.Fatalf("the log never says %q for %s", msg, agent)
	return time.Time{}
}
