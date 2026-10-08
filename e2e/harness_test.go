package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/tuongaz/darkory/client"
)

// bin is the darkory binary built for this run; empty unless DARKORY_E2E=1.
var bin string

func TestMain(m *testing.M) { os.Exit(runMain(m)) }

func runMain(m *testing.M) int {
	if os.Getenv("DARKORY_E2E") != "1" {
		return m.Run()
	}
	dir, err := os.MkdirTemp("", "darkory-e2e-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(dir)
	bin = filepath.Join(dir, "darkory")
	args := []string{"build", "-o", bin}
	if os.Getenv("DARKORY_E2E_RACE") == "1" {
		args = append(args, "-race")
	}
	cmd := exec.Command("go", append(args, "./cmd/darkory")...)
	cmd.Dir = ".."
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "building darkory:", err)
		return 1
	}
	return m.Run()
}

// needE2E skips a test unless DARKORY_E2E=1 built the binary.
func needE2E(t *testing.T) {
	t.Helper()
	if bin == "" {
		t.Skip("set DARKORY_E2E=1 to run the end-to-end tests (make e2e, make e2e-pg)")
	}
}

// postgresURL names the Postgres server the tests create their databases on, or "" for SQLite.
func postgresURL() string { return os.Getenv("DARKORY_E2E_POSTGRES_URL") }

func engine() string {
	if postgresURL() != "" {
		return "postgres"
	}
	return "sqlite"
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// newDatabase creates an empty Postgres database for one test and drops it when the test ends,
// after the servers using it have stopped.
func newDatabase(t *testing.T) string {
	t.Helper()
	admin, err := sql.Open("pgx", postgresURL())
	if err != nil {
		t.Fatal(err)
	}
	name := "dk_e2e_" + randomHex(6)
	if _, err := admin.ExecContext(t.Context(), `CREATE DATABASE "`+name+`" TEMPLATE template0`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(`DROP DATABASE IF EXISTS "` + name + `" WITH (FORCE)`); err != nil {
			t.Errorf("dropping %s: %v", name, err)
		}
		admin.Close()
	})
	u, err := url.Parse(postgresURL())
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

// logBuffer collects a process's output as it is written, so a pipe never fills.
type logBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// install is one Darkory Install: its data directory, its database and the serve processes on it.
type install struct {
	t *testing.T
	// serveEnv is added to every serve process's environment, as the runner's timings.
	serveEnv []string
	// dir is the data directory, and HOME for every process, so pid files and caches stay in it.
	dir string
	db  string
	// wd is the working directory of every process; "" for this package's.
	wd      string
	ada     *member // the human admin darkory init created
	servers []*serveProc
	// initOutput is what darkory init printed.
	initOutput string
}

// serveProc is one `darkory serve` process.
type serveProc struct {
	url    string
	cmd    *exec.Cmd
	log    *logBuffer
	exited chan struct{}
}

// newInstall runs darkory init --no-agents on a fresh database and starts one server: the
// Organisation, ada and Project MAIN holding her, without the agents and Workspace init seeds by
// default.
func newInstall(t *testing.T) *install {
	t.Helper()
	return newInstallWith(t, "--no-agents")
}

// newInstallWith runs darkory init with initArgs on a fresh database and starts one server. Run
// from this package's directory, init finds the repository it is in.
func newInstallWith(t *testing.T, initArgs ...string) *install {
	t.Helper()
	return newInstallIn(t, "", initArgs...)
}

// newInstallIn is newInstallWith with wd as every process's working directory, as when a person
// runs darkory init in a repository of theirs.
func newInstallIn(t *testing.T, wd string, initArgs ...string) *install {
	t.Helper()
	needE2E(t)
	in := &install{t: t, dir: t.TempDir(), wd: wd}
	in.db = filepath.Join(in.dir, "darkory.db")
	if postgresURL() != "" {
		in.db = newDatabase(t)
	}
	res := in.exec(in.env(), append([]string{"init", "--org", "Acme", "--name", "ada", "--data", in.dir, "--db", in.db}, initArgs...)...)
	in.initOutput = res.stdout
	if res.code != 0 {
		t.Fatalf("darkory init: exit %d\n%s%s", res.code, res.stdout, res.stderr)
	}
	token := regexp.MustCompile(`(?m)^\s+(dk_\S+)$`).FindStringSubmatch(res.stdout)
	if token == nil {
		t.Fatalf("no token in darkory init's output:\n%s", res.stdout)
	}
	srv := in.serve()
	in.ada = &member{in: in, name: "ada", token: token[1], url: srv.url}
	in.ada.session = in.ada.prime()
	var me client.Me
	in.ada.json(&me, "me")
	in.ada.id = me.Member.ID
	return in
}

func (in *install) env(extra ...string) []string {
	return append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + in.dir, "TMPDIR=" + os.TempDir(), "DARKORY_NO_UPDATE_CHECK=1"}, extra...)
}

