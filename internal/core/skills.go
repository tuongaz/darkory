package core

import (
	"context"
	"database/sql"
	"errors"
	"regexp"

	"github.com/tuongaz/darkory/internal/auth"
)

var skillName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// NewSkill is a Skill to create. A company Skill names the generic Skill it builds on, and may
// name the Project it belongs to, by id or key; with none it is the whole Organisation's.
type NewSkill struct {
	Name      string
	Kind      string
	BaseSkill *string
	Project   *string
	Body      string
}

// CreateSkill creates a Skill and publishes its version 1 (admin).
func (s *Service) CreateSkill(ctx context.Context, c *auth.Caller, ns NewSkill, idem Idem) (SkillDetail, error) {
	if err := mustAdmin(c); err != nil {
		return SkillDetail{}, err
	}
	if !skillName.MatchString(ns.Name) || looksLikeID(ns.Name) {
		return SkillDetail{}, refuse(CodeInvalid, "a Skill name is lower-case letters, digits and dashes, such as qa")
	}
	switch {
	case ns.Kind == "generic" && ns.BaseSkill != nil:
		return SkillDetail{}, refuse(CodeInvalid, "a generic Skill builds on no other Skill")
	case ns.Kind == "company" && ns.BaseSkill == nil:
		return SkillDetail{}, refuse(CodeInvalid, "a company Skill names the generic Skill it builds on in base_skill")
	case ns.Kind != "generic" && ns.Kind != "company":
		return SkillDetail{}, refuse(CodeInvalid, "kind must be generic or company")
	case ns.Kind == "generic" && ns.Project != nil && *ns.Project != "":
		return SkillDetail{}, refuse(CodeInvalid, "a generic Skill belongs to no Project; only a company Skill names one")
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
		var project *string
		if ns.Project != nil && *ns.Project != "" {
			id, err := resolveProject(ctx, t, c.OrgID, *ns.Project)
			if err != nil {
				return nil, err
			}
			project = &id
		}
		id, err := createSkill(t, ns.Name, ns.Kind, base, project, ns.Body, false)
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

// createSkill creates a Skill and its version 1 inside a write, recording skill.created with the
// Project it belongs to, project_id null for the whole Organisation's.
func createSkill(t *tx, name, kind string, base, project *string, body string, builtin bool) (string, error) {
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
	if _, err := t.Exec(t.ctx, `INSERT INTO skills (id, org_id, name, kind, base_skill_id, project_id, builtin, current_version, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`, id, t.caller.OrgID, name, kind, base, project, builtin, by, ms(t.now)); err != nil {
		return "", err
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO skill_versions (org_id, skill_id, version, body, published_by, published_at)
VALUES ($1, $2, 1, $3, $4, $5)`, t.caller.OrgID, id, body, by, ms(t.now)); err != nil {
		return "", err
	}
	var projectID any
	if project != nil {
		projectID = *project
	}
	return id, t.record(by, "skill.created", id, map[string]any{"name": name, "kind": kind, "builtin": builtin, "project_id": projectID})
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

// UpdateSkill sets the Project a company Skill belongs to, by id or key, or with "" makes it the
// whole Organisation's (admin). A Step of one Project cannot carry another Project's company
// Skill, so a Skill some other Project's Step carries is refused invalid. Setting the Project it
// already has changes nothing. Records skill.changed with project_id, null for the Organisation.
func (s *Service) UpdateSkill(ctx context.Context, c *auth.Caller, ref string, project string, idem Idem) (SkillDetail, error) {
	if err := mustAdmin(c); err != nil {
		return SkillDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		id, err := resolveSkill(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		sk, err := getSkill(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if sk.Kind != "company" {
			return nil, refuse(CodeInvalid, "%s is a generic Skill, which belongs to no Project; only a company Skill does", sk.Name)
		}
		var next *string
		if project != "" {
			p, err := resolveProject(ctx, t, c.OrgID, project)
			if err != nil {
				return nil, err
			}
			next = &p
		}
		if (next == nil && sk.ProjectID == nil) || (next != nil && sk.ProjectID != nil && *next == *sk.ProjectID) {
			return getSkillDetail(ctx, t, c.OrgID, id)
		}
		if next != nil {
			var other sql.NullString
			err := t.QueryRow(ctx, `SELECT p.name FROM steps st JOIN projects p ON p.org_id = st.org_id AND p.id = st.project_id
WHERE st.org_id = $1 AND st.skill_id = $2 AND st.project_id <> $3 ORDER BY p.name LIMIT 1`, c.OrgID, id, *next).Scan(&other)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if other.Valid {
				return nil, refuse(CodeInvalid, "a Step of %s carries %s; a company Skill belongs to the one Project whose Steps carry it", other.String, sk.Name)
			}
		}
		if _, err := t.Exec(ctx, `UPDATE skills SET project_id = $1 WHERE org_id = $2 AND id = $3`, next, c.OrgID, id); err != nil {
			return nil, err
		}
		var payload any
		if next != nil {
			payload = *next
		}
		if err := t.recordByCaller("skill.changed", id, map[string]any{"project_id": payload}); err != nil {
			return nil, err
		}
		return getSkillDetail(ctx, t, c.OrgID, id)
	})
	if err != nil {
		return SkillDetail{}, err
	}
	return res.(SkillDetail), nil
}

// stepSkillFits refuses a Step of projectID carrying another Project's company Skill (ADR 0020).
func stepSkillFits(t *tx, projectID, skillID string) error {
	sk, err := getSkill(t.ctx, t, t.caller.OrgID, skillID)
	if err != nil {
		return err
	}
	if sk.ProjectID == nil || *sk.ProjectID == projectID {
		return nil
	}
	p, err := getProject(t.ctx, t, t.caller.OrgID, *sk.ProjectID)
	if err != nil {
		return err
	}
	return refuse(CodeInvalid, "%s is %s's company Skill", sk.Name, p.Name)
}
