package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// The built-in Skills `darkory init` creates. The Steps carrying the first three are where
// Darkory files the Subtasks it owns about a Parent — its Breakdown, Acceptance and Retrospective —
// and the fourth reviews proposed Skill versions (ADR 0010, ADR 0016).
const (
	SkillBreakdown   = "breakdown"
	SkillAcceptance  = "acceptance"
	SkillRetro       = "retro"
	SkillSkillReview = "skill-review"
)

// What `darkory init` seeds on a Local Install: Project MAIN on the default Workflows, always, and
// unless told --no-agents the roster, so it comes up with agents ready (docs/build/agents-plan.md,
// D4): four agents in MAIN reporting to the first Member, each with agent settings and a token.
// The generic Skills engineer, review, triage and qa, which the default Workflows' Steps carry,
// are seeded whether or not the roster is.
const (
	RosterProjectKey  = "MAIN"
	RosterProjectName = "Main"
	SkillEngineer     = "engineer"
	SkillReview       = "review"
	SkillTriage       = "triage"
	SkillQA           = "qa"
	// RosterTokenName names the token each agent of the roster is issued, for the Runner.
	RosterTokenName = "runner"
	// RosterTokenTimeout is that token's default heartbeat timeout: the Runner sends Heartbeats
	// while a session shows progress, and a session that shows none lapses on it.
	RosterTokenTimeout = 5 * time.Minute
)

// seededSkills are the generic Skills `darkory init` creates, with their first versions.
var seededSkills = []struct {
	name, body string
	builtin    bool
}{
	{SkillBreakdown, "Break a Task down into Subtasks. Read the Task and file the Subtasks its work needs under it, each with --parent " +
		"and at the Step that should take it first, and let Subtasks block one another where their order matters. " +
		"Advance this Task when the work is filed.", true},
	{SkillAcceptance, "Confirm a Parent as a whole before it is called done. Read the Parent, its Subtasks, their Notes and Evidence, " +
		"and check that together they do what the Parent asks. Advance this Task into Done when they do. When something is missing, " +
		"file a Subtask under the Parent for each thing, then advance this Task; Darkory files a new Acceptance once they are done.", true},
	{SkillRetro, "Run a Parent's Retrospective. Read the Observations recorded on its Subtasks, propose a new version of any company " +
		"Skill that should change and advance this Task to skill review, and file new Tasks for problems that need work rather than a " +
		"Skill change.", true},
	{SkillSkillReview, "Review a proposed Skill version. Advance this Task into Done to publish it, or back to the Retrospective with a " +
		"Note saying what to fix. Nobody reviews their own proposal.", true},
	{SkillEngineer, "Build what the Task describes. Work on the Task's branch in its Workspace, test as you go, run the tests, and attach " +
		"the test log as Evidence. Advance the Task when it is built, with a Note saying what changed and how you checked it.", false},
	{SkillReview, "Review the work a Task describes: read the change on its branch and its Evidence, run the tests, and check it does " +
		"what the Task asks. Advance it when it is right, with a Note saying what you checked; advance it back with a Note saying what " +
		"to fix when it is not. Nobody reviews their own work.", false},
	{SkillTriage, "Triage a reported problem. Read the Task, reproduce what it describes and record what you saw as a Note. Advance it " +
		"along bug when it is a defect to fix, along feature when it asks for something new, or along not a bug when there is nothing " +
		"to change, each with a Note saying why.", false},
	{SkillQA, "Verify a fix. Read the Task and the Notes of the Fix and Code review, run the change on its branch, reproduce the original " +
		"report and confirm it no longer happens, and attach what you ran as Evidence. Advance it along pass when the fix holds; along " +
		"fail with a Note saying what still happens.", false},
}

// RosterAgent is one agent of the roster: its Skills and model.
type RosterAgent struct {
	Name   string
	Skills []string
	Model  string
}

// Roster is the agents `darkory init` seeds.
var Roster = []RosterAgent{
	{Name: "planner", Skills: []string{SkillBreakdown, SkillTriage}, Model: "claude-opus-5-5"},
	{Name: "builder", Skills: []string{SkillEngineer}, Model: "claude-sonnet-5-5"},
	{Name: "reviewer", Skills: []string{SkillReview, SkillSkillReview, SkillQA}, Model: "claude-opus-5-5"},
	{Name: "retro", Skills: []string{SkillRetro}, Model: "claude-opus-5-5"},
}

// LoginLinkTTL is how long a one-time login link works.
const LoginLinkTTL = 15 * time.Minute

// ErrInitialised: `darkory init` found an Organisation already there.
var ErrInitialised = errors.New("core: this Install already holds an Organisation")