// result is how a process ended.
type result struct {
	stdout, stderr string
	code           int
}

// exec runs the binary to completion, for at most two minutes.
func (in *install) exec(env []string, args ...string) result {
	in.t.Helper()
	ctx, cancel := context.WithTimeout(in.t.Context(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env, cmd.Dir = env, in.wd
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		return result{stdout.String(), stderr.String(), exit.ExitCode()}
	case err != nil:
		in.t.Fatalf("darkory %s: %v", strings.Join(args, " "), err)
	}
	return result{stdout.String(), stderr.String(), 0}
}

var servingURL = regexp.MustCompile(`msg="darkory is serving".* url=(\S+)`)

// serve starts a server on a free port and waits until it answers; it is stopped, and its log
// checked, when the test ends.
func (in *install) serve(args ...string) *serveProc {
	in.t.Helper()
	p := &serveProc{log: &logBuffer{}, exited: make(chan struct{})}
	// No Runner unless a test asks for one: an Install init seeded runs its agents' sessions, and
	// the roster's default command is Claude Code.
	if !slices.ContainsFunc(args, func(a string) bool { return strings.HasPrefix(a, "--runner") }) {
		args = append(args, "--runner=off")
	}
	p.cmd = exec.Command(bin, append([]string{"serve", "--listen", "127.0.0.1:0", "--data", in.dir, "--db", in.db,
		"--no-browser", "--no-update-check"}, args...)...)
	p.cmd.Env = in.env(in.serveEnv...)
	p.cmd.Stdout, p.cmd.Stderr = p.log, p.log
	if err := p.cmd.Start(); err != nil {
		in.t.Fatal(err)
	}
	go func() {
		p.cmd.Wait()
		close(p.exited)
	}()
	in.t.Cleanup(func() {
		p.stop()
		checkLog(in.t, "serve", p.log.String())
	})
	deadline := time.After(30 * time.Second)
	for {
		if m := servingURL.FindStringSubmatch(p.log.String()); m != nil {
			p.url = m[1]
			break
		}
		select {
		case <-p.exited:
			in.t.Fatalf("darkory serve exited:\n%s", p.log)
		case <-deadline:
			in.t.Fatalf("darkory serve did not start:\n%s", p.log)
		case <-time.After(20 * time.Millisecond):
		}
	}
	in.servers = append(in.servers, p)
	return p
}

// stop ends the server as an operator would, and kills it if it does not stop in time.
func (p *serveProc) stop() {
	select {
	case <-p.exited:
		return
	default:
	}
	p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.exited:
	case <-time.After(15 * time.Second):
		p.cmd.Process.Kill()
		<-p.exited
	}
}

// badLog matches what a server or client must never report: a failed request, a busy database, a
// data race or a panic.
var badLog = regexp.MustCompile(`level=ERROR|(?i:database (table )?is locked|sqlite_busy|sqlite_locked)|WARNING: DATA RACE|panic:|fatal error:`)

