package bot

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/tuongaz/darkory/client"
)

// The Skills the bots need. Darkory has breakdown, retro and skill-review built in.
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

// skills are the Skills Setup creates when missing, generic ones before the company Skill on them.
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

// Spec is one bot's agent Member: its role, whether it is in the work Team, the ops Team or both,
// its Skills and the model label it reports.
type Spec struct {
	Name      string
	Role      Role
	Work, Ops bool
	Skills    []string
	Model     string
}

// Roster is every bot of a run.
var Roster = []Spec{
	{Name: "planner", Role: RolePlanner, Work: true, Skills: []string{SkillBreakdown}, Model: "claude-opus-5-5"},
	{Name: "builder-1", Role: RoleBuilder, Work: true, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-sonnet-5-5"},
	{Name: "builder-2", Role: RoleBuilder, Work: true, Skills: []string{SkillBuild, SkillCompany, SkillQA}, Model: "claude-opus-5-5"},
	{Name: "reviewer", Role: RoleReviewer, Work: true, Ops: true, Skills: []string{SkillReview, SkillSkillReview}, Model: "claude-opus-5-5"},
	{Name: "retro", Role: RoleRetro, Work: true, Skills: []string{SkillRetro}, Model: "claude-sonnet-5-5"},
	{Name: "lapser", Role: RoleLapser, Ops: true, Skills: []string{SkillTriage}, Model: "claude-haiku-4-5"},
	{Name: "stuck", Role: RoleStuck, Ops: true, Skills: []string{SkillDeploy}, Model: "claude-haiku-4-5"},
	{Name: "prober", Role: RoleProber, Work: true, Skills: []string{SkillDocs}, Model: "claude-haiku-4-5"},
}

// Options says where Setup puts the bots.
type Options struct {
	// Team is the key of the Team whose Features the bots plan, build and review, and TeamName
	// the name Setup gives it if it creates it. Ops and OpsName are the second Team, whose chores
	// the lapser and Stuck take.
	Team, TeamName, Ops, OpsName string
	// Manager is the Member every agent reports to, who may take back their Claims; the admin
	// when empty.
	Manager string
	// Ask is the Member the builders' questions are aimed at; the Manager when empty.
	Ask string
	// Humans are human Members Setup creates when missing and adds to Team.
	Humans []string
	// Timeout is the default heartbeat timeout, in seconds, of the tokens Setup issues; TokenName
	// is their name.
	Timeout   int
	TokenName string
}

// Crew is what Setup made: the Organisation's admin and a Member, with a fresh token and Session,
// for every Spec of the Roster.
type Crew struct {
	Options
	Admin   client.Member
	Members map[string]Member
	// Tokens are the ids of the tokens Setup issued.
	Tokens []string
}

// Setup makes the Teams, Skills and Members the bots need, as the admin c acts for, and issues
// each agent a token. It is idempotent on names: what exists is kept, what is missing is created,
// and a deactivated agent is reactivated; only the tokens are new on every run.
func Setup(ctx context.Context, c *client.ClientWithResponses, o Options) (*Crew, error) {
	me, err := c.GetMeWithResponse(ctx)
	if err := check(me, err, http.StatusOK); err != nil {
		return nil, fmt.Errorf("reading the admin: %w", err)
	}
	if !me.JSON200.Member.Admin {
		return nil, fmt.Errorf("%s is not an admin", me.JSON200.Member.Name)
	}
	crew := &Crew{Options: o, Admin: me.JSON200.Member, Members: map[string]Member{}}
	if crew.Manager == "" {
		crew.Manager = crew.Admin.Name
	}
	if crew.Ask == "" {
		crew.Ask = crew.Manager
	}

	teams, err := c.ListTeamsWithResponse(ctx)
	if err := check(teams, err, http.StatusOK); err != nil {
		return nil, err
	}
	for _, t := range []client.CreateTeamBody{{Key: o.Team, Name: o.TeamName}, {Key: o.Ops, Name: o.OpsName}} {
		if slices.ContainsFunc(teams.JSON200.Items, func(x client.Team) bool { return x.Key == t.Key }) {
			continue
		}
		res, err := c.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, t)
		if err := check(res, err, http.StatusCreated); err != nil {
			return nil, fmt.Errorf("creating Team %s: %w", t.Key, err)
		}
	}

	have, err := c.ListSkillsWithResponse(ctx, &client.ListSkillsParams{})
	if err := check(have, err, http.StatusOK); err != nil {
		return nil, err
	}
	for _, s := range skills {
		if slices.ContainsFunc(have.JSON200.Items, func(x client.Skill) bool { return x.Name == s.Name }) {
			continue
		}
		res, err := c.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, s)
		if err := check(res, err, http.StatusCreated); err != nil {
			return nil, fmt.Errorf("creating Skill %s: %w", s.Name, err)
		}
	}

	members, err := c.ListMembersWithResponse(ctx, &client.ListMembersParams{})
	if err := check(members, err, http.StatusOK); err != nil {
		return nil, err
	}
	// member finds or creates the Member name of kind, reactivating an agent an admin deactivated.
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
			res, err := c.ReactivateMemberWithResponse(ctx, name, &client.ReactivateMemberParams{})
			if err := check(res, err, http.StatusOK); err != nil {
				return m, fmt.Errorf("reactivating %s: %w", name, err)
			}
		}
		return m, nil
	}
	join := func(team, name string) error {
		res, err := c.AddTeamMemberWithResponse(ctx, team, name, &client.AddTeamMemberParams{})
		if err := check(res, err, http.StatusNoContent); err != nil {
			return fmt.Errorf("adding %s to %s: %w", name, team, err)
		}
		return nil
	}

	for _, h := range o.Humans {
		if _, err := member(h, client.Human); err != nil {
			return nil, err
		}
		if err := join(o.Team, h); err != nil {
			return nil, err
		}
	}
	// The admin files the Features and the chores, which needs them in both Teams.
	for _, t := range []string{o.Team, o.Ops} {
		if err := join(t, crew.Admin.Name); err != nil {
			return nil, err
		}
	}

	for _, s := range Roster {
		m, err := member(s.Name, client.Agent)
		if err != nil {
			return nil, err
		}
		for _, t := range []struct {
			key string
			in  bool
		}{{o.Team, s.Work}, {o.Ops, s.Ops}} {
			if t.in {
				if err := join(t.key, s.Name); err != nil {
					return nil, err
				}
			}
		}
		for _, sk := range s.Skills {
			res, err := c.GrantSkillWithResponse(ctx, s.Name, sk, &client.GrantSkillParams{})
			if err := check(res, err, http.StatusNoContent); err != nil {
				return nil, fmt.Errorf("granting %s to %s: %w", sk, s.Name, err)
			}
		}
		mres, err := c.SetManagerWithResponse(ctx, s.Name, &client.SetManagerParams{}, client.SetManagerBody{Manager: crew.Manager})
		if err := check(mres, err, http.StatusNoContent); err != nil {
			return nil, fmt.Errorf("%s reporting to %s: %w", s.Name, crew.Manager, err)
		}
		body := client.IssueTokenBody{Name: o.TokenName}
		if o.Timeout > 0 {
			body.DefaultHeartbeatTimeoutSeconds = &o.Timeout
		}
		tok, err := c.IssueTokenWithResponse(ctx, s.Name, &client.IssueTokenParams{}, body)
		if err := check(tok, err, http.StatusCreated); err != nil {
			return nil, fmt.Errorf("issuing %s a token: %w", s.Name, err)
		}
		crew.Tokens = append(crew.Tokens, tok.JSON201.Token.ID)
		crew.Members[s.Name] = Member{Name: s.Name, ID: m.ID, Token: tok.JSON201.Secret, Session: NewSession()}
	}
	return crew, nil
}

// Bots makes the bot for every Spec of the Roster.
func (crew *Crew) Bots(cfg Config) []Bot {
	var bots []Bot
	for _, s := range Roster {
		m := crew.Members[s.Name]
		var b Bot
		switch s.Role {
		case RolePlanner:
			b = NewPlanner(cfg, m, s.Model, crew.Ask)
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
