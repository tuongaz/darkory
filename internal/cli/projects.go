package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
)

// Projects with their Members and Workflows (ADR 0015, ADR 0016), and Labels.

var projectCommands = []command{
	{path: "project create", args: "<KEY> <name> [--workflow default|empty|copy] [--copy-from p] [--member m]… [--workspace ws] [--color 0-11] [--auto-complete] [--acceptance]", short: "create a Project with its first Workflow (admin)", run: cmdProjectCreate},
	{path: "project list", short: "list the Organisation's Projects", run: cmdProjectList},
	{path: "project show", args: "<project>", short: "show a Project, its defaults and its Members", run: cmdProjectShow},
	{path: "project add", args: "<project> <member>", short: "add a Member to a Project (admin)", run: cmdProjectAdd},
	{path: "project remove", args: "<project> <member>", short: "remove a Member from a Project (admin)", run: cmdProjectRemove},
	{path: "project set", args: "<project> [--name n] [--color 0-11] [--workspace ws|\"\"] [--auto-complete=true|false] [--acceptance=true|false]", short: "change a Project's name, colour and the defaults a Task filed in it takes (admin)", run: cmdProjectSet},
	{path: "workflow show", args: "<project> [--workflow w] [--body]", short: "show a Project's Workflows, or one: their Steps, the Skills, the Connectors out of each, and what is at each now", run: cmdWorkflowShow},
	{path: "workflow set", args: "<project> --file path|-", short: "replace a Project's Workflows with the body in a file, as workflow show --body prints it (admin)", run: cmdWorkflowSet},
	{path: "label create", args: "<name> --color #rrggbb [--project p]", short: "define a Label for a Project, or for the Organisation (admin)", run: cmdLabelCreate},
	{path: "label list", args: "[--project p]", short: "list the Organisation's Labels, and a Project's own", run: cmdLabelList},
	{path: "label update", args: "<label> [--name n] [--color #rrggbb] [--project p]", short: "rename or recolour a Label", run: cmdLabelUpdate},
	{path: "label delete", args: "<label> [--project p]", short: "delete a Label, taking it off its Tasks", run: cmdLabelDelete},
	{path: "label set", args: "<task> <label,…|\"\">", short: "set the Labels a Task carries, replacing its others", run: cmdLabelSet},
}

func cmdProjectCreate(c *call) error {
	workflow := c.fs.String("workflow", "", "the first Workflow: default, empty (Backlog into Done), or copy (with --copy-from)")
	copyFrom := c.fs.String("copy-from", "", "the Project whose Steps and Connectors the Workflow copies")
	var members strs
	c.fs.Var(&members, "member", "a Member put in the Project; give it once per Member (you are not added unless named)")
	ws := c.fs.String("workspace", "", "the Workspace a Task filed in the Project names when it names none")
	color := c.fs.Int("color", -1, "the hue of the Project's mark, 0 (red) to 11 (pink); by default the one farthest from its Organisation's other Projects'")
	var auto, acceptance optBool
	c.fs.Var(&auto, "auto-complete", "a Task filed in the Project completes itself when its last Subtask ends Done, unless its filer says")
	c.fs.Var(&acceptance, "acceptance", "a Task filed in the Project has an Acceptance before it is done, unless its filer says")
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	body := client.CreateProjectBody{Key: args[0], Name: args[1], CopyFrom: opt(*copyFrom), DefaultWorkspace: opt(*ws),
		AutoComplete: auto.v, Acceptance: acceptance.v}
	if *color >= 0 {
		body.Color = color
	}
	switch {
	case *workflow != "":
		body.Workflow = ptr(client.NewWorkflow(*workflow))
	case *copyFrom != "":
		body.Workflow = ptr(client.NewWorkflowCopy)
	}
	if members.set {
		body.Members = &members.v
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.CreateProjectWithResponse(c.ctx, &client.CreateProjectParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printProjectDetail(w, *res.JSON201) })
}

func cmdProjectList(c *call) error {
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.ListProjectsWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) {
		if len(res.JSON200.Items) == 0 {
			fmt.Fprintln(w, "No Projects.")
		}
		for _, p := range res.JSON200.Items {
			c.printProjectLine(w, p)
		}
	})
}

func cmdProjectShow(c *call) error {
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetProjectWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printProjectDetail(w, *res.JSON200) })
}

