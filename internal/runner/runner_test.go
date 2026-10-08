package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/cli"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// These tests run the runner against a real server in the test process, with tools/fakeagent as
// the agents' command and the test binary standing in for darkory (TestMain), on both engines.
// e2e/runner_test.go runs the same with the built binary.

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

// fixture is an Install with Project WEB on the default Workflow (Backlog · Plan · Build · Review ·
// Retro · Skill review), a git repository as its default Workspace, ada as its human admin, and
// the agents the runner runs, set up through /v1 as a person would.
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
	f.ok("ada", "workspace", "add", "web", "--path", f.repo)
	f.ok("ada", "project", "set", "WEB", "--workspace", "web")
	return f
}

// agent makes an agent Member in WEB with skills, reporting to ada, whose command is the fake
// agent in scenario. A reviewer advances along "pass".
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
	var env []string
	if slices.Contains(skills, "review") {
		env = append(env, "FAKEAGENT_OUTCOME=pass")
	}
	f.setScenario(name, scenario, env...)
}

// setScenario gives an agent the fake agent as its command, in scenario, with env added.
func (f *fixture) setScenario(name, scenario string, env ...string) {
	f.t.Helper()
	progress := filepath.Join(f.progress, "{session_id}.jsonl")
	args := []string{"agent", "set", name, "--command", fakeBin, "--model", "fake-1", "--unattended", "--progress-file", progress,
		"--arg=--prompt-file", "--arg={prompt_file}", "--arg=--progress", "--arg=" + progress, "--arg=--mcp-config", "--arg={mcp_config}",
		"--env", "FAKEAGENT_SCENARIO=" + scenario, "--env", asDarkory + "=1", "--env", "FAKEAGENT_BREAKDOWN=:Cart page"}
	for _, e := range env {
		args = append(args, "--env", e)
	}
	f.ok("ada", args...)
}

// workflow replaces WEB's Workflow with the body `workflow set` reads.
func (f *fixture) workflow(body string) {
	f.t.Helper()
	path := filepath.Join(f.t.TempDir(), "workflow.json")
	writeTestFile(f.t, path, body)
	f.ok("ada", "workflow", "set", "WEB", "--file", path)
}

// buildOnly is a Workflow of one Step, Build, whose one way out, "done", leads into Done: its
// holder completes a Task there without review.
const buildOnly = `{"steps": [{"name": "Build", "skill": "engineer", "position": 1}],
 "connectors": [{"from": "Build", "name": "done", "position": 1}]}`

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

// done says whether Task key has been filed and has ended Done.
func (f *fixture) done(key string) bool {
	f.t.Helper()
	var list client.TaskList
	f.json(&list, "ada", "tasks", "--project", "WEB", "--state", "done")
	return slices.ContainsFunc(list.Items, func(x client.Task) bool { return x.Key == key })
}

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

// logTime is when the runner's log first says one of msgs (prefixes) for agent.
func logTime(t *testing.T, log, agent string, msgs ...string) time.Time {
	t.Helper()
	for l := range strings.Lines(log) {
		if slices.ContainsFunc(msgs, func(msg string) bool { return strings.Contains(l, `msg="`+msg) }) && strings.Contains(l, " agent="+agent+" ") {
			at, _, _ := strings.Cut(strings.TrimPrefix(l, "time="), " ")
			ts, err := time.Parse(time.RFC3339Nano, at)
			if err != nil {
				t.Fatalf("the log's time %q: %v", at, err)
			}
			return ts
		}
	}
	t.Fatalf("the log never says %q for %s", msgs, agent)
	return time.Time{}
}

