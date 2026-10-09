package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"

	"github.com/tuongaz/darkory/client"
)

// The Skills the software bots need. Darkory has breakdown, acceptance, retro and skill-review
// built in.
const (
	SkillBuild       = "build"
	SkillCompany     = "build-acme" // the company Skill the builders work under, which a Retrospective improves
	SkillReview      = "review"
	SkillQA          = "qa"
	SkillDocs        = "docs"
	SkillTriage      = "triage" // the lapser's alone, so no other bot takes its Task
	SkillDeploy      = "deploy" // Stuck's alone
	SkillBreakdown   = "breakdown"
	SkillRetro       = "retro"
	SkillSkillReview = "skill-review"
)

// skills are the Skills the software preset makes when missing, generic ones before the company
// Skill on them.
var skills = []client.CreateSkillBody{
	{Name: SkillBuild, Kind: client.Generic, Body: "Build what the Task describes, test it, and attach the test log."},
	{Name: SkillCompany, Kind: client.Company, BaseSkill: ptr(SkillBuild), Body: "Build it the Acme way: small commits, tests first, the log attached."},
	{Name: SkillReview, Kind: client.Generic, Body: "Read the change and its Evidence; complete with what you checked."},
	{Name: SkillQA, Kind: client.Generic, Body: "Try the change end to end and say what worked."},
	{Name: SkillDocs, Kind: client.Generic, Body: "Write the help page or the demo the Task asks for."},
	{Name: SkillTriage, Kind: client.Generic, Body: "Look into a flaky job."},
	{Name: SkillDeploy, Kind: client.Generic, Body: "Deploy and watch it settle."},
}

// Role is what a bot does.
type Role string

const (
	RolePlanner  Role = "planner"
	RoleBuilder  Role = "builder"
	RoleReviewer Role = "reviewer"
	RoleRetro    Role = "retro"
	RoleLapser   Role = "lapser"
	RoleStuck    Role = "stuck"
	RoleProber   Role = "prober"
)

// Spec is one bot's agent Member: its role, the keys of its preset's Projects it is in, its
// Skills and the model label it reports.
type Spec struct {
	Name     string
	Role     Role
	Projects []string
	Skills   []string
	Model    string
}

