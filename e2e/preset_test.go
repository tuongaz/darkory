package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
)

// workFlow is one Workflow, Work, holding the Steps of a default Project's Implementation: a
// Project as one was before the default had two Workflows.
const workFlow = `{"workflows": [{"name": "Work", "position": 1}], "steps": [
  {"workflow": "Work", "name": "Backlog", "position": 1},
  {"workflow": "Work", "name": "Plan", "skill": "breakdown", "position": 2},
  {"workflow": "Work", "name": "Build", "skill": "engineer", "position": 3},
  {"workflow": "Work", "name": "Review", "skill": "review", "position": 4},
  {"workflow": "Work", "name": "Retro", "skill": "retro", "position": 5},
  {"workflow": "Work", "name": "Skill review", "skill": "skill-review", "position": 6}],
 "connectors": [
  {"from": "Plan", "name": "done", "position": 1},
  {"from": "Build", "to": "Review", "name": "pass", "position": 1},
  {"from": "Review", "name": "pass", "position": 1}, {"from": "Review", "to": "Build", "name": "needs changes", "position": 2},
  {"from": "Retro", "name": "done", "position": 1}, {"from": "Retro", "to": "Skill review", "name": "propose", "position": 2},
  {"from": "Skill review", "name": "publish", "position": 1}, {"from": "Skill review", "to": "Retro", "name": "needs changes", "position": 2}]}`