// A Parent from filing to its Owner's Complete: the planner breaks it down on web-3's branch from
// web-1, the Parent's; the builder commits on web-3's branch and advances it to Review; the
// reviewer advances it into Done and its branch merges into web-1; the Owner's Complete merges
// web-1 into main. Each session's log is Evidence on the Task it worked.
func TestRunnerWorksAParent(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.agent("planner", "advance", "breakdown")
		f.agent("builder", "advance", "engineer")
		f.agent("reviewer", "advance", "review")
		r := f.run("planner", "builder", "reviewer")
		f.ok("ada", "file", "--project", "WEB", "--title", "Checkout", "--breakdown")

		eventually(t, 30*time.Second, "WEB-3 done", func() bool { return f.done("WEB-3") })
		eventually(t, 10*time.Second, "the merge of WEB-3", func() bool {
			return strings.Contains(notesOf(f.task("WEB-3")), "Merged web-3-cart-page into web-1 at ")
		})
		eventually(t, 10*time.Second, "the sessions to end", func() bool { return len(r.Running()) == 0 })
		ctx := t.Context()
		if !branchExists(ctx, f.repo, "web-1") || !branchExists(ctx, f.repo, "web-3-cart-page") || !branchExists(ctx, f.repo, "web-2-break-down-checkout") {
			t.Fatal("no Parent's, Breakdown's or Subtask's branch")
		}
		if out := mustGit(t, f.repo, "show", "web-1:fakeagent-WEB-3.txt"); !strings.Contains(out, "WEB-3 worked by fakeagent") {
			t.Fatalf("web-1 has %q", out)
		}
		// The Breakdown's branch is never merged: only worked Tasks' are.
		if _, err := runGit(ctx, f.repo, "show", "web-1:fakeagent-WEB-2.txt"); err == nil {
			t.Fatal("the Breakdown's branch was merged")
		}

		web3 := f.task("WEB-3")
		// The reviewer, whose advance merged it, notes the merge.
		if !slices.ContainsFunc(web3.Notes, func(n client.Note) bool {
			return strings.HasPrefix(n.Body, "Merged web-3-cart-page into web-1 at ") && n.AuthorID == f.ids["reviewer"]
		}) {
			t.Errorf("no merge Note by the reviewer:\n%s", notesOf(web3))
		}
		if !slices.Contains(evidenceNames(web3.Evidence), "test-WEB-3.log") {
			t.Errorf("WEB-3's Evidence %v lacks its test log", evidenceNames(web3.Evidence))
		}
		// Two sessions worked WEB-3; each log is on the Task, the builder's attached once the
		// reviewer's Claim ended, named for its agent.
		eventually(t, 10*time.Second, "both session logs on WEB-3", func() bool {
			names := evidenceNames(f.task("WEB-3").Evidence)
			return sessionLogs(names, "WEB-3", "builder") == 1 && sessionLogs(names, "WEB-3", "reviewer") == 1
		})
		if notes := notesOf(web3); strings.Count(notes, "fakeagent: done") != 2 {
			t.Errorf("WEB-3's Notes:\n%s", notes)
		}
		if web3.Step != nil || len(web3.Claims) != 2 || *web3.Claims[0].ModelLabel != "fake-1" {
			t.Errorf("WEB-3: at %+v, Claims %+v", web3.Step, web3.Claims)
		}

		// The worktrees went with their Tasks.
		for _, task := range []string{"WEB-2", "WEB-3"} {
			eventually(t, 10*time.Second, task+"'s worktree to go", func() bool {
				_, err := os.Stat(TaskDir(f.data, task))
				return os.IsNotExist(err)
			})
		}

		// The Owner's Complete lands the Parent's branch on main, in the checkout the repository
		// has, and a Note on the Parent says so.
		f.ok("ada", "complete", "WEB-1")
		eventually(t, 10*time.Second, "the Parent's merge", func() bool {
			return strings.Contains(notesOf(f.task("WEB-1")), "Merged web-1 into main at ")
		})
		if b, err := os.ReadFile(filepath.Join(f.repo, "fakeagent-WEB-3.txt")); err != nil || !strings.Contains(string(b), "WEB-3") {
			t.Fatalf("main's checkout after the Complete: %q, %v", b, err)
		}
		if parents := strings.Fields(mustGit(t, f.repo, "rev-list", "--parents", "-n1", "main")); len(parents) != 3 {
			t.Fatalf("main's tip is not a merge: %v", parents)
		}
		if strings.Contains(mustGit(t, f.repo, "branch", "--list"), "feature/") {
			t.Fatal("a feature/ branch")
		}
	})
}

// A builder that completes its Task itself, where its Workflow lets it, has its branch merged into
// its Parent's all the same, and the Note says it was completed without review, by whom and
// under which Skill.
func TestRunnerMergesATaskCompletedWithoutReview(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.workflow(buildOnly)
		f.agent("builder", "complete", "engineer")
		f.ok("ada", "file", "--project", "WEB", "--title", "Checkout")
		f.ok("ada", "file", "--parent", "WEB-1", "--title", "Cart page")
		f.run("builder")

		eventually(t, 30*time.Second, "WEB-2's merge noted", func() bool { return strings.Contains(notesOf(f.task("WEB-2")), "Merged web-2-") })
		web2 := f.task("WEB-2")
		if !slices.ContainsFunc(web2.Notes, func(n client.Note) bool {
			return strings.HasPrefix(n.Body, "Merged web-2-cart-page into web-1 at ") &&
				strings.HasSuffix(n.Body, " (web); completed by builder under engineer, without review.") && n.AuthorID == f.ids["builder"]
		}) {
			t.Fatalf("WEB-2's Notes:\n%s", notesOf(web2))
		}
		if out := mustGit(t, f.repo, "show", "web-1:fakeagent-WEB-2.txt"); !strings.Contains(out, "WEB-2 worked by fakeagent") {
			t.Fatalf("web-1 has %q", out)
		}
	})
}

