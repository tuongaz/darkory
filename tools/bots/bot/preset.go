package bot

import (
	"strconv"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Preset is a ready-made Organisation for the bots to work: the Projects, Skills, Workflows and
// Workspaces Setup makes, the agent Members and human personas who work in it, and the Tasks its
// owner files, each with the Subtasks filed for it.
type Preset struct {
	Name string
	// Projects are the Projects Setup makes; the first is where the bots' Tasks go unless a
	// template names another.
	Projects []ProjectSpec
	// Skills are made when missing, a generic Skill before an own Skill built on it. Darkory
	// has breakdown, acceptance, retro and skill-review built in, and init makes engineer and
	// review.
	Skills []client.CreateSkillBody
	// Workflows are the Workflows Setup gives each of the preset's Projects, in order.
	Workflows []WorkflowSpec
	// Workspaces are made when missing, each a throwaway git repository.
	Workspaces []WorkspaceSpec
	// Agents are the bots, as agent Members.
	Agents []Spec
	// Humans are the human personas Setup makes and runs when asked to (Options.Personas).
	Humans []Persona
	// Manager is the persona every agent reports to, and the one who owns the Tasks the bots'
	// owner files; Ask is the one questions are aimed at, unless an Item names another.
	Manager, Ask string
	// Answer is what Ask answers a question no Item carries.
	Answer string
	// Tasks are what the owner files, in turn.
	Tasks []TaskTemplate
	// Plan is the plan the planner files under a Parent no template with Items matches.
	Plan func(parent, ask string) []Item
	// Evidence is the file a worker attaches to a Task whose Item names no workpaper, by the
	// Skill of the Step it works the Task at.
	Evidence func(d *client.TaskDetail, skill string) (name, content string)
	// Chores are Tasks the owner keeps open, each alone at its Step, for the bots that take them.
	Chores []Chore
}

// ProjectSpec is a Project a preset makes, with the defaults Setup gives it: the Workspace a Task
// filed in it names when it names none, and whether its Parents complete themselves when their
// last Subtask ends Done. An empty DefaultWorkspace, or a false AutoComplete, leaves the
// Project's own setting as it is.
type ProjectSpec struct {
	Key, Name        string
	DefaultWorkspace string
	AutoComplete     bool
}

// WorkflowSpec is a Workflow by names: its name, its Steps in order, and the Connectors out of
// them, each Step's in the order its holder is offered them.
type WorkflowSpec struct {
	Name       string
	Steps      []StepSpec
	Connectors []ConnectorSpec
}

// StepSpec is a Step: its name and the Skill it carries; no Skill makes it a hold.
type StepSpec struct {
	Name, Skill string
}

// ConnectorSpec is a named way out of the Step From, into the Step To, or into Done when To is
// empty.
type ConnectorSpec struct {
	From, To, Name string
}

// Hold is the first hold of the preset's Workflows, in the Project's order, where work is filed
// ahead until a person moves it on; "" when they have none.
func (p *Preset) Hold() string {
	for _, w := range p.Workflows {
		for _, s := range w.Steps {
			if s.Skill == "" {
				return s.Name
			}
		}
	}
	return ""
}

// WorkspaceSpec is a git Workspace a preset makes: a repository whose first commit holds Files,
// by path from its root.
type WorkspaceSpec struct {
	Name  string
	Files map[string]string
}

// Persona is a human Member the bots act as, through a token of their own. One who Answers takes
// the questions aimed at them and answers each after a while; one who Works a Skill takes the
// Tasks at its Steps from their takeable list and does them, as an agent would; one who Owns
// completes the Parents they own once every Subtask has ended, and moves one Task a round out of
// the hold, the intake, to the Step it is for.
type Persona struct {
	Name     string
	Answers  bool
	Owns     bool
	Works    []string
	Skills   []string
	Projects []string
}

// TaskTemplate is a Task the owner files: its Project, title and description, and what comes
// with it. With Breakdown, it is filed with Break down on and the planner files its Subtasks from
// Items (or the preset's Plan); with Alone, it is one Task, worked as Items[0] says from the
// Step Items[0] names; otherwise it is a Parent whose Items File files as its Subtasks.
// AutoComplete has a Parent complete itself when its last Subtask ends Done.
type TaskTemplate struct {
	Project      string
	Title        string
	Description  string
	Breakdown    bool
	Alone        bool
	AutoComplete bool
	Items        []Item
}

// Chore is a Task the owner keeps open, alone at the Step named Step, in the Project Project.
type Chore struct {
	Project, Step, Title string
}

// Question is what a worker asks while working an Item, aimed at a Member by name (the preset's
// Ask when empty), blocking its own Task until it is answered. Step, when set, is the Step at
// which it is asked; otherwise the first at which the Item is worked.
type Question struct {
	AimedAt, Title, Answer, Step string
}

// Template returns the template a Task was filed from, by its title: the template's own, or with
// a number after it, as the owner files a template again. It returns nil for any other.
func (p *Preset) Template(title string) *TaskTemplate {
	if p == nil {
		return nil
	}
	for i := range p.Tasks {
		t := &p.Tasks[i]
		if title == t.Title {
			return t
		}
		if n, ok := strings.CutPrefix(title, t.Title+" "); ok {
			if _, err := strconv.Atoi(n); err == nil {
				return t
			}
		}
	}
	return nil
}

// item returns the Item a Task asks of whoever works it: the one Item of a Task filed alone, or
// the Item of its Parent's plan with its title; nil when there is none, as for a Breakdown or a
// question.
func (p *Preset) item(parent, task, ask string) *Item {
	if parent == "" {
		if t := p.Template(task); t != nil && t.Alone && len(t.Items) > 0 {
			return &t.Items[0]
		}
		return nil
	}
	items := p.plan(parent, ask)
	for i := range items {
		if items[i].Title == task {
			return &items[i]
		}
	}
	return nil
}

// answer is what the Member a question titled title is aimed at answers.
func (p *Preset) answer(title string) string {
	for _, t := range p.Tasks {
		for _, s := range t.Items {
			if s.Question != nil && s.Question.Title == title && s.Question.Answer != "" {
				return s.Question.Answer
			}
		}
	}
	return or(p.Answer, "Go ahead as you suggest.")
}

// plan is the plan filed under the Parent titled parent: its template's Items, else the preset's
// Plan.
func (p *Preset) plan(parent, ask string) []Item {
	if p == nil {
		return DefaultPlan(parent, ask)
	}
	if t := p.Template(parent); t != nil && !t.Alone && len(t.Items) > 0 {
		return t.Items
	}
	if p.Plan != nil {
		return p.Plan(parent, ask)
	}
	return DefaultPlan(parent, ask)
}

// Presets are the presets tools/bots runs, by name.
var Presets = map[string]*Preset{"software": &Software, "accounting": &Accounting}

// The software preset's Steps.
const (
	StepBacklog     = "Backlog"
	StepPlan        = "Plan"
	StepBuild       = "Build"
	StepDocs        = "Docs"
	StepQA          = "QA"
	StepReview      = "Review"
	StepTriage      = "Triage"
	StepDeploy      = "Deploy"
	StepRetro       = "Retro"
	StepSkillReview = "Skill review"
)

// SoftwareWorkflow is the software preset's Workflow, Work, for both its Projects: Backlog, a
// hold, then a Step for each kind of work. A build goes to review; review passes it into Done or sends it
// back; a Retrospective proposes a Skill version for Skill review, which publishes it.
var SoftwareWorkflow = WorkflowSpec{
	Name: "Work",
	Steps: []StepSpec{{StepBacklog, ""}, {StepPlan, SkillBreakdown}, {StepBuild, SkillOwn}, {StepDocs, SkillDocs}, {StepQA, SkillQA},
		{StepReview, SkillReview}, {StepTriage, SkillTriage}, {StepDeploy, SkillDeploy}, {StepRetro, SkillRetro}, {StepSkillReview, SkillSkillReview}},
	Connectors: []ConnectorSpec{
		{StepPlan, "", "done"},
		{StepBuild, StepReview, "pass"},
		{StepDocs, "", "done"},
		{StepQA, "", "done"},
		{StepReview, "", "pass"}, {StepReview, StepBuild, "needs changes"},
		{StepTriage, "", "done"},
		{StepDeploy, "", "done"},
		{StepRetro, StepSkillReview, "propose"}, {StepRetro, "", "done"},
		{StepSkillReview, "", "publish"}, {StepSkillReview, StepRetro, "needs changes"},
	},
}

// Software is the software crew: Projects WEB and OPS; a planner, two builders, a reviewer, a
// retro, a lapser, a stuck agent and a backlog prober; kai, who owns the work and directs the
// agents, and mai, who answers their questions. Its Tasks are broken down by DefaultPlan.
var Software = Preset{
	Name:      "software",
	Projects:  []ProjectSpec{{Key: "WEB", Name: "Web"}, {Key: "OPS", Name: "Ops"}},
	Skills:    skills,
	Workflows: []WorkflowSpec{SoftwareWorkflow},
	Agents:    Roster,
	Humans:    []Persona{{Name: "kai", Owns: true, Projects: []string{"WEB"}}, {Name: "mai", Answers: true, Projects: []string{"WEB"}}},
	Manager:   "kai",
	Ask:       "mai",
	Answer:    "Yes, as long as nothing is saved to their account.",
	Tasks:     softwareTasks(),
	Plan:      DefaultPlan,
	Evidence:  evidence,
	Chores:    []Chore{{Project: "OPS", Step: StepTriage, Title: "Rotate the logs"}, {Project: "OPS", Step: StepDeploy, Title: "Deploy to staging"}},
}

// softwareTasks are the Tasks the software owner files, in turn, each broken down by the planner.
func softwareTasks() []TaskTemplate {
	var out []TaskTemplate
	for _, t := range []string{"Checkout", "Search", "Saved baskets", "Order history", "Gift cards", "Returns", "Wishlists",
		"Store pickup", "Coupons", "Product reviews"} {
		out = append(out, TaskTemplate{Project: "WEB", Title: t, Description: "Customers can use " + strings.ToLower(t) + ".", Breakdown: true})
	}
	return out
}
