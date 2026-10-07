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

// fixture is an Install with a git repository as Team WEB's default Workspace, ada as its human
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
	f.ok("ada", "team", "create", "WEB", "Web")
	f.ok("ada", "team", "add", "WEB", "ada")
	f.ok("ada", "skill", "create", "build", "--kind", "generic", "--body", "Build it, with tests.")
	f.ok("ada", "skill", "create", "review", "--kind", "generic", "--body", "Review it.")
	f.ok("ada", "workspace", "add", "web", "--path", f.repo)
	f.ok("ada", "team", "set", "WEB", "--default-workspace", "web")
	return f
}

// agent makes an agent Member in WEB with skills, reporting to ada, whose command is the fake
// agent in scenario.
func (f *fixture) agent(name, scenario string, skills ...string) {
	f.t.Helper()
	var m client.Member
	f.json(&m, "ada", "member", "create", name, "--kind", "agent")
	f.ok("ada", "team", "add", "WEB", name)
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

func (f *fixture) feature(key string) client.FeatureDetail {
	f.t.Helper()
	var d client.FeatureDetail
	f.json(&d, "ada", "feature", "show", key)
	return d
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

// A Feature from filing to Ship: the planner breaks it down on feature/WEB-1, the builder commits
// on WEB-3's branch and hands over, the reviewer completes and the branch is merged into the
// Feature's, and Ship merges that into main. Each session's log is Evidence.
func TestRunnerWorksAFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.agent("planner", "complete", "breakdown")
		f.agent("builder", "handover", "build")
		f.agent("reviewer", "complete", "review")
		r := f.run("planner", "builder", "reviewer")
		f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")

		eventually(t, 30*time.Second, "WEB-3 done", func() bool {
			var list client.TaskList
			f.json(&list, "ada", "tasks", "--feature", "WEB-1")
			return slices.ContainsFunc(list.Items, func(x client.Task) bool { return x.Key == "WEB-3" && x.State == client.TaskStateDone })
		})
		eventually(t, 10*time.Second, "the merge of WEB-3", func() bool {
			return strings.Contains(notesOf(f.task("WEB-3")), "Merged WEB-3/cart-page into feature/WEB-1 at ")
		})
		eventually(t, 10*time.Second, "the sessions to end", func() bool { return len(r.Running()) == 0 })
		ctx := t.Context()
		if !branchExists(ctx, f.repo, "feature/WEB-1") || !branchExists(ctx, f.repo, "WEB-3/cart-page") {
			t.Fatal("no feature or Task branch")
		}
		if out := mustGit(t, f.repo, "show", "feature/WEB-1:fakeagent-WEB-3.txt"); !strings.Contains(out, "WEB-3 worked by fakeagent") {
			t.Fatalf("feature/WEB-1 has %q", out)
		}
		// The Break down's branch is never merged: only a review merges.
		if _, err := runGit(ctx, f.repo, "show", "feature/WEB-1:fakeagent-WEB-2.txt"); err == nil {
			t.Fatal("the Break down's branch was merged")
		}

		web3 := f.task("WEB-3")
		// The reviewer, whose Complete merged it, notes the merge.
		if !slices.ContainsFunc(web3.Notes, func(n client.Note) bool {
			return strings.HasPrefix(n.Body, "Merged WEB-3/cart-page into feature/WEB-1 at ") && n.AuthorID == f.ids["reviewer"]
		}) {
			t.Errorf("no merge Note by the reviewer:\n%s", notesOf(web3))
		}
		names := evidenceNames(web3.Evidence)
		feature := f.feature("WEB-1")
		fnames := evidenceNames(feature.Evidence)
		for _, want := range []string{"test-WEB-3.log"} {
			if !slices.Contains(names, want) {
				t.Errorf("WEB-3's Evidence %v lacks %s", names, want)
			}
		}
		// Two sessions worked WEB-3; each log is on the Task, or on the Feature when the reviewer
		// held the Task by then.
		if n := strings.Count(strings.Join(append(names, fnames...), " "), "session-WEB-3.log"); n != 2 {
			t.Errorf("session-WEB-3.log is attached %d times (Task %v, Feature %v)", n, names, fnames)
		}
		notes := ""
		for _, n := range web3.Notes {
			notes += n.Body + "\n"
		}
		if !strings.Contains(notes, "fakeagent: built; please review") || !strings.Contains(notes, "fakeagent: done") {
			t.Errorf("WEB-3's Notes:\n%s", notes)
		}
		if web3.Status.Name != "Done" || len(web3.Claims) != 2 || *web3.Claims[0].ModelLabel != "fake-1" {
			t.Errorf("WEB-3: %s, Claims %+v", web3.Status.Name, web3.Claims)
		}

		// The worktrees went with their Tasks.
		for _, task := range []string{"WEB-2", "WEB-3"} {
			eventually(t, 10*time.Second, task+"'s worktree to go", func() bool {
				_, err := os.Stat(TaskDir(f.data, task))
				return os.IsNotExist(err)
			})
		}

		// Ship lands the Feature's branch on main, in the checkout the repository has.
		f.ok("ada", "feature", "ship", "WEB-1")
		eventually(t, 10*time.Second, "the Ship's merge", func() bool {
			return slices.Contains(evidenceNames(f.feature("WEB-1").Evidence), "merge-WEB-1.txt")
		})
		if b, err := os.ReadFile(filepath.Join(f.repo, "fakeagent-WEB-3.txt")); err != nil || !strings.Contains(string(b), "WEB-3") {
			t.Fatalf("main's checkout after Ship: %q, %v", b, err)
		}
		if parents := strings.Fields(mustGit(t, f.repo, "rev-list", "--parents", "-n1", "main")); len(parents) != 3 {
			t.Fatalf("main's tip is not a merge: %v", parents)
		}
	})
}

