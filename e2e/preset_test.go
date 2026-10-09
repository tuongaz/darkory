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

// The software preset's setup.sh, run twice on a Project with two Workflows (ADR 0019): the first
// run turns the Project's Workflow into Software, keeping its id and the Steps it shares by name,
// and leaves Bugs, its Step and the Connector crossing into it as they were; the second writes
// nothing.
func TestSoftwarePresetKeepsOtherWorkflows(t *testing.T) {
	in := newInstall(t)
	ada := in.ada
	in.project("OLD", "Old", "")

	var filed client.TaskDetail
	ada.json(&filed, "file", "--project", "OLD", "--title", "Short links expire", "--step", "Build")
	key := filed.Task.Key
	if filed.Step == nil || filed.Step.Name != "Build" {
		t.Fatalf("%s was filed at %s", key, where(filed))
	}

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
	body.Connectors = append(body.Connectors, client.ConnectorInput{From: "Build", To: ptr("Investigate"), Name: "bug", Position: ptr(fromBuild + 1)})
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	ada.ok("workflow", "set", "OLD", "--file", writeFile(t, filepath.Join(in.dir, "OLD-bugs.json"), string(b)))

	var before client.Workflows
	ada.json(&before, "workflow", "show", "OLD")
	workflow, step := map[string]string{}, map[string]string{}
	for _, w := range before.Workflows {
		workflow[w.Name] = w.ID
	}
	for _, s := range before.Steps {
		step[s.Name] = s.ID
	}
	bug := ""
	for _, k := range before.Connectors {
		if k.Name == "bug" && k.FromStepID == step["Build"] && deref(k.ToStepID) == step["Investigate"] {
			bug = k.ID
		}
	}
	if workflow["Work"] == "" || workflow["Bugs"] == "" || step["Investigate"] == "" || bug == "" {
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
	setup := func(run int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "bash", script)
		cmd.Env = append(ada.env(), "DARKORY="+bin, "DATA="+in.dir, "PROJECT=OLD")
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Run(); err != nil {
			t.Fatalf("setup.sh, run %d: %v\n%s", run, err, out.String())
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
			ids[m["name"].(string)], _ = m["id"].(string)
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
	if s := stepAfter["Investigate"]; s.ID != step["Investigate"] || s.WorkflowID != workflow["Bugs"] {
		t.Fatalf("Investigate after the preset: %+v, want %s in Bugs %s", s, step["Investigate"], workflow["Bugs"])
	}
	if s := stepAfter["Build"]; s.ID != step["Build"] || s.WorkflowID != workflow["Work"] {
		t.Fatalf("Build after the preset: %+v, want %s in Software %s", s, step["Build"], workflow["Work"])
	}
	if _, ok := stepAfter["Review"]; ok {
		t.Fatal("Review, which the preset does not have, is still there")
	}
	kept := false
	for _, k := range after.Connectors {
		if k.ID == bug {
			kept = k.Name == "bug" && k.FromStepID == step["Build"] && deref(k.ToStepID) == step["Investigate"]
		}
	}
	if !kept {
		t.Fatalf("the crossing bug → Bugs › Investigate (%s) is not kept: %+v", bug, after.Connectors)
	}
	if out := ada.ok("workflow", "show", "OLD"); !strings.Contains(out, "\n      bug → Bugs › Investigate\n") {
		t.Fatalf("workflow show OLD after the preset:\n%s", out)
	}

	// Run 2: nothing written.
	setup(2)
	if got := changes(last); len(got) != 0 {
		t.Fatalf("setup.sh run 2 recorded %d workflow.changed, want none: %+v", len(got), got)
	}
}

func deref64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