// Roster is every bot of the software preset.
var Roster = []Spec{
	{Name: "planner", Role: RolePlanner, Projects: []string{"WEB"}, Skills: []string{SkillBreakdown}, Model: "claude-opus-5-5"},
	{Name: "builder-1", Role: RoleBuilder, Projects: []string{"WEB"}, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-sonnet-5-5"},
	{Name: "builder-2", Role: RoleBuilder, Projects: []string{"WEB"}, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-opus-5-5"},
	{Name: "reviewer", Role: RoleReviewer, Projects: []string{"WEB", "OPS"}, Skills: []string{SkillReview, SkillSkillReview}, Model: "claude-opus-5-5"},
	{Name: "retro", Role: RoleRetro, Projects: []string{"WEB"}, Skills: []string{SkillRetro}, Model: "claude-sonnet-5-5"},
	{Name: "lapser", Role: RoleLapser, Projects: []string{"OPS"}, Skills: []string{SkillTriage}, Model: "claude-haiku-4-5"},
	{Name: "stuck", Role: RoleStuck, Projects: []string{"OPS"}, Skills: []string{SkillDeploy}, Model: "claude-haiku-4-5"},
	{Name: "prober", Role: RoleProber, Projects: []string{"WEB"}, Skills: []string{SkillDocs}, Model: "claude-haiku-4-5"},
}

// Options says what Setup makes and where.
type Options struct {
	// Preset is the Organisation to make; Software when nil.
	Preset *Preset
	// Project and ProjectName, when set, rename the preset's first Project, whose Tasks the bots
	// plan, build and review; Ops and OpsName its second, whose chores the lapser and Stuck take.
	Project, ProjectName, Ops, OpsName string
	// Manager is the Member every agent reports to, who may take back their Claims: the
	// preset's Manager with Personas, else the admin, when empty.
	Manager string
	// Ask is the Member the agents' questions are aimed at unless a Step names another: the
	// preset's Ask with Personas, else the Manager, when empty.
	Ask string
	// Humans are human Members Setup creates when missing and adds to Project.
	Humans []string
	// Personas makes the preset's human personas, in their Projects with their Skills, and
	// issues each a token, so Bots runs them too; the Tasks the owner files are then the persona
	// Manager's.
	Personas bool
	// WorkspaceRoot is the directory Setup makes a missing Workspace's repository in, at
	// <WorkspaceRoot>/<name>.
	WorkspaceRoot string
	// Timeout is the default heartbeat timeout, in seconds, of the tokens Setup issues; TokenName
	// is their name.
	Timeout   int
	TokenName string
}

// Crew is what Setup made: the Organisation's admin and a Member, with a fresh token and Session,
// for every Spec of the preset's Agents and, with Personas, every persona.
type Crew struct {
	Options
	Preset *Preset
	Admin  client.Member
	// Owner is the Member who owns the Tasks the bots' owner files: the persona who owns with
	// Personas, else the admin.
	Owner   string
	Members map[string]Member
	// Personas are the human personas Setup issued tokens to.
	Personas []Persona
	// Workspaces are the preset's Workspaces, by name.
	Workspaces map[string]client.Workspace
	// Tokens are the ids of the tokens Setup issued.
	Tokens []string
	// keys maps the preset's Project keys to the Projects Setup made.
	keys map[string]string
}

// ProjectKey is the key of the Project Setup made for the preset's Project key.
func (crew *Crew) ProjectKey(key string) string { return or(crew.keys[key], key) }

// Setup makes the Projects, Skills, Workflows, Workspaces and Members the preset needs, as the
// admin c acts for, and issues each agent, and each persona when asked, a token. It is
// idempotent on names: what exists is kept, what is missing is created, a deactivated Member is
// reactivated, a Project's Workflow is written only when it differs from the preset's, and a
// Workspace whose repository is missing gets a new one where the Workspace says; only the tokens
// are new on every run.
func Setup(ctx context.Context, c *client.ClientWithResponses, o Options) (*Crew, error) {
	p := o.Preset
	if p == nil {
		p = &Software
	}
	me, err := c.GetMeWithResponse(ctx)
	if err := check(me, err, http.StatusOK); err != nil {
		return nil, fmt.Errorf("reading the admin: %w", err)
	}
	if !me.JSON200.Member.Admin {
		return nil, fmt.Errorf("%s is not an admin", me.JSON200.Member.Name)
	}
	crew := &Crew{Options: o, Preset: p, Admin: me.JSON200.Member, Members: map[string]Member{}, Workspaces: map[string]client.Workspace{},
		keys: map[string]string{}}

	specs := slices.Clone(p.Projects)
	for i := range specs {
		from := specs[i].Key
		switch i {
		case 0:
			specs[i].Key, specs[i].Name = or(o.Project, specs[i].Key), or(o.ProjectName, specs[i].Name)
			crew.Project, crew.ProjectName = specs[i].Key, specs[i].Name
		case 1:
			specs[i].Key, specs[i].Name = or(o.Ops, specs[i].Key), or(o.OpsName, specs[i].Name)
			crew.Ops, crew.OpsName = specs[i].Key, specs[i].Name
		}
		crew.keys[from] = specs[i].Key
	}
	crew.Owner = crew.Admin.Name
	if o.Personas {
		crew.Manager = or(crew.Manager, p.Manager)
		crew.Ask = or(crew.Ask, p.Ask)
		for _, h := range p.Humans {
			if h.Owns {
				crew.Owner = h.Name
				break
			}
		}
	}
	crew.Manager = or(crew.Manager, crew.Admin.Name)
	crew.Ask = or(crew.Ask, crew.Manager)

	pres, err := c.ListProjectsWithResponse(ctx)
	if err := check(pres, err, http.StatusOK); err != nil {
		return nil, err
	}
	projects := map[string]client.Project{}
	for _, pr := range pres.JSON200.Items {
		projects[pr.Key] = pr
	}
	have, err := c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err := check(have, err, http.StatusOK); err != nil {
		return nil, err
	}
	for _, s := range p.Skills {
		if slices.ContainsFunc(have.JSON200.Items, func(x client.Skill) bool { return x.Name == s.Name }) {
			continue
		}
		res, err := c.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, s)
		if err := check(res, err, http.StatusCreated); err != nil {
			return nil, fmt.Errorf("creating Skill %s: %w", s.Name, err)
		}
	}

	if err := crew.workspaces(ctx, c, p.Workspaces); err != nil {
		return nil, err
	}
	// The Projects, made with an empty Workflow and given the preset's, after the Skills it names.
	for _, t := range specs {
		cur, ok := projects[t.Key]
		if !ok {
			empty := client.NewWorkflowEmpty
			res, err := c.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: t.Key, Name: t.Name, Workflow: &empty})
			if err := check(res, err, http.StatusCreated); err != nil {
				return nil, fmt.Errorf("creating Project %s: %w", t.Key, err)
			}
			cur = res.JSON201.Project
			projects[t.Key] = cur
		}
		if err := setWorkflow(ctx, c, t.Key, p.Workflows); err != nil {
			return nil, err
		}
		var body client.UpdateProjectBody
		if t.DefaultWorkspace != "" {
			ws, ok := crew.Workspaces[t.DefaultWorkspace]
			if !ok {
				return nil, fmt.Errorf("Project %s names %s as its default Workspace, which the preset does not make", t.Key, t.DefaultWorkspace)
			}
			if cur.DefaultWorkspaceID == nil || *cur.DefaultWorkspaceID != ws.ID {
				body.DefaultWorkspace = &ws.ID
			}
		}
		if t.AutoComplete && !cur.AutoComplete {
			body.AutoComplete = ptr(true)
		}
		if body.DefaultWorkspace == nil && body.AutoComplete == nil {
			continue
		}
		res, err := c.UpdateProjectWithResponse(ctx, t.Key, &client.UpdateProjectParams{}, body)
		if err := check(res, err, http.StatusOK); err != nil {
			return nil, fmt.Errorf("setting Project %s's defaults: %w", t.Key, err)
		}
	}

	members, err := c.ListMembersWithResponse(ctx, &client.ListMembersParams{})
	if err := check(members, err, http.StatusOK); err != nil {
		return nil, err
	}
	// member finds or creates the Member name of kind, reactivating one an admin deactivated.
	member := func(name string, kind client.MemberKind) (client.Member, error) {
		i := slices.IndexFunc(members.JSON200.Items, func(x client.Member) bool { return x.Name == name })
		if i < 0 {
			res, err := c.CreateMemberWithResponse(ctx, &client.CreateMemberParams{}, client.CreateMemberBody{Name: name, Kind: kind})
			if err := check(res, err, http.StatusCreated); err != nil {
				return client.Member{}, fmt.Errorf("creating %s: %w", name, err)
			}
			return *res.JSON201, nil
		}
		m := members.JSON200.Items[i]
		if m.Kind != kind {
			return m, fmt.Errorf("a Member named %s exists and is a %s, not a %s", name, m.Kind, kind)
		}
		if m.DeactivatedAt != nil {
			res, err := c.ReactivateMemberWithResponse(ctx, m.ID, &client.ReactivateMemberParams{})
			if err := check(res, err, http.StatusOK); err != nil {
				return m, fmt.Errorf("reactivating %s: %w", name, err)
			}
		}
		return m, nil
	}
	join := func(project string, m client.Member) error {
		res, err := c.AddProjectMemberWithResponse(ctx, project, m.ID, &client.AddProjectMemberParams{})
		if err := check(res, err, http.StatusNoContent); err != nil {
			return fmt.Errorf("adding %s to %s: %w", m.Name, project, err)
		}
		return nil
	}
	grant := func(m client.Member, skills []string) error {
		for _, sk := range skills {
			res, err := c.GrantSkillWithResponse(ctx, m.ID, sk, &client.GrantSkillParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return fmt.Errorf("granting %s to %s: %w", sk, m.Name, err)
			}
		}
		return nil
	}
	issue := func(m client.Member) error {
		body := client.IssueTokenBody{Name: o.TokenName}
		if o.Timeout > 0 {
			body.DefaultHeartbeatTimeoutSeconds = &o.Timeout
		}
		tok, err := c.IssueTokenWithResponse(ctx, m.ID, &client.IssueTokenParams{}, body)
		if err := check(tok, err, http.StatusCreated); err != nil {
			return fmt.Errorf("issuing %s a token: %w", m.Name, err)
		}
		crew.Tokens = append(crew.Tokens, tok.JSON201.Token.ID)
		crew.Members[m.Name] = Member{Name: m.Name, ID: m.ID, Token: tok.JSON201.Secret, Session: NewSession()}
		return nil
	}

	for _, h := range o.Humans {
		m, err := member(h, client.Human)
		if err != nil {
			return nil, err
		}
		if err := join(crew.Project, m); err != nil {
			return nil, err
		}
	}
	// The admin files the Tasks and the chores, which needs them in every Project.
	for _, t := range specs {
		if err := join(t.Key, crew.Admin); err != nil {
			return nil, err
		}
	}
	if o.Personas {
		for _, h := range p.Humans {
			m, err := member(h.Name, client.Human)
			if err != nil {
				return nil, err
			}
			for _, t := range h.Projects {
				if err := join(crew.ProjectKey(t), m); err != nil {
					return nil, err
				}
			}
			if err := grant(m, h.Skills); err != nil {
				return nil, err
			}
			if err := issue(m); err != nil {
				return nil, err
			}
			crew.Personas = append(crew.Personas, h)
		}
	}

	for _, s := range p.Agents {
		m, err := member(s.Name, client.Agent)
		if err != nil {
			return nil, err
		}
		for _, t := range s.Projects {
			if err := join(crew.ProjectKey(t), m); err != nil {
				return nil, err
			}
		}
		if err := grant(m, s.Skills); err != nil {
			return nil, err
		}
		mres, err := c.SetManagerWithResponse(ctx, m.ID, &client.SetManagerParams{}, client.SetManagerBody{Manager: crew.Manager})
		if err := check(mres, err, http.StatusNoContent); err != nil {
			return nil, fmt.Errorf("%s reporting to %s: %w", s.Name, crew.Manager, err)
		}
		if err := issue(m); err != nil {
			return nil, err
		}
	}
	return crew, nil
}

