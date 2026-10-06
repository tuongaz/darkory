package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// TestInitSeedsTheRoster runs darkory init without --no-agents in a git repository of its own, as
// a person starting a Local Install does: Team MAIN holds ada and the four agents, reporting to
// her with their Skills and agent settings; the repository is MAIN's default Workspace with the
// branch it was made on; each agent's token is in <data>/agents/<name>.token, readable by its
// user alone, never printed, and works.
func TestInitSeedsTheRoster(t *testing.T) {
	needE2E(t)
	repo := filepath.Join(t.TempDir(), "shop")
	git := exec.Command("git", "init", "-q", "-b", "trunk", repo)
	git.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := git.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	root, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatal(err)
	}
	in := newInstallIn(t, root)
	ada := in.ada

	for _, want := range []string{
		"\nTeam MAIN (Main) holds ada and the agents below.\n",
		"Workspace shop: " + root + " (git, default branch trunk), Team MAIN's default.\n",
		"Agents, reporting to ada, each with a token in " + filepath.Join(in.dir, "agents", "<name>.token") + ":\n",
		"  planner   breakdown              claude-opus-5-5\n",
		"  builder   engineer               claude-sonnet-5-5\n",
		"  reviewer  review, skill-review   claude-opus-5-5\n",
		"  retro     retro                  claude-opus-5-5\n",
	} {
		if !strings.Contains(in.initOutput, want) {
			t.Fatalf("init printed no %q:\n%s", want, in.initOutput)
		}
	}

	var team client.TeamDetail
	ada.json(&team, "team", "show", "MAIN")
	var names []string
	for _, m := range team.Members {
		names = append(names, m.Name)
	}
	if strings.Join(names, " ") != "ada builder planner retro reviewer" {
		t.Fatalf("MAIN holds %v", names)
	}
	var workspaces client.WorkspaceList
	ada.json(&workspaces, "workspace", "list")
	if len(workspaces.Items) != 1 || workspaces.Items[0].Name != "shop" || workspaces.Items[0].Path != root ||
		workspaces.Items[0].DefaultBranch != "trunk" || team.Team.DefaultWorkspaceID == nil || *team.Team.DefaultWorkspaceID != workspaces.Items[0].ID {
		t.Fatalf("Workspaces %+v, MAIN's default %v", workspaces.Items, team.Team.DefaultWorkspaceID)
	}

	models := map[string]string{"planner": "claude-opus-5-5", "builder": "claude-sonnet-5-5", "reviewer": "claude-opus-5-5", "retro": "claude-opus-5-5"}
	skills := map[string]string{"planner": "breakdown", "builder": "engineer", "reviewer": "review skill-review", "retro": "retro"}
	for name, model := range models {
		path := filepath.Join(in.dir, "agents", name+".token")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s is %v, want 0600", path, info.Mode().Perm())
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		secret := strings.TrimSpace(string(b))
		if !strings.HasPrefix(secret, "dk_") || strings.Contains(in.initOutput, secret) || string(b) != secret+"\n" {
			t.Fatalf("%s holds %q", path, b)
		}
		agent := &member{in: in, name: name, token: secret, url: in.servers[0].url}
		agent.session = agent.prime()
		var me client.Me
		agent.json(&me, "me")
		var got []string
		for _, s := range me.Skills {
			got = append(got, s.Name)
		}
		if me.Member.Kind != client.Agent || me.Member.ManagerID == nil || *me.Member.ManagerID != ada.id || strings.Join(got, " ") != skills[name] ||
			me.Member.Agent == nil || me.Member.Agent.Model != model || me.Member.Agent.Command != "claude" || me.Member.Agent.Paused {
			t.Fatalf("%s is %+v with Skills %v", name, me.Member, got)
		}
	}
	if info, err := os.Stat(filepath.Join(in.dir, "agents")); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the agents directory: %v %v", info, err)
	}

	// A Feature filed in MAIN: its Break down names the repository.
	var filed client.FeatureDetail
	ada.json(&filed, "feature", "create", "--team", "MAIN", "--title", "Checkout")
	if ids := filed.Tasks[0].WorkspaceIds; ids == nil || (*ids)[0] != workspaces.Items[0].ID {
		t.Fatalf("the Break down names %v", ids)
	}
}