func cmdProjectAdd(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.AddProjectMemberWithResponse(c.ctx, args[0], args[1], &client.AddProjectMemberParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s is in %s.\n", one(args[1]), one(args[0])) })
}

func cmdProjectRemove(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.RemoveProjectMemberWithResponse(c.ctx, args[0], args[1], &client.RemoveProjectMemberParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "%s is no longer in %s.\n", one(args[1]), one(args[0])) })
}

func cmdProjectSet(c *call) error {
	name := c.fs.String("name", "", "the Project's new name")
	color := c.fs.Int("color", -1, "the hue of the Project's mark, 0 (red) to 11 (pink)")
	var ws optString
	c.fs.Var(&ws, "workspace", `the Workspace a Task filed in the Project names when it names none; "" for none`)
	var auto, acceptance optBool
	c.fs.Var(&auto, "auto-complete", "whether a Task filed in the Project completes itself when its last Subtask ends Done, unless its filer says")
	c.fs.Var(&acceptance, "acceptance", "whether a Task filed in the Project has an Acceptance before it is done, unless its filer says")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.UpdateProjectBody{Name: opt(*name), DefaultWorkspace: ws.v, AutoComplete: auto.v, Acceptance: acceptance.v}
	if *color >= 0 {
		body.Color = color
	}
	if body.Name == nil && body.Color == nil && body.DefaultWorkspace == nil && body.AutoComplete == nil && body.Acceptance == nil {
		return usagef("nothing to change: give --name, --color, --workspace, --auto-complete or --acceptance")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.UpdateProjectWithResponse(c.ctx, args[0], &client.UpdateProjectParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printProjectLine(w, *res.JSON200) })
}

// printProjectLine prints a Project with its defaults.
func (c *call) printProjectLine(w io.Writer, p client.Project) {
	line := fmt.Sprintf("%-8s %s", one(p.Key), one(p.Name))
	if p.DefaultWorkspaceID != nil {
		line += "  workspace " + c.workspace(*p.DefaultWorkspaceID)
	}
	if p.AutoComplete {
		line += "  auto-complete"
	}
	if p.Acceptance {
		line += "  acceptance"
	}
	fmt.Fprintln(w, line)
}

func (c *call) printProjectDetail(w io.Writer, d client.ProjectDetail) {
	c.printProjectLine(w, d.Project)
	if len(d.Members) == 0 {
		fmt.Fprintln(w, "  No Members.")
	}
	for _, m := range d.Members {
		fmt.Fprint(w, "  ")
		c.printMemberLine(w, m)
	}
}