// setWorkflow gives the Project project the Workflows want, unless it has them already:
// Workflows are kept by name, as the server keeps them when their ids are left out, and Steps by
// name, so a Step keeps its id and its Tasks; a Workflow the Project has and want does not is
// deleted, and a Step the Project has and want does not is deleted, its Tasks moved to the first
// Step of want's first Workflow.
func setWorkflow(ctx context.Context, c *client.ClientWithResponses, project string, want []WorkflowSpec) error {
	res, err := c.GetWorkflowWithResponse(ctx, project)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	have := res.JSON200
	skills, err := c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err := check(skills, err, http.StatusOK); err != nil {
		return err
	}
	skillName := map[string]string{}
	for _, sk := range skills.JSON200.Items {
		skillName[sk.ID] = sk.Name
	}
	workflowName := map[string]string{}
	for _, w := range have.Workflows {
		workflowName[w.ID] = w.Name
	}
	name := map[string]string{}
	for _, st := range have.Steps {
		name[st.ID] = st.Name
	}
	// Both as lines, to compare.
	var got, wanted []string
	for _, w := range have.Workflows {
		got = append(got, fmt.Sprintf("workflow %d %s", w.Position, w.Name))
	}
	for _, st := range have.Steps {
		got = append(got, fmt.Sprintf("step %s %d %s %s", workflowName[st.WorkflowID], st.Position, st.Name, skillName[deref(st.SkillID)]))
	}
	for _, k := range have.Connectors {
		got = append(got, fmt.Sprintf("connector %s %s %s %d", name[k.FromStepID], name[deref(k.ToStepID)], k.Name, k.Position))
	}
	body := client.SetWorkflowBody{Workflows: []client.WorkflowInput{}, Steps: []client.StepInput{}, Connectors: []client.ConnectorInput{}}
	var wantSteps []StepSpec
	for i, w := range want {
		wanted = append(wanted, fmt.Sprintf("workflow %d %s", i+1, w.Name))
		body.Workflows = append(body.Workflows, client.WorkflowInput{Name: w.Name, Position: ptr(int64(i + 1))})
	}
	for _, w := range want {
		for i, st := range w.Steps {
			wantSteps = append(wantSteps, st)
			wanted = append(wanted, fmt.Sprintf("step %s %d %s %s", w.Name, i+1, st.Name, st.Skill))
			in := client.StepInput{Workflow: w.Name, Name: st.Name, Position: ptr(int64(i + 1))}
			if st.Skill != "" {
				in.Skill = ptr(st.Skill)
			}
			if j := slices.IndexFunc(have.Steps, func(h client.WorkflowStep) bool { return strings.EqualFold(h.Name, st.Name) }); j >= 0 {
				in.ID = ptr(have.Steps[j].ID)
			}
			body.Steps = append(body.Steps, in)
		}
	}
	// The Connectors in the Project's order: by Workflow, then by the Step they lead out of.
	position := map[string]int64{}
	for _, st := range wantSteps {
		for _, w := range want {
			for _, k := range w.Connectors {
				if k.From != st.Name {
					continue
				}
				position[k.From]++
				wanted = append(wanted, fmt.Sprintf("connector %s %s %s %d", k.From, k.To, k.Name, position[k.From]))
				in := client.ConnectorInput{From: k.From, Name: k.Name, Position: ptr(position[k.From])}
				if k.To != "" {
					in.To = ptr(k.To)
				}
				body.Connectors = append(body.Connectors, in)
			}
		}
	}
	if slices.Equal(got, wanted) {
		return nil
	}
	moves := map[string]string{}
	for _, st := range have.Steps {
		if !slices.ContainsFunc(wantSteps, func(w StepSpec) bool { return strings.EqualFold(w.Name, st.Name) }) && len(wantSteps) > 0 {
			moves[st.ID] = wantSteps[0].Name
		}
	}
	if len(moves) > 0 {
		body.Moves = &moves
	}
	sres, err := c.SetWorkflowWithResponse(ctx, project, &client.SetWorkflowParams{}, body)
	if err := check(sres, err, http.StatusOK); err != nil {
		return fmt.Errorf("setting %s's Workflow: %w", project, err)
	}
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// workspaces makes the preset's Workspaces: one that exists by name is kept, its repository made
// at its path if missing there; a missing one gets a repository under WorkspaceRoot.
func (crew *Crew) workspaces(ctx context.Context, c *client.ClientWithResponses, specs []WorkspaceSpec) error {
	if len(specs) == 0 {
		return nil
	}
	res, err := c.ListWorkspacesWithResponse(ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	for _, s := range specs {
		i := slices.IndexFunc(res.JSON200.Items, func(w client.Workspace) bool { return strings.EqualFold(w.Name, s.Name) })
		if i >= 0 {
			w := res.JSON200.Items[i]
			if err := makeRepo(ctx, w.Path, s.Files); err != nil {
				return fmt.Errorf("the Workspace %s: %w", s.Name, err)
			}
			crew.Workspaces[s.Name] = w
			continue
		}
		if crew.WorkspaceRoot == "" {
			return fmt.Errorf("the %s preset makes the Workspace %s, and needs a directory to make its repository in (the workspace root)", crew.Preset.Name, s.Name)
		}
		root, err := filepath.Abs(crew.WorkspaceRoot)
		if err != nil {
			return err
		}
		dir := filepath.Join(root, s.Name)
		if err := makeRepo(ctx, dir, s.Files); err != nil {
			return fmt.Errorf("the Workspace %s: %w", s.Name, err)
		}
		cres, err := c.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: s.Name,
			Kind: ptr(client.WorkspaceKindGit), Path: dir})
		if err := check(cres, err, http.StatusCreated); err != nil {
			return fmt.Errorf("adding the Workspace %s: %w", s.Name, err)
		}
		crew.Workspaces[s.Name] = *cres.JSON201
	}
	return nil
}

