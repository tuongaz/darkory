package bot

import (
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
)

// project is a Project's Workflows, each named with its Steps, in order; a Workflow's id is its
// name in lower case.
type project []struct {
	name  string
	steps []string
}

func (p project) workflows() client.Workflows {
	var wf client.Workflows
	for i, w := range p {
		id := strings.ToLower(w.name)
		wf.Workflows = append(wf.Workflows, client.Workflow{ID: id, Name: w.name, Position: int64(i + 1)})
		for j, s := range w.steps {
			wf.Steps = append(wf.Steps, client.WorkflowStep{ID: id + "/" + s, WorkflowID: id, Name: s, Position: int64(j + 1)})
		}
	}
	return wf
}

func spec(name string, steps ...string) WorkflowSpec {
	w := WorkflowSpec{Name: name}
	for _, s := range steps {
		w.Steps = append(w.Steps, StepSpec{Name: s})
	}
	return w
}

func TestBindWorkflows(t *testing.T) {
	type wf = struct {
		name  string
		steps []string
	}
	for _, tc := range []struct {
		name string
		have project
		want []WorkflowSpec
		ids  []string
	}{
		{"the only Workflow for the only one wanted, sharing nothing",
			project{wf{"Work", []string{"Plan"}}}, []WorkflowSpec{spec("Software", "Build")}, []string{"work"}},
		{"the Workflow holding most of its Steps",
			project{wf{"Work", []string{"Backlog", "Build"}}, wf{"Bugs", []string{"Investigate"}}},
			[]WorkflowSpec{spec("Software", "backlog", "BUILD", "Review")}, []string{"work"}},
		{"each by its Steps, whatever their order",
			project{wf{"Bugs", []string{"Investigate"}}, wf{"Work", []string{"Build"}}},
			[]WorkflowSpec{spec("Software", "Build"), spec("Bugs", "Investigate")}, []string{"work", "bugs"}},
		{"by name, ignoring case, when no Steps are shared",
			project{wf{"ops", nil}, wf{"Work", []string{"Build"}}},
			[]WorkflowSpec{spec("Work", "Build"), spec("Ops", "Deploy")}, []string{"work", "ops"}},
		{"a tie in Steps goes to the name",
			project{wf{"A", []string{"X"}}, wf{"B", []string{"Y"}}},
			[]WorkflowSpec{spec("B", "X", "Y")}, []string{"b"}},
		{"the binding sharing the most Steps in all",
			project{wf{"A", []string{"X", "Y"}}, wf{"B", []string{"Z"}}},
			[]WorkflowSpec{spec("W0", "Z", "X"), spec("W1", "Y")}, []string{"b", "a"}},
		{"Steps before the name",
			project{wf{"Work", []string{"Build"}}},
			[]WorkflowSpec{spec("Software", "Build"), spec("Work", "Ops")}, []string{"work", ""}},
		{"three there, two wanted",
			project{wf{"Work", []string{"Build"}}, wf{"Bugs", []string{"Investigate"}}, wf{"Ops", []string{"Deploy"}}},
			[]WorkflowSpec{spec("Software", "Build"), spec("Incidents", "Deploy")}, []string{"work", "ops"}},
		{"one there, two wanted",
			project{wf{"Work", []string{"Build"}}},
			[]WorkflowSpec{spec("Ops", "Deploy"), spec("Software", "Build")}, []string{"", "work"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := bindWorkflows(tc.have.workflows(), tc.want)
			if !slices.Equal(got, tc.ids) {
				t.Fatalf("bound %q, want %q", got, tc.ids)
			}
			seen := map[string]bool{}
			for _, id := range got {
				if id != "" && seen[id] {
					t.Fatalf("bound %q: %s twice", got, id)
				}
				seen[id] = true
			}
		})
	}
}
