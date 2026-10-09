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
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/cli/remote"
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

// agent creates an agent Member in project with skills, and a token for it.
func (in *install) agent(name, project string, skills ...string) {
	in.t.Helper()
	ada := in.as("ada", "ada-cli")
	ada.ok("member", "create", name, "--kind", "agent")
	if project != "" {
		ada.ok("project", "add", project, name)
	}
	for _, s := range skills {
		ada.ok("grant", name, s)
	}
	var issued client.IssuedToken
	ada.json(&issued, "token", "issue", name, "--name", name+"-token")
	in.tokens[name] = issued.Secret
}

// webWorkflow is the Workflow setup gives WEB: Plan (breakdown) and Build (engineer), each into
// Done.
const webWorkflow = `{"workflows": [{"name": "Work", "position": 1}], "steps": [{"workflow": "Work", "name": "Plan", "skill": "breakdown", "position": 1}, {"workflow": "Work", "name": "Build", "skill": "engineer", "position": 2}],
 "connectors": [{"from": "Plan", "name": "done", "position": 1}, {"from": "Build", "name": "pass", "position": 1}]}`

// setup makes the Project WEB, whose Workflow is webWorkflow; the generic Skill build; and the
// agent bob in WEB with build and engineer.
func (in *install) setup() {
	in.t.Helper()
	ada := in.as("ada", "ada-cli")
	ada.ok("project", "create", "WEB", "Web", "--workflow", "empty")
	ada.stdin = webWorkflow
	ada.ok("workflow", "set", "WEB", "--file", "-")
	ada.ok("skill", "create", "build", "--kind", "generic", "--body", "Build it well.")
	in.agent("bob", "WEB", "build", "engineer")
}

// search files, as bob, Search (WEB-1) with Break down, which files its Breakdown (WEB-2), and
// Subtasks at Build titled titles (WEB-3 on).
func (in *install) search(titles ...string) {
	in.t.Helper()
	bob := in.as("bob", "bob-cli")
	bob.ok("file", "--project", "WEB", "--title", "Search", "--breakdown")
	for _, title := range titles {
		bob.ok("file", "--parent", "WEB-1", "--title", title, "--step", "Build")
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
