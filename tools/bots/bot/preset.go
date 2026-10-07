package bot

import (
	"strconv"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// Preset is a ready-made Organisation for the bots to work: the Teams, Skills, Statuses and
// Workspaces Setup makes, the agent Members and human personas who work in it, and the Features
// its owner files, each with the Tasks the planner files for it.
type Preset struct {
	Name string
	// Teams are the Teams Setup makes; the first is where the bots' Features go unless a
	// template names another.
	Teams []TeamSpec
	// Skills are made when missing, a generic Skill before a company Skill built on it. Darkory
	// has breakdown, retro and skill-review built in.
	Skills []client.CreateSkillBody
	// Statuses is the Organisation's whole list as Setup leaves it, in order, kinds included;
	// nil keeps the list the Organisation has.
	Statuses []client.StatusInput
	// Workspaces are made when missing, each a throwaway git repository.
	Workspaces []WorkspaceSpec
	// Agents are the bots, as agent Members.
	Agents []Spec
	// Humans are the human personas Setup makes and runs when asked to (Options.Personas).
	Humans []Persona
	// Manager is the persona every agent reports to, and the one who owns the Features the bots'
	// owner files; Ask is the one their questions are aimed at, unless a Step names another.
	Manager, Ask string
	// Answer is what Ask answers a question no Step carries.
	Answer string
	// Features are what the owner files, in turn.
	Features []FeatureTemplate
	// Plan is the plan the planner files for a Feature no template with Tasks matches.
	Plan func(f client.Feature, ask string) []Step
	// Evidence is the file a worker attaches to a Task whose Step names no workpaper, by the
	// Skill it holds the Task under.
	Evidence func(d *client.TaskDetail, skill string) (name, content string)
	// Chores are Tasks the owner keeps open in a Chores Feature of their Team, for the bots that
	// take them alone.
	Chores []Chore
}

// TeamSpec is a Team a preset makes, with the defaults Setup gives it: the Workspace a Task filed
// in it names when it names none, and whether its Features ship when done. An empty
// DefaultWorkspace, or a false ShipWhenDone, leaves the Team's own setting as it is.
type TeamSpec struct {
	Key, Name        string
	DefaultWorkspace string
	ShipWhenDone     bool
}

// WorkspaceSpec is a git Workspace a preset makes: a repository whose first commit holds Files,
// by path from its root.
type WorkspaceSpec struct {
	Name  string
	Files map[string]string
}

// Persona is a human Member the bots act as, through a token of their own. One who Answers takes
// the questions aimed at them and answers each after a while; one who Works a Skill takes its
// Tasks from their takeable list and does them; one who Owns ships the Features they own once
// every Task has ended, and moves one Backlog Task to Todo a round.
type Persona struct {
	Name    string
	Answers bool
	Owns    bool
	Works   []string
	Skills  []string
	Teams   []string
}

// FeatureTemplate is a Feature the owner files: its Team, title and description, whether it is a
// quick Feature and whether it ships when done, and the Tasks the planner files for it. A quick
// Feature has one Task, which Darkory files with it under the Feature's title, needing the
// Skill of Tasks[0], in its Workspaces.
type FeatureTemplate struct {
	Team         string
	Title        string
	Description  string
	Quick        bool
	ShipWhenDone bool
	Tasks        []Step
}

// Chore is a Task the owner keeps open, needing Skill, in the Team's Chores Feature.
type Chore struct {
	Team, Skill, Title string
}

// Question is what a worker asks while working a Step, aimed at a Member by name (the preset's
// Ask when empty), blocking its own Task until it is answered.
type Question struct {
	AimedAt, Title, Answer string
}

// Template returns the template a Feature was filed from, by its title: the template's own, or
// with a number after it, as the owner files a template again. It returns nil for any other.
func (p *Preset) Template(title string) *FeatureTemplate {
	if p == nil {
		return nil
	}
	for i := range p.Features {
		t := &p.Features[i]
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

// step returns the Step of f's plan whose title is task, or the one Task of a quick Feature; nil
// when there is none, as for a Break down or a question.
func (p *Preset) step(f client.Feature, task, ask string) *Step {
	if t := p.Template(f.Title); t != nil && t.Quick {
		if len(t.Tasks) == 0 {
			return nil
		}
		return &t.Tasks[0]
	}
	steps := p.plan(f, ask)
	for i := range steps {
		if steps[i].Title == task {
			return &steps[i]
		}
	}
	return nil
}

// answer is what the Member a question titled title is aimed at answers.
func (p *Preset) answer(title string) string {
	for _, t := range p.Features {
		for _, s := range t.Tasks {
			if s.Question != nil && s.Question.Title == title && s.Question.Answer != "" {
				return s.Question.Answer
			}
		}
	}
	return or(p.Answer, "Go ahead as you suggest.")
}

// plan is the plan the planner files for f: its template's Tasks, else the preset's Plan.
func (p *Preset) plan(f client.Feature, ask string) []Step {
	if p == nil {
		return DefaultPlan(f, ask)
	}
	if t := p.Template(f.Title); t != nil && !t.Quick && len(t.Tasks) > 0 {
		return t.Tasks
	}
	if p.Plan != nil {
		return p.Plan(f, ask)
	}
	return DefaultPlan(f, ask)
}

// Presets are the presets tools/bots runs, by name.
var Presets = map[string]*Preset{"software": &Software}

// Software is the software team: Teams WEB and OPS; a planner, two builders, a reviewer, a retro,
// a lapser, a stuck agent and a backlog prober; kai, who owns the work and directs the agents,
// and mai, who answers their questions. Its Features are broken down by DefaultPlan.
var Software = Preset{
	Name:     "software",
	Teams:    []TeamSpec{{Key: "WEB", Name: "Web"}, {Key: "OPS", Name: "Ops"}},
	Skills:   skills,
	Agents:   Roster,
	Humans:   []Persona{{Name: "kai", Owns: true, Teams: []string{"WEB"}}, {Name: "mai", Answers: true, Teams: []string{"WEB"}}},
	Manager:  "kai",
	Ask:      "mai",
	Answer:   "Yes, as long as nothing is saved to their account.",
	Features: softwareFeatures(),
	Plan:     DefaultPlan,
	Evidence: evidence,
	Chores:   []Chore{{Team: "OPS", Skill: SkillTriage, Title: "Rotate the logs"}, {Team: "OPS", Skill: SkillDeploy, Title: "Deploy to staging"}},
}

// softwareFeatures are the Features the software owner files, in turn.
func softwareFeatures() []FeatureTemplate {
	var out []FeatureTemplate
	for _, t := range []string{"Checkout", "Search", "Saved baskets", "Order history", "Gift cards", "Returns", "Wishlists",
		"Store pickup", "Coupons", "Product reviews"} {
		out = append(out, FeatureTemplate{Team: "WEB", Title: t, Description: "Customers can use " + strings.ToLower(t) + "."})
	}
	return out
}