// reviewThenRelease is a Workflow whose review is not its last Step: Build, Review, then Release,
// whose holder advances the Task into Done.
const reviewThenRelease = `{"steps": [{"name": "Build", "skill": "engineer", "position": 1},
  {"name": "Review", "skill": "review", "position": 2}, {"name": "Release", "skill": "devops", "position": 3}],
 "connectors": [{"from": "Build", "to": "Review", "name": "built", "position": 1},
  {"from": "Review", "to": "Release", "name": "pass", "position": 1}, {"from": "Release", "name": "released", "position": 1}]}`

// A Task reviewed at an earlier Step and completed by a later one merges as reviewed work while
// nothing was committed after the review; a commit after it is named in the merge's Note.
func TestRunnerMergeNoteReadsAnEarlierReview(t *testing.T) {
	for _, tc := range []struct {
		name, devops, want string
	}{
		{"nothing committed after the review", "FAKEAGENT_NO_COMMIT=1", " (web)."},
		{"a commit after the review", "FAKEAGENT_DELAY=1100ms", " (web); completed by devops under devops, and its branch changed after reviewer's review."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, storetest.Open(t, store.SQLite))
			f.ok("ada", "skill", "create", "devops", "--kind", "generic", "--body", "Release it.")
			f.workflow(reviewThenRelease)
			f.agent("builder", "advance", "engineer")
			f.agent("reviewer", "advance", "review")
			f.setScenario("reviewer", "advance", "FAKEAGENT_OUTCOME=pass", "FAKEAGENT_NO_COMMIT=1", "FAKEAGENT_DELAY=1100ms")
			f.agent("devops", "advance", "devops")
			f.setScenario("devops", "advance", tc.devops)
			f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
			f.run("builder", "reviewer", "devops")

			eventually(t, 60*time.Second, "WEB-1's merge noted", func() bool { return strings.Contains(notesOf(f.task("WEB-1")), "Merged web-1-") })
			web1 := f.task("WEB-1")
			if !slices.ContainsFunc(web1.Notes, func(n client.Note) bool {
				return strings.HasPrefix(n.Body, "Merged web-1-cart-page into main at ") && strings.HasSuffix(n.Body, tc.want)
			}) {
				t.Fatalf("WEB-1's Notes, wanting one ending %q:\n%s", tc.want, notesOf(web1))
			}
		})
	}
}

// A Task with no Parent works on a branch from main, and its advance into Done merges it into
// main; no Parent's branch is made.
func TestRunnerMergesATaskStandingAlone(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "advance", "engineer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Fix the typo")
	f.run("builder")

	eventually(t, 30*time.Second, "WEB-1's merge noted", func() bool {
		return strings.Contains(notesOf(f.task("WEB-1")), "Merged web-1-fix-the-typo into main at ")
	})
	if b, err := os.ReadFile(filepath.Join(f.repo, "fakeagent-WEB-1.txt")); err != nil || !strings.Contains(string(b), "WEB-1") {
		t.Fatalf("main's checkout: %q, %v", b, err)
	}
	if branchExists(t.Context(), f.repo, "web-1") {
		t.Fatal("a Task standing alone got a Parent's branch")
	}
}

// After an advance the reviewer's session starts as soon as the builder's has ended, not a
// progress check later, though the reviewer's runner claimed the Task while the builder's still
// ran.
func TestRunnerStartsTheNextSessionOnceTheEarlierEnds(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.timings.Tick, f.timings.Stale, f.timings.ClaimTimeout = 5*time.Second, 20*time.Second, 30*time.Second
	f.agent("builder", "advance", "engineer")
	f.agent("reviewer", "advance", "review")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	r := f.run("builder", "reviewer")

	eventually(t, 30*time.Second, "WEB-1 done", func() bool { return f.task("WEB-1").Task.State == client.TaskStateDone })
	eventually(t, 10*time.Second, "the sessions to end", func() bool { return len(r.Running()) == 0 })
	log := f.log.String()
	ended := logTime(t, log, "builder", "attached the session's log", "the Task is held by its next holder")
	started := logTime(t, log, "reviewer", "started the session")
	if gap := started.Sub(ended); gap < 0 || gap > 2*time.Second {
		t.Fatalf("the reviewer's session started %s after the builder's ended", gap)
	}
	// The builder's log waited for the reviewer's Claim to end, and is on the Task.
	if !strings.Contains(log, `msg="the Task is held by its next holder; the session's log is attached once it is free" component=runner agent=builder task=WEB-1`) {
		t.Fatalf("the builder's log was not kept for later:\n%s", log)
	}
	eventually(t, 10*time.Second, "the builder's log on WEB-1", func() bool {
		return sessionLogs(evidenceNames(f.task("WEB-1").Evidence), "WEB-1", "builder") == 1
	})
}

