package e2e

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// triageAndBugs is a Project of two Workflows: Triage, whose bug outcome leads into Bugs, and
// Bugs, where a bug is investigated and fixed.
const triageAndBugs = `{"workflows": [{"name": "Triage", "position": 1}, {"name": "Bugs", "position": 2}],
 "skills": [{"name": "triage", "body": "Route it."}],
 "steps": [
   {"workflow": "Triage", "name": "Triage", "skill": "triage", "position": 1},
   {"workflow": "Bugs", "name": "Investigate", "skill": "engineer", "position": 1},
   {"workflow": "Bugs", "name": "Fix", "skill": "engineer", "position": 2}],
 "connectors": [
   {"from": "Triage", "to": "Investigate", "name": "bug", "position": 1},
   {"from": "Triage", "name": "question", "position": 2},
   {"from": "Investigate", "to": "Fix", "name": "fix", "position": 1},
   {"from": "Fix", "name": "done", "position": 1}],
 "grants": [{"member": "ada", "skill": "triage"}, {"member": "ada", "skill": "engineer"}]}`

// A Project with two Workflows, through the CLI (ADR 0019): workflow show heads each Workflow and
// names the one a crossing outcome reaches; a Task filed starts at the Project's first Step,
// crosses into Bugs along bug, and is listed by the Workflow it is in, open and ended; the body
// sent again with its Steps' ids alone writes nothing; deleting the Step a Task ended at
// re-points it by moves; a Step in a Workflow the body does not have is refused.
func TestWorkflows(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	in.project("ACC", "Accounting", triageAndBugs)

	out := ada.ok("workflow", "show", "ACC")
	if !strings.HasPrefix(out, "Triage\n1   Triage ") || !strings.Contains(out, "\nBugs\n1   Investigate ") ||
		!strings.Contains(out, "\n      bug → Bugs › Investigate\n") || !strings.Contains(out, "\n      question → Done\n") {
		t.Fatalf("workflow show ACC:\n%s", out)
	}
	var wf client.Workflows
	ada.json(&wf, "workflow", "show", "ACC")
	step := map[string]string{}
	for _, s := range wf.Steps {
		step[s.Name] = s.ID
	}
	if len(wf.Workflows) != 2 || len(step) != 3 {
		t.Fatalf("ACC's Workflows: %+v", wf)
	}

	// Filed with no Step, at the Project's first: Triage.
	var filed client.TaskDetail
	ada.json(&filed, "file", "--project", "ACC", "--title", "Totals round twice")
	key := filed.Task.Key
	if filed.Step == nil || filed.Step.Name != "Triage" {
		t.Fatalf("%s was filed at %s", key, where(filed))
	}

	// Along bug, into Bugs: listed there and not in Triage. tri triages it, since one who has
	// held a Task under one Skill takes it again only under that Skill, and ada fixes it.
	tri := in.agent("tri", []string{"ACC"}, []string{"triage"})
	tri.ok("claim", key, "--timeout", "0")
	tri.ok("advance", key, "bug")
	listed := func(args ...string) []string {
		t.Helper()
		var page client.TaskList
		ada.json(&page, append([]string{"tasks", "--project", "ACC"}, args...)...)
		var keys []string
		for _, task := range page.Items {
			keys = append(keys, task.Key)
		}
		return keys
	}
	if keys := listed("--workflow", "Bugs"); !slices.Equal(keys, []string{key}) {
		t.Fatalf("tasks --workflow Bugs: %v, want [%s]", keys, key)
	}
	if keys := listed("--workflow", "Triage"); len(keys) != 0 {
		t.Fatalf("tasks --workflow Triage: %v, want none", keys)
	}
	if out := ada.ok("show", key); !strings.Contains(out, "\n  Step       Investigate (engineer)") {
		t.Fatalf("show %s after bug:\n%s", key, out)
	}

	// Fixed and done: it keeps the Step it ended at, so Bugs still lists it.
	ada.ok("claim", key, "--timeout", "0")
	ada.ok("advance", key, "fix")
	ada.ok("claim", key, "--timeout", "0")
	ada.ok("advance", key, "done")
	var done client.TaskDetail
	ada.json(&done, "show", key)
	if done.Task.State != client.TaskStateDone || done.Task.StepID != nil || deref(done.Task.LastStepID) != step["Fix"] {
		t.Fatalf("%s done: state %s, Step %v, last Step %v; want done at no Step, last at Fix %s", key, done.Task.State, done.Task.StepID, done.Task.LastStepID, step["Fix"])
	}
	if keys := listed("--workflow", "Bugs", "--state", "done"); !slices.Equal(keys, []string{key}) {
		t.Fatalf("tasks --workflow Bugs --state done: %v, want [%s]", keys, key)
	}

	// A Parent is at no Step: the server lists it in the Workflow of its least-advanced open
	// Subtask, here Investigate's Bugs.
	var parent, sub client.TaskDetail
	ada.json(&parent, "file", "--project", "ACC", "--title", "Rounding")
	ada.json(&sub, "file", "--parent", parent.Task.Key, "--title", "Find the rounding", "--step", "Investigate")
	if keys := listed("--workflow", "Bugs", "--state", "open"); !slices.Equal(keys, []string{parent.Task.Key, sub.Task.Key}) {
		t.Fatalf("tasks --workflow Bugs --state open: %v, want the Parent %s and its Subtask %s", keys, parent.Task.Key, sub.Task.Key)
	}

	// The same body again, as a preset re-run sends it: each Step with its id, as a Step sent
	// without one is new, and no Workflow or Connector id, as each keeps its id by name; so
	// nothing is written. Its skills entry is left out: it creates a Skill, and triage is there.
	bare := strings.Replace(triageAndBugs, "\n \"skills\": [{\"name\": \"triage\", \"body\": \"Route it.\"}],", "", 1)
	again := bare
	for name, id := range step {
		again = strings.Replace(again, `", "name": "`+name+`", "skill"`, `", "id": "`+id+`", "name": "`+name+`", "skill"`, 1)
	}
	if strings.Contains(again, `"skills"`) || strings.Count(again, `"id"`) != 3 {
		t.Fatalf("the body again:\n%s", again)
	}
	// Of the Project's workflow.changed, one has its two Workflows: the set above.
	changes := func() (all, two int) {
		t.Helper()
		var page client.ActivityPage
		ada.json(&page, "activity", "--project", "ACC", "--kind", "workflow.changed")
		for _, e := range page.Items {
			if w, _ := e.Payload["workflows"].([]any); len(w) == 2 {
				two++
			}
		}
		return len(page.Items), two
	}
	before, two := changes()
	ada.ok("workflow", "set", "ACC", "--file", writeFile(t, filepath.Join(in.dir, "ACC-again.json"), again))
	if after, again := changes(); two != 1 || after != before || again != 1 {
		t.Fatalf("workflow.changed with two Workflows: %d, then %d after the same body again (%d in all, then %d); want 1, and none more", two, again, before, after)
	}

	// Fix deleted, the Tasks that ended there moved to Investigate.
	noFix := strings.Replace(again, `,
   {"workflow": "Bugs", "id": "`+step["Fix"]+`", "name": "Fix", "skill": "engineer", "position": 2}]`, `]`, 1)
	noFix = strings.Replace(noFix, `
   {"from": "Investigate", "to": "Fix", "name": "fix", "position": 1},
   {"from": "Fix", "name": "done", "position": 1}],`, `
   {"from": "Investigate", "name": "done", "position": 1}],
 "moves": {"`+step["Fix"]+`": "Investigate"},`, 1)
	if noFix == again || strings.Contains(noFix, `"Fix"`) {
		t.Fatalf("the body without Fix still has it:\n%s", noFix)
	}
	ada.ok("workflow", "set", "ACC", "--file", writeFile(t, filepath.Join(in.dir, "ACC-no-fix.json"), noFix))
	ada.json(&done, "show", key)
	if deref(done.Task.LastStepID) != step["Investigate"] {
		t.Fatalf("%s's last Step after Fix was deleted: %v, want Investigate %s", key, done.Task.LastStepID, step["Investigate"])
	}
	if keys := listed("--workflow", "Bugs", "--state", "done"); !slices.Equal(keys, []string{key}) {
		t.Fatalf("tasks --workflow Bugs --state done after Fix was deleted: %v, want [%s]", keys, key)
	}

	// A Step in a Workflow the body does not name is refused as invalid, which the CLI exits 1
	// on, as on every failure that is not a refusal by one of the record's rules.
	stray := strings.Replace(bare, `{"workflow": "Bugs", "name": "Fix"`, `{"workflow": "Ops", "name": "Fix"`, 1)
	if e := ada.refused(1, client.ErrorCodeInvalid, "workflow", "set", "ACC", "--file", writeFile(t, filepath.Join(in.dir, "ACC-stray.json"), stray)); !strings.Contains(e.Message, "Ops") {
		t.Fatalf("a Step in Ops, which the body does not have: %s", e.Message)
	}
}
