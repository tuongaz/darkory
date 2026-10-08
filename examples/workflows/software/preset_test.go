// Package software holds the software Workflow preset (docs/workflows/software.md); its test keeps
// the preset's files consistent with one another and with the web app's copy of the Workflow.
package software

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"
)

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

// The web app draws the same Workflow the preset sets up: workflow.json is the source.
func TestWebFixtureIsTheWorkflow(t *testing.T) {
	var preset, web any
	readJSON(t, "workflow.json", &preset)
	readJSON(t, "../../../web/src/components/workflowLine/workflows/software.json", &web)
	if !reflect.DeepEqual(preset, web) {
		t.Fatal("web/src/components/workflowLine/workflows/software.json differs from workflow.json; copy workflow.json over it")
	}
}

// Every Skill a Step carries is held by an agent, and every Skill the roster names has its text,
// except the builtin ones Darkory seeds.
func TestRosterCoversTheWorkflow(t *testing.T) {
	var wf struct {
		Steps []struct{ Name, Skill string }
	}
	var roster struct {
		Agents []struct {
			Name   string
			Skills []string
		}
	}
	readJSON(t, "workflow.json", &wf)
	readJSON(t, "agents.json", &roster)
	held := map[string]bool{}
	for _, a := range roster.Agents {
		for _, s := range a.Skills {
			held[s] = true
		}
	}
	builtin := []string{"breakdown", "acceptance", "retro", "skill-review", "engineer", "review"}
	for _, st := range wf.Steps {
		if st.Skill != "" && !held[st.Skill] {
			t.Errorf("no agent holds %s, the Skill of %s", st.Skill, st.Name)
		}
	}
	for s := range held {
		if slices.Contains(builtin, s) {
			continue
		}
		if _, err := os.Stat(s + ".md"); err != nil {
			t.Errorf("%s has no text: %v", s, err)
		}
	}
}