func checkLog(t *testing.T, who, log string) {
	t.Helper()
	var bad []string
	for _, line := range strings.Split(log, "\n") {
		if badLog.MatchString(line) {
			bad = append(bad, line)
		}
	}
	if len(bad) > 0 {
		t.Errorf("%s logged %d bad lines, the first:\n%s", who, len(bad), strings.Join(bad[:min(len(bad), 20)], "\n"))
	}
}

// member is a Member acting through the binary in one Session.
type member struct {
	in      *install
	name    string
	id      string
	token   string
	session string
	url     string // the server this Member talks to
}

func (m *member) env() []string {
	return m.in.env("DARKORY_URL="+m.url, "DARKORY_TOKEN="+m.token, "DARKORY_SESSION="+m.session)
}

// run runs a CLI command as m.
func (m *member) run(args ...string) result {
	m.in.t.Helper()
	return m.in.exec(m.env(), args...)
}

// ok runs a CLI command as m, failing the test unless it exits 0.
func (m *member) ok(args ...string) string {
	m.in.t.Helper()
	res := m.run(args...)
	if res.code != 0 {
		m.in.t.Fatalf("%s: darkory %s: exit %d\n%s%s", m.name, strings.Join(args, " "), res.code, res.stdout, res.stderr)
	}
	return res.stdout
}

// json runs a CLI command as m with --json and decodes its output into v.
func (m *member) json(v any, args ...string) {
	m.in.t.Helper()
	out := m.ok(append(args, "--json")...)
	// Decode into a zero value: fields the reply leaves out must not keep an earlier reply's.
	reflect.ValueOf(v).Elem().SetZero()
	if err := json.Unmarshal([]byte(out), v); err != nil {
		m.in.t.Fatalf("%s: darkory %s --json: %v\n%s", m.name, strings.Join(args, " "), err, out)
	}
}

// refused runs a CLI command as m with --json, wanting exit status code and the error code
// errCode on standard error.
func (m *member) refused(code int, errCode client.ErrorCode, args ...string) client.Error {
	m.in.t.Helper()
	res := m.run(append(args, "--json")...)
	var e client.Error
	if res.code != code || json.Unmarshal([]byte(res.stderr), &e) != nil || e.Code != errCode {
		m.in.t.Fatalf("%s: darkory %s: exit %d, want %d with %s\n%s%s", m.name, strings.Join(args, " "), res.code, code, errCode, res.stdout, res.stderr)
	}
	return e
}

// prime asks darkory prime for a fresh Session id, as an agent's `eval "$(darkory prime)"` does.
func (m *member) prime() string {
	m.in.t.Helper()
	out := m.ok("prime")
	id, ok := strings.CutPrefix(strings.SplitN(out, "\n", 2)[0], "export DARKORY_SESSION=")
	if !ok || id == "" {
		m.in.t.Fatalf("darkory prime printed %q", out)
	}
	return id
}

// sibling is another running copy of m: the same token in a fresh Session.
func (m *member) sibling() *member {
	s := *m
	s.session = m.prime()
	return &s
}

// on is m talking to another server of the Install.
func (m *member) on(p *serveProc) *member {
	s := *m
	s.url = p.url
	return &s
}

// buildFlow is a Workflow of one Step, Build, carrying the Skill build, with one way out, "pass",
// into Done.
const buildFlow = `{"steps": [{"name": "Build", "skill": "build", "position": 1}], "connectors": [{"from": "Build", "name": "pass", "position": 1}]}`

// project creates a Project through ada's CLI, with ada in it, on the Workflow flow: a body as
// darkory workflow set reads it, or "" for the default Workflow.
func (in *install) project(key, name, flow string) {
	in.t.Helper()
	if flow == "" {
		in.ada.ok("project", "create", key, name, "--member", "ada")
		return
	}
	in.ada.ok("project", "create", key, name, "--member", "ada", "--workflow", "empty")
	in.ada.ok("workflow", "set", key, "--file", writeFile(in.t, filepath.Join(in.dir, key+"-workflow.json"), flow))
}