// File files the Task t, as the client c acts for, titled title (t's own when empty) and owned
// by the crew's Owner: with Break down, which the planner takes; alone, at its one Item's Step
// (or the hold, filed ahead); or as a Parent with its Items filed under it as Subtasks.
func (crew *Crew) File(ctx context.Context, c *client.ClientWithResponses, t TaskTemplate, title string) (*client.TaskDetail, error) {
	project := crew.ProjectKey(or(t.Project, crew.Preset.Projects[0].Key))
	body := client.FileTaskBody{Project: &project, Title: or(title, t.Title), Description: &t.Description, Owner: &crew.Owner}
	hold := crew.Preset.Hold()
	switch {
	case t.Breakdown:
		body.Breakdown = ptr(true)
	case t.Alone && len(t.Items) > 0:
		it := t.Items[0]
		step := it.Step
		if it.Backlog && hold != "" {
			step = hold
		}
		if step != "" {
			body.Step = &step
		}
		if len(it.Workspaces) > 0 {
			body.Workspaces = &it.Workspaces
		}
	case len(t.Items) > 0 && hold != "":
		// A Parent filed before its Subtasks waits at the hold until the first makes it a Parent.
		body.Step = &hold
	}
	if t.AutoComplete {
		body.AutoComplete = ptr(true)
	}
	res, err := c.FileTaskWithResponse(ctx, &client.FileTaskParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return nil, fmt.Errorf("filing %q: %w", body.Title, err)
	}
	if t.Breakdown || t.Alone || len(t.Items) == 0 {
		return res.JSON201, nil
	}
	a := agent{m: Member{Name: crew.Admin.Name, ID: crew.Admin.ID}, c: c, preset: crew.Preset}
	if _, _, _, err := fileItems(ctx, &a, res.JSON201.Task.Key, res.JSON201.Task.ProjectID, t.Items, hold); err != nil {
		return nil, err
	}
	d, err := c.GetTaskWithResponse(ctx, res.JSON201.Task.Key)
	if err := check(d, err, http.StatusOK); err != nil {
		return nil, err
	}
	return d.JSON200, nil
}