// The software preset's setup.sh, run twice on a Project with two Workflows (ADR 0019): the first
// run turns the Project's Workflow into Software, keeping its id and the Steps it shares by name,
// moving the Tasks at the Steps it drops to Backlog, and leaves Bugs, its Step, its Tasks and the
// Connectors out of it and crossing into it as they were, one into a dropped Step led into
// Backlog instead; the second writes nothing. A third, once Bugs has a Step named as one of the
// preset's, is refused before it writes.
func TestSoftwarePresetKeepsOtherWorkflows(t *testing.T) {
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("the software preset's setup.sh needs jq, which is not on PATH")
	}
	in := newInstall(t)
	ada := in.ada
	in.project("OLD", "Old", workFlow)

	file := func(title, step string) string {
		t.Helper()
		var filed client.TaskDetail
		ada.json(&filed, "file", "--project", "OLD", "--title", title, "--step", step)
		if filed.Step == nil || filed.Step.Name != step {
			t.Fatalf("%s was filed at %s, want %s", filed.Task.Key, where(filed), step)
		}
		return filed.Task.Key
	}
	key := file("Short links expire", "Build")
	reviewing := file("Shorter links", "Review")

	// A second Workflow, Bugs, with Investigate, and a bug outcome from Build into it.
	var body client.SetWorkflowBody
	if out := ada.ok("workflow", "show", "OLD", "--body"); json.Unmarshal([]byte(out), &body) != nil || len(body.Workflows) != 1 {
		t.Fatalf("workflow show OLD --body:\n%s", out)
	}
	fromBuild := int64(0)
	for _, k := range body.Connectors {
		if k.From == "Build" {
			fromBuild = max(fromBuild, deref64(k.Position))
		}
	}
	body.Workflows = append(body.Workflows, client.WorkflowInput{Name: "Bugs", Position: ptr(int64(2))})
	body.Steps = append(body.Steps, client.StepInput{Workflow: "Bugs", Name: "Investigate", Skill: ptr("engineer"), Position: ptr(int64(1))})
	body.Connectors = append(body.Connectors, client.ConnectorInput{From: "Build", To: ptr("Investigate"), Name: "bug", Position: ptr(fromBuild + 1)},
		client.ConnectorInput{From: "Investigate", To: ptr("Review"), Name: "fixed", Position: ptr(int64(1))},
		client.ConnectorInput{From: "Investigate", Name: "done", Position: ptr(int64(2))})
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	ada.ok("workflow", "set", "OLD", "--file", writeFile(t, filepath.Join(in.dir, "OLD-bugs.json"), string(b)))
	investigating := file("Crash on save", "Investigate")

	var before client.Workflows
	ada.json(&before, "workflow", "show", "OLD")
	workflow, step := map[string]string{}, map[string]string{}
	for _, w := range before.Workflows {
		workflow[w.Name] = w.ID
	}
	for _, s := range before.Steps {
		step[s.Name] = s.ID
	}
	bug, fixed, done := "", "", client.Connector{}
	for _, k := range before.Connectors {
		switch {
		case k.Name == "bug" && k.FromStepID == step["Build"] && deref(k.ToStepID) == step["Investigate"]:
			bug = k.ID
		case k.Name == "fixed" && k.FromStepID == step["Investigate"] && deref(k.ToStepID) == step["Review"]:
			fixed = k.ID
		case k.Name == "done" && k.FromStepID == step["Investigate"] && k.ToStepID == nil:
			done = k
		}
	}
	if workflow["Work"] == "" || workflow["Bugs"] == "" || step["Investigate"] == "" || step["Review"] == "" || bug == "" || fixed == "" || done.ID == "" {
		t.Fatalf("OLD before the preset: %+v", before)
	}

	// The Project's workflow.changed entries after seq.
	changes := func(after int64) []client.Activity {
		t.Helper()
		var page client.ActivityPage
		ada.json(&page, "activity", "--project", "OLD", "--kind", "workflow.changed")
		var out []client.Activity
		for _, e := range page.Items {
			if e.Seq > after {
				out = append(out, e)
			}
		}
		return out
	}
	last := int64(0)
	for _, e := range changes(0) {
		last = max(last, e.Seq)
	}

	script, err := filepath.Abs("../examples/workflows/software/setup.sh")
	if err != nil {
		t.Fatal(err)
	}
	run := func() (string, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "bash", script)
		cmd.Env = append(ada.env(), "DARKORY="+bin, "DATA="+in.dir, "PROJECT=OLD")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		err := cmd.Run()
		return out.String(), err
	}
	setup := func(n int) {
		t.Helper()
		if out, err := run(); err != nil {
			t.Fatalf("setup.sh, run %d: %v\n%s", n, err, out)
		}
	}

	// Run 1: one change, with Software (the old Workflow, by id) and Bugs (by id).
	setup(1)
	got := changes(last)
	if len(got) != 1 {
		t.Fatalf("setup.sh run 1 recorded %d workflow.changed, want 1", len(got))
	}
	ws, _ := got[0].Payload["workflows"].([]any)
	ids := map[string]string{}
	for _, w := range ws {
		if m, ok := w.(map[string]any); ok {
			name, _ := m["name"].(string)
			id, _ := m["id"].(string)
			ids[name] = id
		}
	}
	if len(ws) != 2 || ids["Software"] != workflow["Work"] || ids["Bugs"] != workflow["Bugs"] {
		t.Fatalf("workflow.changed after run 1 has Workflows %v; want Software %s and Bugs %s", ws, workflow["Work"], workflow["Bugs"])
	}
	last = got[0].Seq

	var after client.Workflows
	ada.json(&after, "workflow", "show", "OLD")
	var task client.TaskDetail
	ada.json(&task, "show", key)
	if deref(task.Task.StepID) != step["Build"] {
		t.Fatalf("%s after the preset: %s, want Build %s", key, where(task), step["Build"])
	}
	stepAfter := map[string]client.WorkflowStep{}
	for _, s := range after.Steps {
		stepAfter[s.Name] = s
	}
	ada.json(&task, "show", reviewing)
	if backlog := stepAfter["Backlog"].ID; backlog == "" || deref(task.Task.StepID) != backlog {
		t.Fatalf("%s, at Review, after the preset: %s, want Backlog %s", reviewing, where(task), backlog)
	}
	ada.json(&task, "show", investigating)
	if deref(task.Task.StepID) != step["Investigate"] {
		t.Fatalf("%s after the preset: %s, want Investigate %s", investigating, where(task), step["Investigate"])
	}
	if s := stepAfter["Investigate"]; s.ID != step["Investigate"] || s.WorkflowID != workflow["Bugs"] {
		t.Fatalf("Investigate after the preset: %+v, want %s in Bugs %s", s, step["Investigate"], workflow["Bugs"])
	}
	if s := stepAfter["Build"]; s.ID != step["Build"] || s.WorkflowID != workflow["Work"] {
		t.Fatalf("Build after the preset: %+v, want %s in Software %s", s, step["Build"], workflow["Work"])
	}
	if _, ok := stepAfter["Review"]; ok {
		t.Fatal("Review, which the preset does not have, is still there")
	}
	kept, repointed, doneKept := false, false, false
	for _, k := range after.Connectors {
		switch k.ID {
		case bug:
			kept = k.Name == "bug" && k.FromStepID == step["Build"] && deref(k.ToStepID) == step["Investigate"]
		case fixed:
			repointed = k.Name == "fixed" && k.FromStepID == step["Investigate"] && deref(k.ToStepID) == stepAfter["Backlog"].ID
		case done.ID:
			doneKept = k.Name == "done" && k.FromStepID == step["Investigate"] && k.ToStepID == nil && k.Position == done.Position
		}
	}
	if !kept {
		t.Fatalf("the crossing bug → Bugs › Investigate (%s) is not kept: %+v", bug, after.Connectors)
	}
	if !repointed {
		t.Fatalf("Investigate's fixed → Review (%s) does not lead into Backlog: %+v", fixed, after.Connectors)
	}
	if !doneKept {
		t.Fatalf("Investigate's done into Done (%s, at %d) is not kept: %+v", done.ID, done.Position, after.Connectors)
	}
	if out := ada.ok("workflow", "show", "OLD"); !strings.Contains(out, "\n      bug → Bugs › Investigate\n") {
		t.Fatalf("workflow show OLD after the preset:\n%s", out)
	}

	// Run 2: nothing written.
	setup(2)
	if got := changes(last); len(got) != 0 {
		t.Fatalf("setup.sh run 2 recorded %d workflow.changed, want none: %+v", len(got), got)
	}

	// Run 3, with Software's QA renamed Testing and a Step of Bugs named qa: refused, naming it,
	// before any write.
	body = client.SetWorkflowBody{}
	if out := ada.ok("workflow", "show", "OLD", "--body"); json.Unmarshal([]byte(out), &body) != nil {
		t.Fatalf("workflow show OLD --body:\n%s", out)
	}
	rename := func(s string) string {
		if s == "QA" {
			return "Testing"
		}
		return s
	}
	for i := range body.Steps {
		body.Steps[i].Name = rename(body.Steps[i].Name)
	}
	for i, k := range body.Connectors {
		body.Connectors[i].From = rename(k.From)
		if k.To != nil {
			body.Connectors[i].To = ptr(rename(*k.To))
		}
	}
	body.Steps = append(body.Steps, client.StepInput{Workflow: "Bugs", Name: "qa", Skill: ptr("engineer"), Position: ptr(int64(2))})
	if b, err = json.Marshal(body); err != nil {
		t.Fatal(err)
	}
	ada.ok("workflow", "set", "OLD", "--file", writeFile(t, filepath.Join(in.dir, "OLD-clash.json"), string(b)))
	var activity client.ActivityPage
	ada.json(&activity, "activity")
	out, err := run()
	if err == nil || !strings.Contains(out, "Bugs › qa") || !strings.Contains(out, `name the Workflow to become Software "Software"`) {
		t.Fatalf("setup.sh with Bugs › qa: %v\n%s", err, out)
	}
	if strings.Contains(out, "skill ") {
		t.Fatalf("setup.sh with Bugs › qa went on before refusing:\n%s", out)
	}
	var since client.ActivityPage
	ada.json(&since, "activity")
	if since.LastSeq != activity.LastSeq {
		t.Fatalf("setup.sh with Bugs › qa recorded Activity: %d → %d", activity.LastSeq, since.LastSeq)
	}
}

func deref64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