// An agent that stops without a decision is nudged twice and released with a Note; the third
// release files a question to the Feature owner that blocks the Task.
func TestRunnerReleasesASilentSession(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.agent("builder", "silent", "build")
		f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
		f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
		f.run("builder")

		eventually(t, 30*time.Second, "a question blocking WEB-3, released", func() bool {
			d := f.task("WEB-3")
			return d.Task.Blocked && d.Task.Claim == nil
		})
		d := f.task("WEB-3")
		var released []string
		for _, n := range d.Notes {
			if strings.HasPrefix(n.Body, silentPrefix) {
				released = append(released, n.Body)
			}
		}
		if len(released) != 3 || !strings.Contains(released[0], "after 2 nudges") || !strings.Contains(released[0], "last 20 lines:") ||
			!strings.Contains(released[0], "fakeagent: read \"You stopped without ending the Task") {
			t.Fatalf("the release Notes: %q", released)
		}
		blockers := *d.Task.OpenBlockers
		q := f.task(blockers[0].Key)
		if q.Task.Title != "The runner released WEB-3 three times without a decision" || q.Task.AimedAtID == nil || *q.Task.AimedAtID != f.ids["ada"] {
			t.Fatalf("the question: %+v", q.Task)
		}
		if d.Task.Claim != nil || d.Status.Name != "Todo" {
			t.Fatalf("WEB-3 after the question: %s, Claim %+v", d.Status.Name, d.Task.Claim)
		}
		// Each session's log went with its release.
		eventually(t, 10*time.Second, "three session logs", func() bool {
			return strings.Count(strings.Join(evidenceNames(f.task("WEB-3").Evidence), " "), "session-WEB-3.log") == 3
		})
	})
}

// In tmux: the session runs as dk-<TASK> on the runner's own tmux server, where a person could
// join it, and is gone once the Claim ends; its pane's log is the Evidence.
func TestRunnerInTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	f := newFixture(t, storetest.Open(t, store.SQLite))
	f.agent("builder", "complete", "build")
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })

	var seen RunnerSession
	eventually(t, 20*time.Second, "a tmux session", func() bool {
		for _, s := range r.Running() {
			if s.Task == "WEB-3" && s.Tmux {
				seen = s
				return exec.Command("tmux", "-L", r.Socket(), "has-session", "-t", "=dk-WEB-3").Run() == nil
			}
		}
		return false
	})
	if seen.TmuxSession != "dk-WEB-3" || seen.TmuxSocket != TmuxSocket(f.data) || seen.Member != "builder" {
		t.Fatalf("the session: %+v", seen)
	}
	eventually(t, 20*time.Second, "WEB-3 done and its session gone", func() bool {
		return f.task("WEB-3").Task.State == client.TaskStateDone && len(r.Running()) == 0
	})
	if exec.Command("tmux", "-L", r.Socket(), "has-session", "-t", "=dk-WEB-3").Run() == nil {
		t.Fatal("the tmux session outlived its Claim")
	}
	var log *client.Evidence
	for _, e := range f.task("WEB-3").Evidence {
		if e.Filename == "session-WEB-3.log" {
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
	if !strings.Contains(out.String(), "fakeagent: working WEB-3") || !strings.Contains(out.String(), "/exit") {
		t.Fatalf("the pane's log:\n%s", out.String())
	}
	// The Evidence is the pane as the agent's terminal had it, nothing added or taken out.
	if b, err := os.ReadFile(filepath.Join(f.data, "sessions", "WEB-3", "pane.log")); err != nil || out.String() != string(b) {
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
	f.agent("builder", "silent", "build")
	f.ok("ada", "member", "create", "mai", "--kind", "human")
	var tok client.IssuedToken
	f.json(&tok, "ada", "token", "issue", "mai", "--name", "mai")
	f.tokens["mai"] = tok.Secret
	f.ok("ada", "feature", "create", "--team", "WEB", "--title", "Checkout")
	f.ok("ada", "file", "--feature", "WEB-1", "--skill", "build", "--title", "Cart page")
	r := f.runWith("on", "builder")
	t.Cleanup(func() { killTmux(r.Socket()) })
	eventually(t, 20*time.Second, "the session waiting at its prompt", func() bool {
		for _, s := range r.Running() {
			if s.Task == "WEB-3" && s.State == StateNudged {
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
		url := strings.Replace(f.ts.URL, "http://", "ws://", 1) + "/v1/runner/sessions/WEB-3/terminal" + query
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
		return slices.ContainsFunc(f.task("WEB-3").Notes, func(n client.Note) bool { return n.Body == "ada joined the session." })
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
	for _, n := range f.task("WEB-3").Notes {
		if strings.HasPrefix(n.Body, "mai") || n.Body == "ada joined the session." {
			joined++
		}
	}
	if joined != 1 {
		t.Fatalf("%d Notes of joining; only ada's read-write join is one", joined)
	}
	// The window is as wide as ada's 100 columns, whatever the watchers' 40.
	if width, err := exec.Command("tmux", "-L", r.Socket(), "display-message", "-p", "-t", "=dk-WEB-3:", "#{window_width}").Output(); err != nil ||
		strings.TrimSpace(string(width)) != "100" {
		t.Fatalf("the agent's window is %q columns wide (%v); a watcher's 40 must not shrink it", width, err)
	}
	admin.Close(websocket.StatusNormalClosure, "")
	for _, c := range watchers {
		c.Close(websocket.StatusNormalClosure, "")
	}
}