// A session log kept for later survives the runner stopping: the next runner attaches it, as the
// agent whose session it was, once the Task is free.
func TestRunnerAttachesALogKeptBeforeItStarted(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.agent("builder", "silent", "engineer")
	f.ok("ada", "agent", "set", "builder", "--paused")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	dir := filepath.Join(f.data, "sessions", "WEB-1", keptDir)
	name := "session-WEB-1-builder-010203.log"
	writeTestFile(t, filepath.Join(dir, name), "fakeagent: working WEB-1\n")
	b, _ := json.Marshal(keptLog{Task: "WEB-1", Agent: f.ids["builder"], Name: name, At: time.Now()})
	writeTestFile(t, filepath.Join(dir, name+".json"), string(b))
	f.run("builder")

	eventually(t, 10*time.Second, "the kept log on WEB-1", func() bool {
		d := f.task("WEB-1")
		return len(d.Evidence) == 1 && d.Evidence[0].Filename == name && d.Evidence[0].AttachedBy == f.ids["builder"]
	})
	eventually(t, 5*time.Second, "the kept log's files gone", func() bool {
		_, err := os.Stat(dir)
		return os.IsNotExist(err)
	})
}

// A session says what it is doing: running while its progress moves, waiting once its turn ended
// without a decision, stalled once its progress went stale and Heartbeats stopped; and since
// when: its start until its state first changes, then the moment of each change.
func TestRunnerSessionStates(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.agent("stuck", "hang", "engineer")
	f.agent("quiet", "silent", "engineer")
	f.ok("ada", "file", "--project", "WEB", "--aim", "stuck", "--title", "Hang")
	f.ok("ada", "file", "--project", "WEB", "--aim", "quiet", "--title", "Say nothing")
	r := f.run("stuck", "quiet")

	seen := map[string][]string{}
	since := map[string]time.Time{}
	eventually(t, 20*time.Second, "WEB-1 stalled and WEB-2 waiting", func() bool {
		for _, s := range r.Running() {
			l := seen[s.Task]
			switch {
			case len(l) == 0 && s.State == StateRunning && !s.StateSince.Equal(s.StartedAt):
				t.Fatalf("%s running since %v, started %v", s.Task, s.StateSince, s.StartedAt)
			case len(l) > 0 && l[len(l)-1] == s.State && !s.StateSince.Equal(since[s.Task]):
				t.Fatalf("%s still %s, since %v then %v", s.Task, s.State, since[s.Task], s.StateSince)
			case len(l) > 0 && l[len(l)-1] != s.State && !s.StateSince.After(since[s.Task]):
				t.Fatalf("%s became %s since %v, not after %v", s.Task, s.State, s.StateSince, since[s.Task])
			}
			since[s.Task] = s.StateSince
			if len(l) == 0 || l[len(l)-1] != s.State {
				seen[s.Task] = append(l, s.State)
			}
		}
		return slices.Contains(seen["WEB-1"], StateStalled) && slices.Contains(seen["WEB-2"], StateWaiting)
	})
	if l := seen["WEB-1"]; l[0] != StateRunning || slices.Index(l, StateStalled) < slices.Index(l, StateRunning) {
		t.Fatalf("WEB-1's states: %v", l)
	}
}

