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

// The Skills the software bots need. Darkory has breakdown, retro and skill-review built in.
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

// Spec is one bot's agent Member: its role, the keys of its preset's Teams it is in, its Skills
// and the model label it reports.
type Spec struct {
	Name   string
	Role   Role
	Teams  []string
	Skills []string
	Model  string
}

// Roster is every bot of the software preset.
var Roster = []Spec{
	{Name: "planner", Role: RolePlanner, Teams: []string{"WEB"}, Skills: []string{SkillBreakdown}, Model: "claude-opus-5-5"},
	{Name: "builder-1", Role: RoleBuilder, Teams: []string{"WEB"}, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-sonnet-5-5"},
	{Name: "builder-2", Role: RoleBuilder, Teams: []string{"WEB"}, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-opus-5-5"},
	{Name: "reviewer", Role: RoleReviewer, Teams: []string{"WEB", "OPS"}, Skills: []string{SkillReview, SkillSkillReview}, Model: "claude-opus-5-5"},
	{Name: "retro", Role: RoleRetro, Teams: []string{"WEB"}, Skills: []string{SkillRetro}, Model: "claude-sonnet-5-5"},
	{Name: "lapser", Role: RoleLapser, Teams: []string{"OPS"}, Skills: []string{SkillTriage}, Model: "claude-haiku-4-5"},
	{Name: "stuck", Role: RoleStuck, Teams: []string{"OPS"}, Skills: []string{SkillDeploy}, Model: "claude-haiku-4-5"},
	{Name: "prober", Role: RoleProber, Teams: []string{"WEB"}, Skills: []string{SkillDocs}, Model: "claude-haiku-4-5"},
}

// Options says what Setup makes and where.
type Options struct {
	// Preset is the Organisation to make; Software when nil.
	Preset *Preset
	// Team and TeamName, when set, rename the preset's first Team, whose Features the bots plan,
	// build and review; Ops and OpsName its second, whose chores the lapser and Stuck take.
	Team, TeamName, Ops, OpsName string
	// Manager is the Member every agent reports to, who may take back their Claims: the
	// preset's Manager with Personas, else the admin, when empty.
	Manager string
	// Ask is the Member the agents' questions are aimed at unless a Step names another: the
	// preset's Ask with Personas, else the Manager, when empty.
	Ask string
	// Humans are human Members Setup creates when missing and adds to Team.
	Humans []string
	// Personas makes the preset's human personas, in their Teams with their Skills, and issues
	// each a token, so Bots runs them too; the Features the owner files are then the persona
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
	// Owner is the Member who owns the Features the bots' owner files: the persona Manager with
	// Personas, else the admin.
	Owner   string
	Members map[string]Member
	// Personas are the human personas Setup issued tokens to.
	Personas []Persona
	// Workspaces are the preset's Workspaces, by name.
	Workspaces map[string]client.Workspace
	// Tokens are the ids of the tokens Setup issued.
	Tokens []string
	// keys maps the preset's Team keys to the Teams Setup made.
	keys map[string]string
}

// TeamKey is the key of the Team Setup made for the preset's Team key.
func (crew *Crew) TeamKey(key string) string { return or(crew.keys[key], key) }

// Setup makes the Teams, Skills, Statuses, Workspaces and Members the preset needs, as the admin c
// acts for, and issues each agent, and each persona when asked, a token. It is idempotent on
// names: what exists is kept, what is missing is created, a deactivated Member is reactivated,
// the Statuses are written only when they differ, and a Workspace whose repository is missing
// gets a new one where the Workspace says; only the tokens are new on every run.
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

	specs := slices.Clone(p.Teams)
	for i := range specs {
		from := specs[i].Key
		switch i {
		case 0:
			specs[i].Key, specs[i].Name = or(o.Team, specs[i].Key), or(o.TeamName, specs[i].Name)
			crew.Team, crew.TeamName = specs[i].Key, specs[i].Name
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

	tres, err := c.ListTeamsWithResponse(ctx)
	if err := check(tres, err, http.StatusOK); err != nil {
		return nil, err
	}
	teams := map[string]client.Team{}
	for _, t := range tres.JSON200.Items {
		teams[t.Key] = t
	}
	for _, t := range specs {
		if _, ok := teams[t.Key]; ok {
			continue
		}
		res, err := c.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: t.Key, Name: t.Name})
		if err := check(res, err, http.StatusCreated); err != nil {
			return nil, fmt.Errorf("creating Team %s: %w", t.Key, err)
		}
		teams[t.Key] = *res.JSON201
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

	if err := setStatuses(ctx, c, p.Statuses); err != nil {
		return nil, err
	}
	if err := crew.workspaces(ctx, c, p.Workspaces); err != nil {
		return nil, err
	}
	for _, t := range specs {
		cur := teams[t.Key]
		var body client.UpdateTeamBody
		if t.DefaultWorkspace != "" {
			ws, ok := crew.Workspaces[t.DefaultWorkspace]
			if !ok {
				return nil, fmt.Errorf("Team %s names %s as its default Workspace, which the preset does not make", t.Key, t.DefaultWorkspace)
			}
			if cur.DefaultWorkspaceID == nil || *cur.DefaultWorkspaceID != ws.ID {
				body.DefaultWorkspace = &ws.ID
			}
		}
		if t.ShipWhenDone && !cur.ShipWhenDone {
			body.ShipWhenDone = ptr(true)
		}
		if body.DefaultWorkspace == nil && body.ShipWhenDone == nil {
			continue
		}
		res, err := c.UpdateTeamWithResponse(ctx, t.Key, &client.UpdateTeamParams{}, body)
		if err := check(res, err, http.StatusOK); err != nil {
			return nil, fmt.Errorf("setting Team %s's defaults: %w", t.Key, err)
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
	join := func(team string, m client.Member) error {
		res, err := c.AddTeamMemberWithResponse(ctx, team, m.ID, &client.AddTeamMemberParams{})
		if err := check(res, err, http.StatusNoContent); err != nil {
			return fmt.Errorf("adding %s to %s: %w", m.Name, team, err)
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
		if err := join(crew.Team, m); err != nil {
			return nil, err
		}
	}
	// The admin files the Features and the chores, which needs them in every Team.
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
			for _, t := range h.Teams {
				if err := join(crew.TeamKey(t), m); err != nil {
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
		for _, t := range s.Teams {
			if err := join(crew.TeamKey(t), m); err != nil {
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

// setStatuses makes the Organisation's Statuses want, in order, when they are not already: a
// Status keeps its id where one of the same name exists, else where one of the same kind is left
// over (Backlog becoming Awaiting client is a rename), and one left over after that is deleted,
// its Tasks moved to the first Status of the same ending. A nil want changes nothing.
func setStatuses(ctx context.Context, c *client.ClientWithResponses, want []client.StatusInput) error {
	if want == nil {
		return nil
	}
	res, err := c.ListStatusesWithResponse(ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	have := res.JSON200.Items
	items := slices.Clone(want)
	used := map[string]bool{}
	for i := range items {
		if j := slices.IndexFunc(have, func(s client.Status) bool { return !used[s.ID] && strings.EqualFold(s.Name, items[i].Name) }); j >= 0 {
			items[i].ID = &have[j].ID
			used[have[j].ID] = true
		}
	}
	named := func(s client.Status) bool {
		return slices.ContainsFunc(want, func(w client.StatusInput) bool { return strings.EqualFold(w.Name, s.Name) })
	}
	for i := range items {
		if items[i].ID != nil {
			continue
		}
		if j := slices.IndexFunc(have, func(s client.Status) bool { return !used[s.ID] && !named(s) && s.Kind == items[i].Kind }); j >= 0 {
			items[i].ID = &have[j].ID
			used[have[j].ID] = true
		}
	}
	same := len(have) == len(items)
	for i := 0; same && i < len(items); i++ {
		same = items[i].ID != nil && *items[i].ID == have[i].ID && items[i].Name == have[i].Name && items[i].Kind == have[i].Kind
	}
	if same {
		return nil
	}
	ending := func(k client.StatusKind) client.StatusKind {
		if k == client.StatusKindDone || k == client.StatusKindDropped {
			return k
		}
		return client.StatusKindTodo
	}
	moves := map[string]string{}
	for _, s := range have {
		if used[s.ID] {
			continue
		}
		if j := slices.IndexFunc(items, func(w client.StatusInput) bool { return w.ID != nil && ending(w.Kind) == ending(s.Kind) }); j >= 0 {
			moves[s.ID] = *items[j].ID
		}
	}
	body := client.SetStatusesBody{Items: items}
	if len(moves) > 0 {
		body.Moves = &moves
	}
	sres, err := c.SetStatusesWithResponse(ctx, &client.SetStatusesParams{}, body)
	if err := check(sres, err, http.StatusOK); err != nil {
		return fmt.Errorf("setting the Statuses: %w", err)
	}
	return nil
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

// File files the Feature t, as the client c acts for, titled title (t's own when empty) and owned
// by the crew's Owner: a quick Feature with its one Task, or one whose Break down the planner
// takes.
func (crew *Crew) File(ctx context.Context, c *client.ClientWithResponses, t FeatureTemplate, title string) (*client.FeatureDetail, error) {
	body := client.FileFeatureBody{Team: crew.TeamKey(or(t.Team, crew.Preset.Teams[0].Key)), Title: or(title, t.Title), Description: &t.Description,
		Owner: &crew.Owner}
	if t.Quick && len(t.Tasks) > 0 {
		body.Quick, body.Skill = ptr(true), &t.Tasks[0].Skill
		if len(t.Tasks[0].Workspaces) > 0 {
			body.Workspaces = &t.Tasks[0].Workspaces
		}
	}
	if t.ShipWhenDone {
		body.ShipWhenDone = ptr(true)
	}
	res, err := c.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, body)
	if err := check(res, err, http.StatusCreated); err != nil {
		return nil, fmt.Errorf("filing %q: %w", body.Title, err)
	}
	return res.JSON201, nil
}

// planned is every bot: Bots tells it the preset whose plans say what a Task asks.
type planned interface {
	Bot
	plans(p *Preset, ask string)
}

func (a *agent) plans(p *Preset, ask string) { a.preset, a.ask = p, ask }

// Bots makes the bot for every Spec of the preset's Agents.
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