// ErrNotInitialised: the Install holds no Organisation yet.
var ErrNotInitialised = errors.New("core: this Install holds no Organisation; run darkory init")

// Initialised is what `darkory init` made.
type Initialised struct {
	Organisation Organisation
	Member       Member
	Token        IssuedToken
	Link         LoginLink
	// Project is Project MAIN, when InitWith seeded it; Workspace is its default, nil when none
	// was given; Agents are the roster's agents, when it seeded them.
	Project   *Project
	Workspace *Workspace
	Agents    []SeededAgent
}

// SeededAgent is an agent of the roster, with its token, whose secret is shown once.
type SeededAgent struct {
	Member Member
	Skills []string
	Token  IssuedToken
}

// InitOptions are what InitWith seeds besides what Init does.
type InitOptions struct {
	// Project seeds Project MAIN on the default Workflows with the first Member in it.
	Project bool
	// Roster seeds Project MAIN as Project does, and the Roster's agents in it, reporting to the
	// first Member, each with agent settings and a token named RosterTokenName.
	Roster bool
	// Workspace, with Project or Roster, is added and made Project MAIN's default.
	Workspace *NewWorkspace
}

// Init creates the Install's Organisation, its first Member — a human admin — the built-in
// Skills and the generic Skills engineer, review, triage and qa, a token for that Member and a
// login link. It refuses when an Organisation exists.
func (s *Service) Init(ctx context.Context, orgName, memberName string) (Initialised, error) {
	return s.InitWith(ctx, orgName, memberName, InitOptions{})
}

// InitWith is Init, seeding what o asks for in the same write.
func (s *Service) InitWith(ctx context.Context, orgName, memberName string, o InitOptions) (Initialised, error) {
	var out Initialised
	var n int
	if err := s.store.QueryRow(ctx, `SELECT COUNT(*) FROM organisations`).Scan(&n); err != nil {
		return out, err
	}
	if n > 0 {
		return out, ErrInitialised
	}
	if err := validName("Organisation name", orgName); err != nil {
		return out, err
	}
	if err := validMemberName("Member name", memberName); err != nil {
		return out, err
	}
	now := s.clock.Now()
	orgID, err := s.store.CreateOrganisation(ctx, orgName, now)
	if err != nil {
		return out, err
	}
	memberID := store.NewID()
	c := &auth.Caller{OrgID: orgID, MemberID: memberID, Name: memberName, Admin: true}
	err = s.store.Write(ctx, orgID, func(stx store.Tx, seq int64) error {
		t := &tx{Tx: stx, ctx: ctx, caller: c, now: now, seq: seq}
		if _, err := t.Exec(ctx, `INSERT INTO members (id, org_id, name, kind, admin, created_at, updated_at)
VALUES ($1, $2, $3, 'human', TRUE, $4, $4)`, memberID, orgID, memberName, ms(now)); err != nil {
			return err
		}
		if err := t.record(nil, "member.created", memberID, map[string]any{"name": memberName, "kind": "human", "admin": true}); err != nil {
			return err
		}
		for _, b := range seededSkills {
			if _, err := createSkill(t, b.name, "generic", nil, b.body, b.builtin); err != nil {
				return err
			}
		}
		if out.Token, err = issueToken(t, memberID, "init", 0); err != nil {
			return err
		}
		if out.Link, err = issueLoginLink(t, memberID, nil); err != nil {
			return err
		}
		if !o.Project && !o.Roster {
			return nil
		}
		project, err := seedProject(t, memberID, o.Workspace, &out)
		if err != nil || !o.Roster {
			return err
		}
		return seedRoster(t, project, memberID, &out)
	})
	if err != nil {
		return out, fmt.Errorf("core: init: %w", err)
	}
	out.Organisation = Organisation{ID: orgID, Name: orgName, CreatedAt: now}
	out.Member, err = getMember(ctx, s.store, orgID, memberID)
	return out, err
}

// seedProject seeds Project MAIN inside Init's write, with the first Member, humanID, in it and
// nw, when given, as its default Workspace, and returns its id.
func seedProject(t *tx, humanID string, nw *NewWorkspace, out *Initialised) (string, error) {
	project, err := createProject(t, projectRow{key: RosterProjectKey, name: RosterProjectName, workflow: WorkflowDefault})
	if err != nil {
		return "", err
	}
	if err := addProjectMember(t, project, humanID); err != nil {
		return "", err
	}
	if nw != nil {
		ws, err := createWorkspace(t, *nw)
		if err != nil {
			return "", err
		}
		if _, err := t.Exec(t.ctx, `UPDATE projects SET default_workspace_id = $1 WHERE org_id = $2 AND id = $3`, ws, t.caller.OrgID, project); err != nil {
			return "", err
		}
		if err := t.recordByCaller("project.changed", project, map[string]any{"default_workspace_id": ws}); err != nil {
			return "", err
		}
		w, err := getWorkspace(t.ctx, t, t.caller.OrgID, ws)
		if err != nil {
			return "", err
		}
		out.Workspace = &w
	}
	p, err := getProject(t.ctx, t, t.caller.OrgID, project)
	if err != nil {
		return "", err
	}
	out.Project = &p
	return project, nil
}