// An agent that stops without a decision is nudged twice and released with a Note; the third
// release files a question that blocks the Task, aimed at the agent's manager on its Reporting
// line (mai, not the Task's Owner), filed as a Subtask of the Task's Parent; an agent with no
// manager asks the Task's Owner, and about a Task with no Parent the question stands alone.
func TestRunnerReleasesASilentSession(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		var mai client.Member
		f.json(&mai, "ada", "member", "create", "mai", "--kind", "human")
		f.ok("ada", "project", "add", "WEB", "mai")
		f.agent("builder", "silent", "engineer")
		f.ok("ada", "report-to", "builder", "mai")
		f.ok("ada", "file", "--project", "WEB", "--title", "Checkout")
		f.ok("ada", "file", "--parent", "WEB-1", "--title", "Cart page", "--aim", "builder")
		f.agent("loner", "silent", "engineer")
		f.ok("ada", "report-to", "loner", "--none")
		f.ok("ada", "file", "--project", "WEB", "--title", "Fix the typo", "--aim", "loner")
		f.run("builder", "loner")

		for _, c := range []struct{ task, agent, aim, parent string }{{"WEB-2", "builder", mai.ID, "WEB-1"}, {"WEB-3", "loner", f.ids["ada"], ""}} {
			eventually(t, 30*time.Second, "a question blocking "+c.task+", released", func() bool {
				d := f.task(c.task)
				return d.Task.Blocked && d.Task.Claim == nil
			})
			d := f.task(c.task)
			var released []string
			for _, n := range d.Notes {
				if strings.HasPrefix(n.Body, silentPrefix) {
					released = append(released, n.Body)
				}
			}
			if len(released) != 3 || !strings.Contains(released[0], "after 2 nudges") || !strings.Contains(released[0], "last 20 lines:") ||
				!strings.Contains(released[0], "fakeagent: read \"You stopped without ending the Task: advance it, complete it, or file a question.") {
				t.Fatalf("%s's release Notes: %q", c.task, released)
			}
			q := f.task((*d.Task.OpenBlockers)[0].Key)
			if q.Task.Title != "The runner released "+c.task+" three times without a decision" || q.Task.AimedAtID == nil || *q.Task.AimedAtID != c.aim {
				t.Fatalf("%s's question: %+v", c.task, q.Task)
			}
			if got := ptrValue(q.Task.ParentID); (c.parent == "") != (got == "") || c.parent != "" && got != f.task(c.parent).Task.ID {
				t.Fatalf("%s's question is under %q, want %q", c.task, got, c.parent)
			}
			// Each of the three sessions was nudged twice before its release, each nudge recorded
			// with no actor, naming the agent.
			var page client.ActivityPage
			f.json(&page, "ada", "activity", "--kind", "task.nudged", "--task", c.task, "--limit", "100")
			var nudges []float64
			for _, a := range page.Items {
				if a.ActorID != nil || a.Payload["holder_id"] != f.ids[c.agent] || a.Payload["claim_id"] == nil {
					t.Fatalf("%s's nudge %+v", c.task, a)
				}
				nudges = append(nudges, a.Payload["nudge"].(float64))
			}
			if !slices.Equal(nudges, []float64{1, 2, 1, 2, 1, 2}) {
				t.Fatalf("%s's nudges: %v", c.task, nudges)
			}
			// Each session's log went with its release.
			eventually(t, 10*time.Second, "three session logs", func() bool {
				return sessionLogs(evidenceNames(f.task(c.task).Evidence), c.task, c.agent) == 3
			})
		}
	})
}

// Progress survives a long tool call (the plan: MAIN-1's builders sat silent in one ten-minute
// make verify while their Claims lapsed). With the clocks shrunk — stale after 1 s, Claims time out
// after 4 s, so a session silent for 5 s lapses — a call of 6 s that writes nothing keeps its
// Claim: the sleep it runs is a process of the session's started after its last record, or, run
// in the agent itself, the call is in flight in its transcript, which counts for up to the Claim's
// timeout. Either way the runner's log says why it kept the Heartbeats.
func TestRunnerKeepsALongToolCallAlive(t *testing.T) {
	for _, in := range []string{"process", "agent"} {
		t.Run(in, func(t *testing.T) {
			f := newFixture(t, storetest.Open(t, store.SQLite))
			f.timings.Tick, f.timings.Stale, f.timings.ClaimTimeout = 200*time.Millisecond, time.Second, 4*time.Second
			f.workflow(buildOnly)
			f.agent("builder", "longcall", "engineer")
			f.setScenario("builder", "longcall", "FAKEAGENT_CALL=6s", "FAKEAGENT_CALL_IN="+in)
			f.ok("ada", "file", "--project", "WEB", "--title", "Verify")
			f.run("builder")

			eventually(t, 30*time.Second, "WEB-1 done", func() bool { return f.task("WEB-1").Task.State == client.TaskStateDone })
			d := f.task("WEB-1")
			if len(d.Claims) != 1 || d.Claims[0].HowEnded == nil || *d.Claims[0].HowEnded != client.ClaimEndCompleted {
				t.Fatalf("WEB-1's Claims: %+v", d.Claims)
			}
			want := map[string]string{"process": "a process it started is running (sleep, pid ", "agent": "a tool call is in flight"}[in]
			if log := f.log.String(); !strings.Contains(log, "the session's progress is quiet, but "+want) || strings.Contains(log, "went stale") {
				t.Fatalf("the runner's log does not say why the long call kept its Claim:\n%s", log)
			}
		})
	}
}

