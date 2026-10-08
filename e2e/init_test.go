package e2e

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// TestInitSeedsTheRoster runs darkory init without --no-agents in a git repository of its own, as
// a person starting a Local Install does: Project MAIN, on the default Workflow, holds ada and the
// four agents, reporting to
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
		"\nProject MAIN (Main), on the default Workflow, holds ada and the agents below.\n",
		"Workspace shop: " + root + " (git, default branch trunk), Project MAIN's default.\n",
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

	var project client.ProjectDetail
	ada.json(&project, "project", "show", "MAIN")
	var names []string
	for _, m := range project.Members {
		names = append(names, m.Name)
	}
	if strings.Join(names, " ") != "ada builder planner retro reviewer" {
		t.Fatalf("MAIN holds %v", names)
	}
	var workspaces client.WorkspaceList
	ada.json(&workspaces, "workspace", "list")
	if len(workspaces.Items) != 1 || workspaces.Items[0].Name != "shop" || workspaces.Items[0].Path != root ||
		workspaces.Items[0].DefaultBranch != "trunk" || project.Project.DefaultWorkspaceID == nil || *project.Project.DefaultWorkspaceID != workspaces.Items[0].ID {
		t.Fatalf("Workspaces %+v, MAIN's default %v", workspaces.Items, project.Project.DefaultWorkspaceID)
	}
	// MAIN's Workflow is the default: its Steps, their Skills, and the Connectors out of each.
	var flow client.Workflow
	ada.json(&flow, "workflow", "show", "MAIN")
	var steps []string
	for _, s := range flow.Steps {
		steps = append(steps, s.Name)
	}
	if strings.Join(steps, " · ") != "Backlog · Plan · Build · Review · Retro · Skill review" || len(flow.Connectors) != 8 || flow.Steps[0].SkillID != nil {
		t.Fatalf("MAIN's Workflow: %v, %d Connectors", steps, len(flow.Connectors))
	}
	if out := ada.ok("workflow", "show", "MAIN"); !strings.Contains(out, "3   Build            engineer         0 waiting, 0 working  taken by builder (agent)\n      pass → Review\n") {
		t.Fatalf("workflow show MAIN:\n%s", out)
	}
	var seeded client.SkillList
	ada.json(&seeded, "skill", "list")
	var skillNames []string
	for _, s := range seeded.Items {
		skillNames = append(skillNames, s.Name)
	}
	for _, want := range []string{"acceptance", "breakdown", "engineer", "retro", "review", "skill-review"} {
		if !slices.Contains(skillNames, want) {
			t.Fatalf("init seeded the Skills %v, without %s", skillNames, want)
		}
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

	// A Task filed in MAIN with Break down: its Breakdown names the repository and waits at Plan
	// for the planner.
	var filed client.TaskDetail
	ada.json(&filed, "file", "--project", "MAIN", "--title", "Checkout", "--breakdown")
	if len(filed.Subtasks) != 1 {
		t.Fatalf("filed %+v", filed)
	}
	if ids := filed.Subtasks[0].WorkspaceIds; ids == nil || (*ids)[0] != workspaces.Items[0].ID {
		t.Fatalf("the Breakdown names %v", ids)
	}
	if out := ada.ok("tasks", "--project", "MAIN", "--step", "Plan"); !strings.Contains(out, " Plan ") || !strings.Contains(out, "breakdown") {
		t.Fatalf("tasks at Plan:\n%s", out)
	}
}