// seedRoster seeds the roster's agents in Project MAIN, project, inside Init's write, reporting to
// the first Member, humanID.
func seedRoster(t *tx, project, humanID string, out *Initialised) error {
	var err error
	skills := map[string]string{}
	for _, a := range Roster {
		for _, sk := range a.Skills {
			if skills[sk], err = skillByName(t.ctx, t, t.caller.OrgID, sk); err != nil {
				return err
			}
		}
	}
	for _, a := range Roster {
		id, err := createMember(t, NewMember{Name: a.Name, Kind: "agent"})
		if err != nil {
			return err
		}
		if err := addProjectMember(t, project, id); err != nil {
			return err
		}
		for _, sk := range a.Skills {
			if err := grantSkill(t, id, skills[sk]); err != nil {
				return err
			}
		}
		if err := setManager(t, id, humanID, a.Name, humanID); err != nil {
			return err
		}
		settings := DefaultAgentSettings()
		settings.Model = a.Model
		if err := setAgent(t, id, settings, agentChanges(AgentSettings{}, settings)); err != nil {
			return err
		}
		tok, err := issueToken(t, id, RosterTokenName, RosterTokenTimeout)
		if err != nil {
			return err
		}
		m, err := getMember(t.ctx, t, t.caller.OrgID, id)
		if err != nil {
			return err
		}
		out.Agents = append(out.Agents, SeededAgent{Member: m, Skills: a.Skills, Token: tok})
	}
	return nil
}

// StartupLink issues the login link `darkory serve` prints at start, for the Member `darkory init`
// created: the Organisation's oldest human admin, or its oldest human when no human is an admin.
func (s *Service) StartupLink(ctx context.Context) (Member, LoginLink, error) {
	var m Member
	var orgID string
	err := s.store.QueryRow(ctx, `SELECT id FROM organisations ORDER BY created_at, id LIMIT 1`).Scan(&orgID)
	if errors.Is(err, sql.ErrNoRows) {
		return m, LoginLink{}, ErrNotInitialised
	}
	if err != nil {
		return m, LoginLink{}, err
	}
	m, err = scanMember(s.store.QueryRow(ctx, `SELECT `+memberCols+` FROM `+memberFrom+`
WHERE m.org_id = $1 AND m.kind = 'human' AND m.deactivated_at IS NULL ORDER BY m.admin DESC, m.created_at, m.id LIMIT 1`, orgID))
	if errors.Is(err, sql.ErrNoRows) {
		return m, LoginLink{}, fmt.Errorf("core: the Organisation has no human Member to sign in")
	}
	if err != nil {
		return m, LoginLink{}, err
	}
	var link LoginLink
	c := &auth.Caller{OrgID: orgID, MemberID: m.ID}
	err = s.store.Write(ctx, orgID, func(stx store.Tx, seq int64) error {
		t := &tx{Tx: stx, ctx: ctx, caller: c, now: s.clock.Now(), seq: seq}
		var err error
		link, err = issueLoginLink(t, m.ID, nil)
		return err
	})
	return m, link, err
}

// GetMe returns the caller, their Projects and Skills, and the Session they call through. A Local
// Install holds one Organisation, so Organisations is left out.
func (s *Service) GetMe(ctx context.Context, c *auth.Caller) (Me, error) {
	var me Me
	var created int64
	if err := s.store.QueryRow(ctx, `SELECT id, name, created_at FROM organisations WHERE id = $1`, c.OrgID).
		Scan(&me.Organisation.ID, &me.Organisation.Name, &created); err != nil {
		return me, err
	}
	me.Organisation.CreatedAt = fromMS(created)
	var err error
	if me.Member, err = getMember(ctx, s.store, c.OrgID, c.MemberID); err != nil {
		return me, err
	}
	if me.Projects, err = memberProjects(ctx, s.store, c.OrgID, c.MemberID); err != nil {
		return me, err
	}
	if me.Skills, err = memberSkills(ctx, s.store, c.OrgID, c.MemberID); err != nil {
		return me, err
	}
	me.Session, err = getSession(ctx, s.store, c.OrgID, c.SessionID)
	s.expiry(&me.Session)
	return me, err
}