// A call in flight that runs past the Claim's timeout with no process of it running counts no
// longer: the Heartbeats stop, the log says so, and the Claim lapses on Darkory's rule.
func TestRunnerLetsAHungToolCallLapse(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.timings.Tick, f.timings.Stale, f.timings.ClaimTimeout = 200*time.Millisecond, time.Second, 2*time.Second
	f.workflow(buildOnly)
	f.agent("builder", "longcall", "engineer")
	f.setScenario("builder", "longcall", "FAKEAGENT_CALL=1h", "FAKEAGENT_CALL_IN=agent")
	f.ok("ada", "file", "--project", "WEB", "--title", "Hang in a call")
	r := f.run("builder")

	eventually(t, 30*time.Second, "WEB-1's Claim to lapse", func() bool {
		d := f.task("WEB-1")
		return len(d.Claims) > 0 && d.Claims[0].HowEnded != nil && *d.Claims[0].HowEnded == client.ClaimEndLapsed
	})
	if log := f.log.String(); !strings.Contains(log, "the session's tool call has run for the Claim's timeout with no process of it running") {
		t.Fatalf("the runner's log:\n%s", log)
	}
	f.ok("ada", "agent", "set", "builder", "--paused")
	eventually(t, 20*time.Second, "the session to end", func() bool { return len(r.Running()) == 0 })
}

// In tmux: the session runs as dk-<TASK> on the runner's own tmux server, where a person could
// join it, and is gone once the Claim ends; its pane's log is the Evidence.
func TestRunnerInTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.workflow(buildOnly)
	f.agent("builder", "complete", "engineer")
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	var seen RunnerSession
	eventually(t, 20*time.Second, "a tmux session", func() bool {
		for _, s := range r.Running() {
			if s.Task == "WEB-1" && s.Tmux {
				seen = s
				return exec.Command("tmux", "-L", r.Socket(), "has-session", "-t", "=dk-WEB-1").Run() == nil
			}
		}
		return false
	})
	if seen.TmuxSession != "dk-WEB-1" || seen.TmuxSocket != TmuxSocket(f.data) || seen.Member != "builder" {
		t.Fatalf("the session: %+v", seen)
	}
	eventually(t, 20*time.Second, "WEB-1 done and its session gone", func() bool {
		return f.task("WEB-1").Task.State == client.TaskStateDone && len(r.Running()) == 0
	})
	if exec.Command("tmux", "-L", r.Socket(), "has-session", "-t", "=dk-WEB-1").Run() == nil {
		t.Fatal("the tmux session outlived its Claim")
	}
	var log *client.Evidence
	for _, e := range f.task("WEB-1").Evidence {
		if sessionLogs([]string{e.Filename}, "WEB-1", "builder") == 1 {
			log = &e
		}
	}
	if log == nil {
		t.Fatal("no session log")
	}
	var out bytes.Buffer
	env := cli.Env{Stdout: &out, Stderr: &out, Getenv: func(k string) string {
		return map[string]string{"DARKORY_URL": f.ts.URL, "DARKORY_TOKEN": f.tokens["ada"], "DARKORY_SESSION": "ada-cli"}[k]
	}}
	if err := cli.Run(t.Context(), []string{"evidence", "get", log.ID, "-o", "-"}, env); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "fakeagent: working WEB-1") || !strings.Contains(out.String(), "/exit") {
		t.Fatalf("the pane's log:\n%s", out.String())
	}
	// The Evidence is the pane as the agent's terminal had it, nothing added or taken out.
	if b, err := os.ReadFile(filepath.Join(f.data, "sessions", "WEB-1", "pane.log")); err != nil || out.String() != string(b) {
		t.Fatalf("the Evidence differs from pane.log (%v):\n%q\n%q", err, out.String(), b)
	}
}

