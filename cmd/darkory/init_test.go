package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/wake"
)

// initIn runs darkory init with dir as the working directory and data as the data directory,
// and returns what it printed.
func initIn(t *testing.T, dir, data string, args ...string) string {
	t.Helper()
	t.Chdir(dir)
	var out bytes.Buffer
	if err := run(append([]string{"init", "--data", data, "--name", "ada"}, args...), &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

// agentsOf reads the Install in data back as ada: the agents' names and the Workspaces.
func agentsOf(t *testing.T, data, adaToken string) ([]core.Member, []core.Workspace) {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(data, "darkory.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	c, err := auth.New(st, clock.Real{}).Authenticate(ctx, auth.Credentials{Bearer: adaToken, Session: "ada-test"})
	if err != nil {
		t.Fatal(err)
	}
	svc := core.New(st, clock.Real{}, wake.New(), nil)
	agents, err := svc.ListMembers(ctx, c, nil, ptr("agent"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := svc.ListWorkspaces(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	return agents, ws
}

func ptr[T any](v T) *T { return &v }

var firstToken = regexp.MustCompile(`(?m)^\s+(dk_\S+)$`)

// Inside a git repository, init seeds Project MAIN, the repository as its default Workspace and the
// four agents, writes each agent's token to <data>/agents/<name>.token readable by its user
// alone, and lists them; the first token it prints is still the first Member's.
func TestInitSeedsTheRosterInAGitRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := filepath.Join(t.TempDir(), "shop")
	cmd := exec.Command("git", "init", "-q", "-b", "trunk", repo)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	sub := filepath.Join(repo, "web")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	data := t.TempDir()
	out := initIn(t, sub, data)
	root, _ := filepath.EvalSymlinks(repo)
	for _, want := range []string{
		"First Member: ada (human, admin)",
		"\nProject MAIN (Main), on the default Workflow, holds ada and the agents below.\n",
		"Workspace shop: " + root + " (git, default branch trunk), Project MAIN's default.\n",
		"Agents, reporting to ada, each with a token in " + filepath.Join(data, "agents", "<name>.token") + ":\n",
		"  planner   breakdown              claude-opus-5-5\n",
		"  builder   engineer               claude-sonnet-5-5\n",
		"  reviewer  review, skill-review   claude-opus-5-5\n",
		"  retro     retro                  claude-opus-5-5\n",
		"\ndarkory serve prints a fresh login link every time it starts.\n",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("init printed no %q:\n%s", want, out)
		}
	}
	m := firstToken.FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no token printed:\n%s", out)
	}
	var names []string
	for _, name := range []string{"planner", "builder", "reviewer", "retro"} {
		path := filepath.Join(data, "agents", name+".token")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s is %v, want 0600", path, info.Mode().Perm())
		}
		b, _ := os.ReadFile(path)
		secret := strings.TrimSpace(string(b))
		if !strings.HasPrefix(secret, "dk_") || strings.Contains(out, secret) {
			t.Errorf("%s holds %q, printed: %v", path, secret, strings.Contains(out, secret))
		}
		names = append(names, name)
	}
	if info, err := os.Stat(filepath.Join(data, "agents")); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the agents directory: %v %v", info, err)
	}
	agents, ws := agentsOf(t, data, m[1])
	var got []string
	for _, a := range agents {
		got = append(got, a.Name)
		if a.Agent == nil || a.Agent.Command != "claude" {
			t.Errorf("%s has settings %+v", a.Name, a.Agent)
		}
	}
	slices.Sort(names)
	if !slices.Equal(got, names) {
		t.Fatalf("agents %v, want %v", got, names)
	}
	if len(ws) != 1 || ws[0].Name != "shop" || ws[0].DefaultBranch != "trunk" {
		t.Fatalf("Workspaces %+v", ws)
	}
}

// Outside a git repository the roster is seeded with no Workspace, and init says how to add one;
// --no-agents seeds nothing but the Organisation and its first Member.
func TestInitOutsideAGitRepository(t *testing.T) {
	data := t.TempDir()
	out := initIn(t, t.TempDir(), data)
	if !strings.Contains(out, "No Workspace: init ran outside a git repository. Add one with darkory workspace add --path <repository>,\n"+
		"then make it the Project's default with darkory team set MAIN --default-workspace <name>.\n") || !strings.Contains(out, "  planner ") {
		t.Fatalf("init outside a repository printed:\n%s", out)
	}
	agents, ws := agentsOf(t, data, firstToken.FindStringSubmatch(out)[1])
	if len(agents) != 4 || len(ws) != 0 {
		t.Fatalf("%d agents, Workspaces %+v", len(agents), ws)
	}

	data = t.TempDir()
	out = initIn(t, t.TempDir(), data, "--no-agents")
	if strings.Contains(out, "Project MAIN") || strings.Contains(out, "Workspace") {
		t.Fatalf("init --no-agents printed:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(data, "agents")); !os.IsNotExist(err) {
		t.Fatalf("init --no-agents made %s: %v", filepath.Join(data, "agents"), err)
	}
	agents, _ = agentsOf(t, data, firstToken.FindStringSubmatch(out)[1])
	if len(agents) != 0 {
		t.Fatalf("init --no-agents made %d agents", len(agents))
	}
}
