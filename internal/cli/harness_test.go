package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
)

// TestMain lets the test binary stand in for darkory, so `heartbeat run --background` can start
// it as its detached copy.
func TestMain(m *testing.M) {
	if os.Getenv("DARKORY_CLI_TEST_AS_DARKORY") == "1" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		err := Run(ctx, os.Args[1:], OSEnv())
		stop()
		if ex, ok := err.(*ExitError); ok {
			os.Exit(ex.Code)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// install is an initialised Install behind an httptest server; ada is its first Member, a human
// admin.
type install struct {
	t      *testing.T
	srv    *server.Server
	ts     *httptest.Server
	ada    string // ada's token
	tokens map[string]string
}

func newInstall(t *testing.T, st *store.Store) *install {
	t.Helper()
	return newInstallWith(t, st, server.Options{})
}

// newInstallWith is newInstall with server options; a disk Evidence store and a short keep-alive
// are filled in.
func newInstallWith(t *testing.T, st *store.Store, o server.Options) *install {
	t.Helper()
	if o.Blobs == nil {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		o.Blobs = disk
	}
	if o.KeepAlive == 0 {
		o.KeepAlive = 100 * time.Millisecond
	}
	srv := server.New(st, o)
	init, err := srv.Core().Init(t.Context(), "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &install{t: t, srv: srv, ts: ts, ada: init.Token.Secret, tokens: map[string]string{"ada": init.Token.Secret}}
}

// as returns a runner for the Member whose token is named, in Session session ("" for none).
func (in *install) as(member, session string) *runner {
	tok, ok := in.tokens[member]
	if !ok {
		in.t.Fatalf("no token for %s", member)
	}
	return &runner{t: in.t, env: map[string]string{
		"DARKORY_URL": in.ts.URL, "DARKORY_TOKEN": tok, "DARKORY_SESSION": session}}
}

// agent creates an agent Member in team with skills, and a token for it.
func (in *install) agent(name, team string, skills ...string) {
	in.t.Helper()
	ada := in.as("ada", "ada-cli")
	ada.ok("member", "create", name, "--kind", "agent")
	if team != "" {
		ada.ok("team", "add", team, name)
	}
	for _, s := range skills {
		ada.ok("grant", name, s)
	}
	var issued client.IssuedToken
	ada.json(&issued, "token", "issue", name, "--name", name+"-token")
	in.tokens[name] = issued.Secret
}

// setup makes the Team WEB, whose Workflow is Plan (breakdown) and Build (engineer), each into
// Done; the generic Skill build; and the agent bob in WEB with build and engineer.
func (in *install) setup() {
	in.t.Helper()
	ada := in.as("ada", "ada-cli")
	ada.ok("team", "create", "WEB", "Web")
	ada.ok("skill", "create", "build", "--kind", "generic", "--body", "Build it well.")
	in.agent("bob", "WEB", "build", "engineer")
	if _, err := in.srv.Core().SetWorkflow(in.t.Context(), in.caller("ada"), "WEB", core.WorkflowInput{
		Steps:      []core.StepInput{{Name: "Plan", Skill: ptr(core.SkillBreakdown)}, {Name: "Build", Skill: ptr(core.SkillEngineer)}},
		Connectors: []core.ConnectorInput{{From: "Plan", Name: "done"}, {From: "Build", Name: "pass"}},
	}, core.Idem{}); err != nil {
		in.t.Fatal(err)
	}
}

// caller is the Member whose token is named, through a Session of its own, for the core.
func (in *install) caller(member string) *auth.Caller {
	in.t.Helper()
	svc := in.srv.Core()
	c, err := auth.New(svc.Store(), svc.Clock()).Authenticate(in.t.Context(), auth.Credentials{Bearer: in.tokens[member], Session: "seed"})
	if err != nil {
		in.t.Fatal(err)
	}
	return c
}

// seed files nt through the core as member, where /v1 has no route for it until it is rebuilt
// on model v2: a Task with Break down, or one at a Step. model v2: the CLI's tests of Features,
// Statuses and Handover went with those commands; M2 rebuilds them on the new ones, and these
// tests then file through the CLI again.
func (in *install) seed(member string, nt core.NewTask) core.TaskDetail {
	in.t.Helper()
	d, err := in.srv.Core().FileTask(in.t.Context(), in.caller(member), nt, core.Idem{})
	if err != nil {
		in.t.Fatal(err)
	}
	return d
}

// search seeds, as bob, Search (WEB-1) with its Breakdown (WEB-2), and Subtasks at Build titled
// titles (WEB-3 on).
func (in *install) search(titles ...string) {
	in.t.Helper()
	in.seed("bob", core.NewTask{Project: ptr("WEB"), Title: "Search", Breakdown: true})
	for _, title := range titles {
		in.seed("bob", core.NewTask{Parent: ptr("WEB-1"), Title: title, Step: ptr("Build")})
	}
}

// runner runs CLI commands as one Member.
type runner struct {
	t     *testing.T
	env   map[string]string
	hc    *http.Client
	stdin string
	// exe is the binary heartbeat run --background starts.
	exe string
}

// settings are the runner's settings, as a command reads them.
func (r *runner) settings() remote.Settings {
	return remote.FromEnv(func(k string) string { return r.env[k] })
}

type result struct {
	code           int
	stdout, stderr string
}

func (r *runner) runCtx(ctx context.Context, args ...string) result {
	return r.runTo(ctx, &bytes.Buffer{}, &bytes.Buffer{}, args...)
}

func (r *runner) runTo(ctx context.Context, out, errw writer, args ...string) result {
	env := Env{
		Stdin: strings.NewReader(r.stdin), Stdout: out, Stderr: errw,
		Getenv:     func(k string) string { return r.env[k] },
		HTTPClient: r.hc,
		Executable: r.exe,
	}
	err := Run(ctx, args, env)
	code := 0
	if err != nil {
		ex, ok := err.(*ExitError)
		if !ok {
			r.t.Fatalf("darkory %s returned %v, not an ExitError", strings.Join(args, " "), err)
		}
		code = ex.Code
	}
	return result{code: code, stdout: out.String(), stderr: errw.String()}
}

type writer interface {
	Write([]byte) (int, error)
	String() string
}

func (r *runner) run(args ...string) result { return r.runCtx(r.t.Context(), args...) }

// ok runs a command that must succeed.
func (r *runner) ok(args ...string) string {
	r.t.Helper()
	res := r.run(args...)
	if res.code != 0 {
		r.t.Fatalf("darkory %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), res.code, res.stdout, res.stderr)
	}
	return res.stdout
}

// json runs a command with --json that must succeed, and decodes its output into v.
func (r *runner) json(v any, args ...string) {
	r.t.Helper()
	out := r.ok(append(args, "--json")...)
	if err := json.Unmarshal([]byte(out), v); err != nil {
		r.t.Fatalf("darkory %s --json printed %q: %v", strings.Join(args, " "), out, err)
	}
}

// fails runs a command that must end with code, and returns its result.
func (r *runner) fails(code int, args ...string) result {
	r.t.Helper()
	res := r.run(args...)
	if res.code != code {
		r.t.Fatalf("darkory %s: exit %d, want %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), res.code, code, res.stdout, res.stderr)
	}
	return res
}

// lockedBuffer is a bytes.Buffer safe to write from one goroutine while another reads it.
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

// eventually waits up to d for cond.
func eventually(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