// The terminal: an admin joining through /v1/runner/sessions/{task}/terminal sees the session's
// screen, types into it, resizes it, and is recorded in a Note; a Member who is not an admin only
// watches.
func TestRunnerTerminal(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	// The silent agent waits at its prompt, Heartbeats going, for the test.
	f.timings.Nudge, f.timings.Stale = time.Minute, time.Minute
	f.agent("builder", "silent", "engineer")
	f.ok("ada", "member", "create", "mai", "--kind", "human")
	var tok client.IssuedToken
	f.json(&tok, "ada", "token", "issue", "mai", "--name", "mai")
	f.tokens["mai"] = tok.Secret
	f.ok("ada", "file", "--project", "WEB", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })
	eventually(t, 20*time.Second, "the session waiting at its prompt", func() bool {
		for _, s := range r.Running() {
			if s.Task == "WEB-1" && s.State == StateWaiting {
				return true
			}
		}
		return false
	})

	dial := func(member, query string) *websocket.Conn {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		h := http.Header{}
		h.Set("Authorization", "Bearer "+f.tokens[member])
		h.Set("Darkory-Session", member+"-terminal")
		url := strings.Replace(f.ts.URL, "http://", "ws://", 1) + "/v1/runner/sessions/WEB-1/terminal" + query
		c, res, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
		if err != nil {
			t.Fatalf("dialling the terminal as %s: %v (%v)", member, err, res)
		}
		return c
	}
	// screen reads what the terminal shows until it holds want.
	screen := func(c *websocket.Conn, want string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		var seen strings.Builder
		for !strings.Contains(seen.String(), want) {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q: %v; the terminal showed:\n%s", want, err, tail(seen.String(), 30))
			}
			seen.Write(b)
		}
		return seen.String()
	}

	admin := dial("ada", "")
	defer admin.CloseNow()
	if err := admin.Write(t.Context(), websocket.MessageText, []byte(`{"cols":100,"rows":30}`)); err != nil {
		t.Fatal(err)
	}
	screen(admin, "You stopped without ending the Task")
	if err := admin.Write(t.Context(), websocket.MessageBinary, []byte("typed by ada\r")); err != nil {
		t.Fatal(err)
	}
	screen(admin, `fakeagent: read "typed by ada"`)
	eventually(t, 5*time.Second, "a Note that ada joined", func() bool {
		return slices.ContainsFunc(f.task("WEB-1").Notes, func(n client.Note) bool { return n.Body == "ada joined the session." })
	})

	// mai is no admin: she only watches, even when she asks to type (the server decides), so her
	// keys never reach the session; ada asking to watch types nothing either. Watching is noted for
	// no one, and a watcher's size changes nothing.
	var watchers []*websocket.Conn
	for _, w := range []struct{ member, query, keys string }{
		{"mai", "", "typed by mai"}, {"mai", "?readonly=0", "mai asking to type"}, {"mai", "?readonly=false", "mai asking again"},
		{"ada", "?readonly=1", "ada only watching"},
	} {
		c := dial(w.member, w.query)
		defer c.CloseNow()
		watchers = append(watchers, c)
		if err := c.Write(t.Context(), websocket.MessageText, []byte(`{"cols":40,"rows":10}`)); err != nil {
			t.Fatal(err)
		}
		if err := c.Write(t.Context(), websocket.MessageBinary, []byte(w.keys+"\r")); err != nil {
			t.Fatal(err)
		}
	}
	if err := admin.Write(t.Context(), websocket.MessageBinary, []byte("typed by ada again\r")); err != nil {
		t.Fatal(err)
	}
	for _, c := range watchers {
		out := screen(c, `fakeagent: read "typed by ada again"`)
		for _, keys := range []string{"typed by mai", "mai asking to type", "mai asking again", "ada only watching"} {
			if strings.Contains(out, `fakeagent: read "`+keys) {
				t.Fatalf("a watcher's keys reached the session (%q):\n%s", keys, out)
			}
		}
	}
	joined := 0
	for _, n := range f.task("WEB-1").Notes {
		if strings.HasPrefix(n.Body, "mai") || n.Body == "ada joined the session." {
			joined++
		}
	}
	if joined != 1 {
		t.Fatalf("%d Notes of joining; only ada's read-write join is one", joined)
	}
	// The window is as wide as ada's 100 columns, whatever the watchers' 40.
	if width, err := exec.Command("tmux", "-L", r.Socket(), "display-message", "-p", "-t", "=dk-WEB-1:", "#{window_width}").Output(); err != nil ||
		strings.TrimSpace(string(width)) != "100" {
		t.Fatalf("the agent's window is %q columns wide (%v); a watcher's 40 must not shrink it", width, err)
	}
	admin.Close(websocket.StatusNormalClosure, "")
	for _, c := range watchers {
		c.Close(websocket.StatusNormalClosure, "")
	}
}

// conflictWorkflow puts Write before Build, so the Project's first work Step is not where its
// builder works: Write (docs) · Build (engineer) → Review (review), with "needs changes" back.
const conflictWorkflow = `{"steps": [{"name": "Write", "skill": "docs", "position": 1}, {"name": "Build", "skill": "engineer", "position": 2},
  {"name": "Review", "skill": "review", "position": 3}],
 "connectors": [{"from": "Write", "name": "done", "position": 1}, {"from": "Build", "to": "Review", "name": "pass", "position": 1},
  {"from": "Review", "name": "pass", "position": 1}, {"from": "Review", "to": "Build", "name": "needs changes", "position": 2}]}`