// agent creates an agent Member through ada's CLI: in projects, granted skills, with a token issued
// with tokenArgs (such as --timeout 5s), in a Session darkory prime chose.
func (in *install) agent(name string, projects, skills []string, tokenArgs ...string) *member {
	in.t.Helper()
	var mem client.Member
	in.ada.json(&mem, "member", "create", name, "--kind", "agent")
	for _, p := range projects {
		in.ada.ok("project", "add", p, name)
	}
	for _, s := range skills {
		in.ada.ok("grant", name, s)
	}
	var tok client.IssuedToken
	in.ada.json(&tok, append([]string{"token", "issue", name, "--name", name}, tokenArgs...)...)
	m := &member{in: in, name: name, id: mem.ID, token: tok.Secret, url: in.servers[0].url}
	m.session = m.prime()
	return m
}

// mcpAgent is `darkory mcp` running as a Member, reached over its standard input and output.
type mcpAgent struct {
	t   *testing.T
	cmd *exec.Cmd
	cs  *sdk.ClientSession
	log *logBuffer
}

// mcp starts `darkory mcp` as m, in m's Session, with dir as its evidence root.
func (m *member) mcp(dir string) *mcpAgent {
	t := m.in.t
	t.Helper()
	cmd := exec.Command(bin, "mcp")
	cmd.Env = m.env()
	cmd.Dir = dir
	a := &mcpAgent{t: t, cmd: cmd, log: &logBuffer{}}
	cmd.Stderr = a.log
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "e2e-agent", Version: "1"}, nil).
		Connect(t.Context(), &sdk.CommandTransport{Command: cmd}, nil)
	if err != nil {
		t.Fatalf("starting darkory mcp: %v\n%s", err, a.log)
	}
	a.cs = cs
	t.Cleanup(a.close)
	return a
}

func (a *mcpAgent) close() {
	if a.cs != nil {
		a.cs.Close()
		a.cs = nil
		checkLog(a.t, "darkory mcp", a.log.String())
	}
}

// call calls a tool, failing the test on a protocol or tool error, and decodes its structured
// output into out.
func (a *mcpAgent) call(name string, args map[string]any, out any) {
	a.t.Helper()
	res, err := a.cs.CallTool(a.t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		a.t.Fatalf("MCP %s: %v", name, err)
	}
	if res.IsError {
		a.t.Fatalf("MCP %s: %s", name, toolText(res))
	}
	if out == nil {
		return
	}
	reflect.ValueOf(out).Elem().SetZero()
	b, err := json.Marshal(res.StructuredContent)
	if err == nil {
		err = json.Unmarshal(b, out)
	}
	if err != nil {
		a.t.Fatalf("MCP %s: decoding %s: %v", name, b, err)
	}
}

// refused calls a tool that must fail with errCode, read from the result's darkory/error.
func (a *mcpAgent) refused(name string, args map[string]any, errCode client.ErrorCode) {
	a.t.Helper()
	res, err := a.cs.CallTool(a.t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		a.t.Fatalf("MCP %s: %v", name, err)
	}
	var e client.Error
	b, _ := json.Marshal(res.Meta["darkory/error"])
	if !res.IsError || json.Unmarshal(b, &e) != nil || e.Code != errCode {
		a.t.Fatalf("MCP %s: want a tool error %s, got %s (meta %s)", name, errCode, toolText(res), b)
	}
}

func toolText(res *sdk.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

// writePNG writes a small real PNG image, as a screenshot.
func writePNG(t *testing.T, path string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := range 8 {
		for y := range 8 {
			img.Set(x, y, color.RGBA{uint8(x * 32), uint8(y * 32), 128, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// eventually polls cond every 50 ms until it holds or within passes.
func eventually(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not happen within %s", what, within)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// filepathGlob finds the files under root whose names match pattern.
func filepathGlob(root, pattern string) ([]string, error) {
	var found []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ok, _ := filepath.Match(pattern, d.Name()); ok && !d.IsDir() {
			found = append(found, path)
		}
		return nil
	})
	return found, err
}
