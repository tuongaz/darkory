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

// The built-in Skills `darkory init` creates; Darkory files Tasks needing the first two, and the
// third reviews proposed Skill versions (ADR 0010).
const (
	SkillBreakdown   = "breakdown"
	SkillRetro       = "retro"
	SkillSkillReview = "skill-review"
)

var builtinSkills = []struct{ name, body string }{
	{SkillBreakdown, "Break a Feature down into Tasks. Read the Feature, file the Tasks it needs, each needing a Skill or aimed at a Member, and let Tasks block one another where their order matters. Complete this Task when the Feature's work is filed."},
	{SkillRetro, "Run a Feature's Retrospective. Read the Observations recorded on its Tasks, propose a new version of any company Skill that should change, and file new Features for problems that need work rather than a Skill change."},
	{SkillSkillReview, "Review a proposed Skill version. Complete the Task to publish it, or hand it back to retro with a Note saying what to fix. Nobody reviews their own proposal."},
}

// The roster `darkory init` seeds on a Local Install so it comes up with agents ready
// (docs/build/agents-plan.md, D4): Team MAIN, the generic Skills engineer and review, and four
// agents in the Team reporting to the first Member, each with agent settings and a token.
const (
	RosterTeamKey  = "MAIN"
	RosterTeamName = "Main"
	SkillEngineer  = "engineer"
	SkillReview    = "review"
	// RosterTokenName names the token each agent of the roster is issued, for the Runner.
	RosterTokenName = "runner"
	// RosterTokenTimeout is that token's default heartbeat timeout: the Runner sends Heartbeats
	// while a session shows progress, and a session that shows none lapses on it.
	RosterTokenTimeout = 5 * time.Minute
)

var rosterSkills = []struct{ name, body string }{
	{SkillEngineer, "Build what the Task describes. Work on the Task's branch in its Workspace, test as you go, run the tests, and attach the test log as Evidence. " +
		"Hand the Task over to review when it is built, with a Note saying what changed and how you checked it."},
	{SkillReview, "Review the work a Task describes: read the change on its branch and its Evidence, run the tests, and check it does what the Task asks. " +
		"Complete the Task when it is right, with a Note saying what you checked; hand it back with a Note saying what to fix when it is not. Nobody reviews their own work."},
}

// RosterAgent is one agent of the roster: its Skills and model.
type RosterAgent struct {
	Name   string
	Skills []string
	Model  string
}

// Roster is the agents `darkory init` seeds.
var Roster = []RosterAgent{
	{Name: "planner", Skills: []string{SkillBreakdown}, Model: "claude-opus-5-5"},
	{Name: "builder", Skills: []string{SkillEngineer}, Model: "claude-sonnet-5-5"},
	{Name: "reviewer", Skills: []string{SkillReview, SkillSkillReview}, Model: "claude-opus-5-5"},
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
	// Team, Workspace and Agents are the roster, when InitWith seeded one; Workspace is nil
	// when none was given.
	Team      *Team
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
	// Roster seeds Team MAIN with the first Member in it, the Skills engineer and review, and
	// the Roster's agents in the Team, reporting to the first Member, each with agent settings
	// and a token named RosterTokenName.
	Roster bool
	// Workspace, with Roster, is added and made Team MAIN's default.
	Workspace *NewWorkspace
}

// Init creates the Install's Organisation, its first Member — a human admin — the built-in
// Skills, the default Statuses, a token for that Member and a login link. It refuses when an
// Organisation exists.
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
		for _, b := range builtinSkills {
			if _, err := createSkill(t, b.name, "generic", nil, b.body, true); err != nil {
				return err
			}
		}
		if err := seedStatuses(t); err != nil {
			return err
		}
		if out.Token, err = issueToken(t, memberID, "init", 0); err != nil {
			return err
		}
		if out.Link, err = issueLoginLink(t, memberID, nil); err != nil {
			return err
		}
		if o.Roster {
			return seedRoster(t, memberID, o.Workspace, &out)
		}
		return nil
	})
	if err != nil {
		return out, fmt.Errorf("core: init: %w", err)
	}
	out.Organisation = Organisation{ID: orgID, Name: orgName, CreatedAt: now}
	out.Member, err = getMember(ctx, s.store, orgID, memberID)
	return out, err
}

// seedRoster seeds the roster inside Init's write, the first Member, human, being humanID.
func seedRoster(t *tx, humanID string, nw *NewWorkspace, out *Initialised) error {
	team, err := createTeam(t, RosterTeamKey, RosterTeamName)
	if err != nil {
		return err
	}
	if err := addTeamMember(t, team, humanID); err != nil {
		return err
	}
	if nw != nil {
		ws, err := createWorkspace(t, *nw)
		if err != nil {
			return err
		}
		if _, err := t.Exec(t.ctx, `UPDATE teams SET default_workspace_id = $1 WHERE org_id = $2 AND id = $3`, ws, t.caller.OrgID, team); err != nil {
			return err
		}
		if err := t.recordByCaller("team.changed", team, map[string]any{"default_workspace_id": ws}); err != nil {
			return err
		}
		w, err := getWorkspace(t.ctx, t, t.caller.OrgID, ws)
		if err != nil {
			return err
		}
		out.Workspace = &w
	}
	tm, err := getTeam(t.ctx, t, t.caller.OrgID, team)
	if err != nil {
		return err
	}
	out.Team = &tm
	skills := map[string]string{}
	for _, b := range rosterSkills {
		if skills[b.name], err = createSkill(t, b.name, "generic", nil, b.body, false); err != nil {
			return err
		}
	}
	for _, name := range []string{SkillBreakdown, SkillRetro, SkillSkillReview} {
		if skills[name], err = skillByName(t.ctx, t, t.caller.OrgID, name); err != nil {
			return err
		}
	}
	for _, a := range Roster {
		id, err := createMember(t, NewMember{Name: a.Name, Kind: "agent"})
		if err != nil {
			return err
		}
		if err := addTeamMember(t, team, id); err != nil {
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

// GetMe returns the caller, their Teams and Skills, and the Session they call through.
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
	if me.Teams, err = memberTeams(ctx, s.store, c.OrgID, c.MemberID); err != nil {
		return me, err
	}
	if me.Skills, err = memberSkills(ctx, s.store, c.OrgID, c.MemberID); err != nil {
		return me, err
	}
	me.Session, err = getSession(ctx, s.store, c.OrgID, c.SessionID)
	s.expiry(&me.Session)
	return me, err
}