// Two Subtasks of one Parent change the same file on branches made before either merged. The
// second review's merge conflicts and changes nothing; a done Task stays done, so the Note on it
// says so and a Task resolving it is filed at the Step it was built at, Build, not the Project's
// first work Step: under the Parent while it is open, its branch merging into the Parent's;
// standing alone from main when the conflicting Subtask's end completed the Parent, whose own
// merge into main went without that work, as its Note says.
func TestRunnerMergeConflict(t *testing.T) {
	for _, auto := range []bool{false, true} {
		t.Run(map[bool]string{false: "open Parent", true: "Parent auto-completed"}[auto], func(t *testing.T) {
			f := newFixture(t, storetest.Open(t, store.SQLite))
			f.ok("ada", "skill", "create", "docs", "--kind", "generic", "--body", "Write it down.")
			f.workflow(conflictWorkflow)
			f.agent("builder", "advance", "engineer")
			f.setScenario("builder", "advance", "FAKEAGENT_FILE=shared.txt")
			f.agent("reviewer", "advance", "review")
			f.ok("ada", "agent", "set", "reviewer", "--paused")
			f.ok("ada", "file", "--project", "WEB", "--title", "Checkout", fmt.Sprintf("--auto-complete=%v", auto))
			f.ok("ada", "file", "--parent", "WEB-1", "--title", "Part A", "--step", "Build")
			f.ok("ada", "file", "--parent", "WEB-1", "--title", "Part B", "--step", "Build")
			f.run("builder", "reviewer")
			// Both branches are made from web-1 before either is merged.
			eventually(t, 30*time.Second, "both at Review", func() bool {
				for _, k := range []string{"WEB-2", "WEB-3"} {
					if d := f.task(k); d.Step == nil || d.Step.Name != "Review" || d.Task.Claim != nil {
						return false
					}
				}
				return true
			})
			f.ok("ada", "agent", "set", "builder", "--paused")
			f.ok("ada", "agent", "set", "reviewer", "--paused=false")
			var resolve client.Task
			eventually(t, 30*time.Second, "a Task resolving the merge", func() bool {
				var list client.TaskList
				f.json(&list, "ada", "tasks", "--project", "WEB")
				for _, x := range list.Items {
					if strings.Contains(x.Title, "esolve the merge of web-") {
						resolve = x
						return true
					}
				}
				return false
			})
			conflicted := strings.Fields(resolve.Title)[len(strings.Fields(resolve.Title))-3] // … the merge of <branch> into web-1
			key := KeyOf(conflicted)
			r := f.task(resolve.Key)
			if len(r.Workspaces) != 1 || r.Workspaces[0].Name != "web" {
				t.Fatalf("the resolving Task names the Workspaces %+v, not the one the merge did not go into", r.Workspaces)
			}
			if r.Step == nil || r.Step.Name != "Build" || !strings.Contains(resolve.Description, "shared.txt") || !strings.Contains(resolve.Description, "CONFLICT") {
				t.Fatalf("the resolving Task, at %+v: %q\n%s", r.Step, resolve.Title, resolve.Description)
			}
			eventually(t, 10*time.Second, key+"'s conflict noted", func() bool {
				return strings.Contains(notesOf(f.task(key)), "web: merging "+conflicted+" into web-1 conflicted, so nothing was merged. Filed "+
					resolve.Key+" at Build, where it was built, to resolve it.")
			})
			if isAncestor(t.Context(), f.repo, conflicted, "web-1") {
				t.Fatalf("%s went into web-1 despite the conflict", conflicted)
			}
			if f.task(key).Task.State != client.TaskStateDone {
				t.Fatalf("%s did not stay done", key)
			}
			if !auto {
				if ptrValue(resolve.ParentID) != f.task("WEB-1").Task.ID || resolve.Title != "Resolve the merge of "+conflicted+" into web-1" {
					t.Fatalf("the resolving Task is not a Subtask of the open Parent: %+v", resolve)
				}
				// The Parent cannot be completed while it is open; dropped, the Owner completes the
				// Parent, whose branch lands without the work, and its Note says so.
				f.ok("ada", "drop", resolve.Key, "--reason", "resolved by hand later")
				f.ok("ada", "complete", "WEB-1")
			} else if resolve.ParentID != nil || resolve.Title != "Resolve the merge of "+conflicted+" into main" ||
				!strings.Contains(resolve.Description, "this Task stands alone, on a branch from main. Merge "+conflicted) {
				t.Fatalf("the resolving Task of an ended Parent: %+v\n%s", resolve, resolve.Description)
			}
			eventually(t, 10*time.Second, "the Parent's Note", func() bool {
				n := notesOf(f.task("WEB-1"))
				return strings.Contains(n, "Merged web-1 into main at ") && strings.Contains(n, "It went without the work of "+key+", whose merge into web-1 conflicted")
			})
			if isAncestor(t.Context(), f.repo, conflicted, "main") {
				t.Fatalf("%s's work reached main despite the conflict", conflicted)
			}
		})
	}
}