// planned is every bot: Bots tells it the preset whose plans say what a Task asks.
type planned interface {
	Bot
	plans(p *Preset, ask string)
}

func (a *agent) plans(p *Preset, ask string) { a.preset, a.ask = p, ask }

// Bots makes the bot for every Spec of the preset's Agents, and for every persona Setup issued a
// token to.
func (crew *Crew) Bots(cfg Config) []Bot {
	var bots []Bot
	for _, s := range crew.Preset.Agents {
		m := crew.Members[s.Name]
		var b planned
		switch s.Role {
		case RolePlanner:
			p := NewPlanner(cfg, m, s.Model, crew.Ask)
			p.Plan = crew.Preset.plan
			b = p
		case RoleBuilder:
			b = NewBuilder(cfg, m, s.Model)
		case RoleProber:
			b = NewProber(cfg, m, s.Model)
		case RoleReviewer:
			b = NewReviewer(cfg, m, s.Model)
		case RoleRetro:
			b = NewRetro(cfg, m, s.Model)
		case RoleLapser:
			b = NewLapser(cfg, m, s.Model)
		case RoleStuck:
			b = NewStuck(cfg, m, s.Model)
		}
		b.plans(crew.Preset, crew.Ask)
		bots = append(bots, b)
	}
	for _, p := range crew.Personas {
		h := NewPerson(cfg, crew.Members[p.Name], p)
		h.plans(crew.Preset, crew.Ask)
		bots = append(bots, h)
	}
	return bots
}

// Revoke revokes the tokens Setup issued, which ends the Claims the bots still hold.
func (crew *Crew) Revoke(ctx context.Context, c *client.ClientWithResponses) error {
	var errs []error
	for _, id := range crew.Tokens {
		res, err := c.RevokeTokenWithResponse(ctx, id, &client.RevokeTokenParams{})
		if err := check(res, err, http.StatusOK, http.StatusNoContent); err != nil {
			errs = append(errs, fmt.Errorf("revoking token %s: %w", id, err))
		}
	}
	return errors.Join(errs...)
}

func ptr[T any](v T) *T { return &v }
