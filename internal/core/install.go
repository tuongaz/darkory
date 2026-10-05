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
}

// Init creates the Install's Organisation, its first Member — a human admin — the built-in
// Skills, a token for that Member and a login link. It refuses when an Organisation exists.
func (s *Service) Init(ctx context.Context, orgName, memberName string) (Initialised, error) {
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
	if err := validName("Member name", memberName); err != nil {
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
		if out.Token, err = issueToken(t, memberID, "init", 0); err != nil {
			return err
		}
		out.Link, err = issueLoginLink(t, memberID, nil)
		return err
	})
	if err != nil {
		return out, fmt.Errorf("core: init: %w", err)
	}
	out.Organisation = Organisation{ID: orgID, Name: orgName, CreatedAt: now}
	out.Member, err = getMember(ctx, s.store, orgID, memberID)
	return out, err
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
WHERE m.org_id = $1 AND m.kind = 'human' ORDER BY m.admin DESC, m.created_at, m.id LIMIT 1`, orgID))
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
	return me, err
}
