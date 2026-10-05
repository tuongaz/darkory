package core

import (
	"context"
	"regexp"

	"github.com/tuongaz/darkory/internal/auth"
)

var skillName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// NewSkill is a Skill to create. A company Skill names the generic Skill it builds on.
type NewSkill struct {
	Name      string
	Kind      string
	BaseSkill *string
	Body      string
}

// CreateSkill creates a Skill and publishes its version 1 (admin).
func (s *Service) CreateSkill(ctx context.Context, c *auth.Caller, ns NewSkill, idem Idem) (SkillDetail, error) {
	if err := mustAdmin(c); err != nil {
		return SkillDetail{}, err
	}
	if !skillName.MatchString(ns.Name) {
		return SkillDetail{}, refuse(CodeInvalid, "a Skill name is lower-case letters, digits and dashes, such as qa")
	}
	switch {
	case ns.Kind == "generic" && ns.BaseSkill != nil:
		return SkillDetail{}, refuse(CodeInvalid, "a generic Skill builds on no other Skill")
	case ns.Kind == "company" && ns.BaseSkill == nil:
		return SkillDetail{}, refuse(CodeInvalid, "a company Skill names the generic Skill it builds on in base_skill")
	case ns.Kind != "generic" && ns.Kind != "company":
		return SkillDetail{}, refuse(CodeInvalid, "kind must be generic or company")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		var base *string
		if ns.BaseSkill != nil {
			id, err := resolveSkill(ctx, t, c.OrgID, *ns.BaseSkill)
			if err != nil {
				return nil, err
			}
			b, err := getSkill(ctx, t, c.OrgID, id)
			if err != nil {
				return nil, err
			}
			if b.Kind != "generic" {
				return nil, refuse(CodeInvalid, "a company Skill builds on a generic Skill, and %s is not one", b.Name)
			}
			base = &id
		}
		id, err := createSkill(t, ns.Name, ns.Kind, base, ns.Body, false)
		if err != nil {
			return nil, err
		}
		return getSkillDetail(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return SkillDetail{}, err
	}
	return res.(SkillDetail), nil
}

func createSkill(t *tx, name, kind string, base *string, body string, builtin bool) (string, error) {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM skills WHERE org_id = $1 AND name = $2`, t.caller.OrgID, name).Scan(&n); err != nil {
		return "", err
	}
	if n > 0 {
		return "", refuse(CodeConflict, "a Skill is already named %s", name)
	}
	id := newID()
	var by *string
	if !builtin {
		by = &t.caller.MemberID
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO skills (id, org_id, name, kind, base_skill_id, builtin, current_version, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)`, id, t.caller.OrgID, name, kind, base, builtin, by, ms(t.now)); err != nil {
		return "", err
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO skill_versions (org_id, skill_id, version, body, published_by, published_at)
VALUES ($1, $2, 1, $3, $4, $5)`, t.caller.OrgID, id, body, by, ms(t.now)); err != nil {
		return "", err
	}
	return id, t.record(by, "skill.created", id, map[string]any{"name": name, "kind": kind, "builtin": builtin})
}

// ListSkills lists the Skills by name, optionally of one kind.
func (s *Service) ListSkills(ctx context.Context, c *auth.Caller, kind *string) ([]Skill, error) {
	if kind != nil {
		return collect(ctx, s.store, scanSkill, `SELECT `+skillCols+` FROM skills sk WHERE sk.org_id = $1 AND sk.kind = $2 ORDER BY sk.name`, c.OrgID, *kind)
	}
	return collect(ctx, s.store, scanSkill, `SELECT `+skillCols+` FROM skills sk WHERE sk.org_id = $1 ORDER BY sk.name`, c.OrgID)
}

// GetSkill returns a Skill with its current version.
func (s *Service) GetSkill(ctx context.Context, c *auth.Caller, ref string) (SkillDetail, error) {
	id, err := resolveSkill(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return SkillDetail{}, err
	}
	return getSkillDetail(ctx, s.store, c.OrgID, id)
}

// ListSkillVersions lists a Skill's published versions, newest first.
func (s *Service) ListSkillVersions(ctx context.Context, c *auth.Caller, ref string) ([]SkillVersion, error) {
	id, err := resolveSkill(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return nil, err
	}
	return collect(ctx, s.store, scanSkillVersion, `SELECT `+skillVersionCols+` FROM skill_versions v
WHERE v.org_id = $1 AND v.skill_id = $2 ORDER BY v.version DESC`, c.OrgID, id)
}