func cmdWorkflowShow(c *call) error {
	only := c.fs.String("workflow", "", "only this Workflow, by name or id")
	asBody := c.fs.Bool("body", false, "print the Project's Workflows as the JSON body workflow set reads, with Workflows, Skills and Steps by name, to edit and send back")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *only != "" && *asBody {
		return usagef("--body prints every Workflow, as workflow set takes them all; leave out --workflow")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.GetWorkflowWithResponse(c.ctx, args[0])
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	if *asBody {
		b, err := json.Marshal(c.workflowBody(*res.JSON200))
		if err != nil {
			return err
		}
		return printJSON(c.env.Stdout, b)
	}
	if *only == "" {
		return c.show(res.Body, func(w io.Writer) { c.printWorkflow(w, *res.JSON200) })
	}
	narrowed, ok := oneWorkflow(*res.JSON200, *only)
	if !ok {
		return fmt.Errorf("%s has no Workflow %q", args[0], *only)
	}
	b, err := json.Marshal(narrowed)
	if err != nil {
		return err
	}
	return c.show(b, func(w io.Writer) { c.printWorkflow(w, narrowed) })
}

// oneWorkflow narrows a Project's Workflows to the one named, ignoring case, or given by id in
// either form: its Steps, and the Connectors out of them, wherever they lead.
func oneWorkflow(wf client.Workflows, ref string) (client.Workflows, bool) {
	out := wf
	out.Workflows, out.Steps, out.Connectors = nil, []client.WorkflowStep{}, []client.Connector{}
	for _, w := range wf.Workflows {
		if strings.EqualFold(w.Name, ref) || shortid.Canonical(w.ID) == shortid.Canonical(ref) {
			out.Workflows = []client.Workflow{w}
			break
		}
	}
	if out.Workflows == nil {
		return wf, false
	}
	in := map[string]bool{}
	for _, s := range wf.Steps {
		if s.WorkflowID == out.Workflows[0].ID {
			out.Steps = append(out.Steps, s)
			in[s.ID] = true
		}
	}
	for _, k := range wf.Connectors {
		if in[k.FromStepID] {
			out.Connectors = append(out.Connectors, k)
		}
	}
	return out, true
}

// workflowBody turns a Project's Workflows as read into the body that sets them again, naming
// Workflows, Skills and Steps by name so a person can edit it; ids are kept, so a renamed Step
// stays the same Step.
func (c *call) workflowBody(wf client.Workflows) client.SetWorkflowBody {
	body := client.SetWorkflowBody{Workflows: []client.WorkflowInput{}, Steps: []client.StepInput{}, Connectors: []client.ConnectorInput{}}
	workflows := map[string]string{}
	for _, w := range wf.Workflows {
		workflows[w.ID] = w.Name
		body.Workflows = append(body.Workflows, client.WorkflowInput{ID: ptr(w.ID), Name: w.Name, Position: w.Position})
	}
	names := map[string]string{}
	for _, s := range wf.Steps {
		names[s.ID] = s.Name
		in := client.StepInput{ID: ptr(s.ID), Workflow: workflows[s.WorkflowID], Name: s.Name, Position: s.Position, X: ptr(s.X), Y: ptr(s.Y)}
		if s.SkillID != nil {
			in.Skill = ptr(c.skillName(*s.SkillID))
		}
		body.Steps = append(body.Steps, in)
	}
	for _, k := range wf.Connectors {
		in := client.ConnectorInput{ID: ptr(k.ID), From: names[k.FromStepID], Name: k.Name, Position: k.Position}
		if k.ToStepID != nil {
			in.To = ptr(names[*k.ToStepID])
		}
		body.Connectors = append(body.Connectors, in)
	}
	return body
}

// workflowSetHelp documents the body workflow set reads.
const workflowSetHelp = `the Project's Workflows as JSON; - reads standard input. The body is
{"workflows": [{"id": kept Workflow's id (leave out for a new one, or to keep the one of that name), "name": "Work", "position": 1}…],
 "steps": [{"id": kept Step's id (leave out for a new Step), "workflow": Workflow name or id, "name": "Build", "skill": Skill name or id (leave out for a hold), "position": 1, "x": 0, "y": 0}…],
 "connectors": [{"from": Step name or id, "to": Step name or id in any Workflow (leave out for Done), "name": "pass", "position": 1}…],
 "moves": {deleted Step's id: Step name or id its Tasks go to}}.
A Workflow left out is deleted with its Steps. position places each Workflow, each Step in its
Workflow and each Connector among those out of its Step (1 first, each its own); left out or 0, it
is the item's place in its list. x and y may be left out.
darkory workflow show <project> --body prints the current one`

func cmdWorkflowSet(c *call) error {
	file := c.fs.String("file", "", workflowSetHelp)
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *file == "" {
		return usagef("needs --file")
	}
	var text []byte
	if *file == "-" {
		text, err = io.ReadAll(c.env.Stdin)
	} else {
		text, err = os.ReadFile(*file)
	}
	if err != nil {
		return err
	}
	var body client.SetWorkflowBody
	if err := json.Unmarshal(text, &body); err != nil {
		return usagef("--file is not a Workflow body (see --help): %v", err)
	}
	if body.Workflows == nil {
		body.Workflows = []client.WorkflowInput{}
	}
	if body.Steps == nil {
		body.Steps = []client.StepInput{}
	}
	if body.Connectors == nil {
		body.Connectors = []client.ConnectorInput{}
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.SetWorkflowWithResponse(c.ctx, args[0], &client.SetWorkflowParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printWorkflow(w, *res.JSON200) })
}

// printWorkflow prints each Step in order with its Skill, what is at it now, who can take its
// Tasks, and the Connectors out of it; with two Workflows or more, each Workflow's Steps under its
// name, and a Connector into another Workflow as that Workflow › its Step.
func (c *call) printWorkflow(w io.Writer, wf client.Workflows) {
	if len(wf.Steps) == 0 && len(wf.Workflows) < 2 {
		fmt.Fprintln(w, "No Steps: nothing can be filed in this Project until it has one.")
		return
	}
	names, workflows, of := map[string]string{}, map[string]string{}, map[string]string{}
	for _, x := range wf.Workflows {
		workflows[x.ID] = x.Name
	}
	for _, s := range wf.Steps {
		names[s.ID], of[s.ID] = s.Name, s.WorkflowID
	}
	if len(wf.Workflows) < 2 {
		c.printSteps(w, wf.Steps, wf.Connectors, names, workflows, of)
		return
	}
	for _, x := range wf.Workflows {
		fmt.Fprintln(w, one(x.Name))
		var steps []client.WorkflowStep
		for _, s := range wf.Steps {
			if s.WorkflowID == x.ID {
				steps = append(steps, s)
			}
		}
		if len(steps) == 0 {
			fmt.Fprintln(w, "    No Steps.")
		}
		c.printSteps(w, steps, wf.Connectors, names, workflows, of)
	}
}

// printSteps prints Steps of one Workflow with the Connectors out of each; names, workflows and of
// give every Step's name, every Workflow's name and the Workflow each Step is in.
func (c *call) printSteps(w io.Writer, steps []client.WorkflowStep, connectors []client.Connector, names, workflows, of map[string]string) {
	for _, s := range steps {
		skill := "hold"
		if s.SkillID != nil {
			skill = c.skill(*s.SkillID)
		}
		line := fmt.Sprintf("%-3d %-16s %-16s %d waiting, %d working", s.Position, one(s.Name), skill, s.Tasks-s.Working, s.Working)
		switch {
		case s.SkillID == nil:
		case len(s.Takers) == 0:
			line += "  nobody holds its Skill"
		default:
			line += "  taken by " + names2(s.Takers)
		}
		if s.MedianMs != nil {
			line += fmt.Sprintf("  median %s", humanMS(*s.MedianMs))
		}
		fmt.Fprintln(w, line)
		for _, k := range connectors {
			if k.FromStepID != s.ID {
				continue
			}
			to := "Done"
			if k.ToStepID != nil {
				to = target(s.WorkflowID, of[*k.ToStepID], workflows[of[*k.ToStepID]], names[*k.ToStepID])
			}
			fmt.Fprintf(w, "      %s → %s\n", one(k.Name), to)
		}
	}
}

// target names the Step a Connector leads to for human output: the Step alone within the
// Workflow it leads out of, and as Workflow › Step into another.
func target(fromWorkflow, toWorkflow, workflow, step string) string {
	if toWorkflow == "" || toWorkflow == fromWorkflow || workflow == "" {
		return one(step)
	}
	return one(workflow) + " › " + one(step)
}

func names2(ts []client.Taker) string {
	return names(ts, func(t client.Taker) string {
		if t.Kind == client.Agent {
			return t.Name + " (agent)"
		}
		return t.Name
	})
}

// humanMS says a duration in milliseconds the way a person reads it.
func humanMS(ms int64) string {
	switch s := ms / 1000; {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 48*3600:
		return fmt.Sprintf("%dh%02dm", s/3600, s%3600/60)
	default:
		return fmt.Sprintf("%dd", s/86400)
	}
}

func cmdLabelCreate(c *call) error {
	color := c.fs.String("color", "", "the Label's colour, #rrggbb")
	project := c.fs.String("project", "", "the Project the Label is for (default: the Organisation, for every Project; admin)")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if *color == "" {
		return usagef("needs --color #rrggbb")
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	body := client.CreateLabelBody{Name: args[0], Color: *color}
	var raw []byte
	var l *client.Label
	if *project != "" {
		res, err := conn.CreateProjectLabelWithResponse(c.ctx, *project, &client.CreateProjectLabelParams{}, body)
		if err := check(res, err, http.StatusCreated); err != nil {
			return err
		}
		raw, l = res.Body, res.JSON201
	} else {
		res, err := conn.CreateLabelWithResponse(c.ctx, &client.CreateLabelParams{}, body)
		if err := check(res, err, http.StatusCreated); err != nil {
			return err
		}
		raw, l = res.Body, res.JSON201
	}
	return c.show(raw, func(w io.Writer) { c.printLabel(w, *l) })
}

func cmdLabelList(c *call) error {
	project := c.fs.String("project", "", "list this Project's own Labels after the Organisation's")
	if _, err := c.args(0, 0); err != nil {
		return err
	}
	if _, err := c.dial(oneOff); err != nil {
		return err
	}
	ls, raw, err := c.labelsOf(*project)
	if err != nil {
		return err
	}
	return c.show(raw, func(w io.Writer) {
		if len(ls) == 0 {
			fmt.Fprintln(w, "No Labels.")
		}
		for _, l := range ls {
			c.printLabel(w, l)
		}
	})
}

// labelsOf lists the Organisation's Labels and, when project is set, the Project's own after them.
// raw is the reply as --json prints it: {"items": […]}.
func (c *call) labelsOf(project string) ([]client.Label, []byte, error) {
	res, err := c.conn.ListLabelsWithResponse(c.ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return nil, nil, err
	}
	ls := res.JSON200.Items
	if project != "" {
		pres, err := c.conn.ListProjectLabelsWithResponse(c.ctx, project)
		if err := check(pres, err, http.StatusOK); err != nil {
			return nil, nil, err
		}
		ls = append(ls, pres.JSON200.Items...)
	}
	raw, err := json.Marshal(client.LabelList{Items: ls})
	return ls, raw, err
}

// labelID finds the Label ref names, by id or by name ignoring case, among the Organisation's and
// the Project's own.
func (c *call) labelID(ref, project string) (string, error) {
	ls, _, err := c.labelsOf(project)
	if err != nil {
		return "", err
	}
	for _, l := range ls {
		if l.ID == shortid.Short(ref) || strings.EqualFold(l.Name, ref) { // an id in either form
			return l.ID, nil
		}
	}
	if project == "" {
		return "", fmt.Errorf("no Label %q in the Organisation (a Project's own needs --project)", ref)
	}
	return "", fmt.Errorf("no Label %q in the Organisation or %s", ref, project)
}

func cmdLabelUpdate(c *call) error {
	name := c.fs.String("name", "", "the Label's new name")
	color := c.fs.String("color", "", "the Label's new colour, #rrggbb")
	project := c.fs.String("project", "", "the Project whose own Label it is, to find it by name")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	body := client.UpdateLabelBody{Name: opt(*name), Color: opt(*color)}
	if body.Name == nil && body.Color == nil {
		return usagef("nothing to change: give --name or --color")
	}
	if _, err := c.dial(oneOff); err != nil {
		return err
	}
	id, err := c.labelID(args[0], *project)
	if err != nil {
		return err
	}
	res, err := c.conn.UpdateLabelWithResponse(c.ctx, id, &client.UpdateLabelParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.printLabel(w, *res.JSON200) })
}

func cmdLabelDelete(c *call) error {
	project := c.fs.String("project", "", "the Project whose own Label it is, to find it by name")
	args, err := c.args(1, 1)
	if err != nil {
		return err
	}
	if _, err := c.dial(oneOff); err != nil {
		return err
	}
	id, err := c.labelID(args[0], *project)
	if err != nil {
		return err
	}
	res, err := c.conn.DeleteLabelWithResponse(c.ctx, id, &client.DeleteLabelParams{})
	if err := check(res, err, http.StatusNoContent); err != nil {
		return err
	}
	return c.show(nil, func(w io.Writer) { fmt.Fprintf(w, "Deleted Label %s.\n", one(args[0])) })
}

func cmdLabelSet(c *call) error {
	args, err := c.args(2, 2)
	if err != nil {
		return err
	}
	labels := []string{}
	for _, l := range strings.Split(args[1], ",") {
		if l = strings.TrimSpace(l); l != "" {
			labels = append(labels, l)
		}
	}
	conn, err := c.dial(oneOff)
	if err != nil {
		return err
	}
	res, err := conn.SetTaskLabelsWithResponse(c.ctx, args[0], &client.SetTaskLabelsParams{}, client.SetTaskLabelsBody{Labels: labels})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	return c.show(res.Body, func(w io.Writer) { c.done(w, "Labelled", *res.JSON200) })
}

func (c *call) printLabel(w io.Writer, l client.Label) {
	whose := "Organisation"
	if l.ProjectID != nil {
		whose = c.project(*l.ProjectID)
	}
	fmt.Fprintf(w, "%-20s %s  %-12s %s\n", one(l.Name), one(l.Color), whose, one(l.ID))
}
