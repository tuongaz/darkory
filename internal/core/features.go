package core

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/auth"
)

func validTitle(title string) error {
	if strings.TrimSpace(title) == "" || utf8.RuneCountInString(title) > 200 {
		return refuse(CodeInvalid, "a title is 1 to 200 characters")
	}
	return nil
}

// NewFeature is a Feature to file.
type NewFeature struct {
	Team        string
	Title       string
	Description string
	// Owner defaults to the filer.
	Owner *string
	// FromRetrospective names the Retrospective Task filing the Feature.
	FromRetrospective *string
}

// FileFeature files a Feature at the bottom of its Team's Rank, and its Break down Task needing
// the breakdown Skill, in one write (ADR 0010). The filer must be in the Team.
func (s *Service) FileFeature(ctx context.Context, c *auth.Caller, nf NewFeature, idem Idem) (FeatureDetail, error) {
	if err := validTitle(nf.Title); err != nil {
		return FeatureDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		team, err := resolveTeam(ctx, t, c.OrgID, nf.Team)
		if err != nil {
			return nil, err
		}
		if in, err := inTeam(ctx, t, team, c.MemberID); err != nil {
			return nil, err
		} else if !in {
			return nil, refuse(CodeForbidden, "only a Member of Team %s may file a Feature in it", nf.Team)
		}
		owner := c.MemberID
		if nf.Owner != nil {
			if owner, err = resolveMember(ctx, t, c.OrgID, *nf.Owner); err != nil {
				return nil, err
			}
		}
		var fromRetro *string
		if nf.FromRetrospective != nil {
			id, err := resolveTask(ctx, t, c.OrgID, *nf.FromRetrospective)
			if err != nil {
				return nil, err
			}
			var kind string
			if err := t.QueryRow(ctx, `SELECT kind FROM tasks WHERE id = $1`, id).Scan(&kind); err != nil {
				return nil, err
			}
			if kind != "retrospective" {
				return nil, refuse(CodeInvalid, "%s is not a Retrospective", *nf.FromRetrospective)
			}
			fromRetro = &id
		}
		breakdown, err := skillByName(ctx, t, c.OrgID, SkillBreakdown)
		if err != nil {
			return nil, err
		}
		// The Feature and its Break down take two numbers from the Team's one counter.
		var prefix string
		var last int64
		if err := t.QueryRow(ctx, `UPDATE teams SET last_number = last_number + 2 WHERE id = $1 RETURNING key_prefix, last_number`, team).
			Scan(&prefix, &last); err != nil {
			return nil, err
		}
		var rank int64
		if err := t.QueryRow(ctx, `SELECT COALESCE(MAX(rank), 0) + 1 FROM features WHERE team_id = $1`, team).Scan(&rank); err != nil {
			return nil, err
		}
		featureID, taskID := newID(), newID()
		featureKey, taskKey := prefix+"-"+itoa64(last-1), prefix+"-"+itoa64(last)
		if _, err := t.Exec(ctx, `INSERT INTO features (id, org_id, team_id, display_key, title, description, owner_id, state, rank,
from_retrospective_task_id, filed_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11)`,
			featureID, c.OrgID, team, featureKey, nf.Title, nf.Description, owner, rank, fromRetro, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("feature.filed", featureID, map[string]any{"key": featureKey, "title": nf.Title, "team_id": team, "owner_id": owner}); err != nil {
			return nil, err
		}
		title := "Break down: " + nf.Title
		if _, err := t.Exec(ctx, `INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, state, skill_id, filed_by, waiting_since, created_at)
VALUES ($1, $2, $3, $4, 'breakdown', $5, 'open', $6, $7, $8, $8)`, taskID, c.OrgID, featureID, taskKey, title, breakdown, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.filed", taskID, map[string]any{"key": taskKey, "title": title, "feature_id": featureID, "kind": "breakdown", "skill_id": breakdown}); err != nil {
			return nil, err
		}
		return getFeatureDetail(ctx, t, c.OrgID, featureID, t.now)
	})
	if err != nil {
		return FeatureDetail{}, err
	}
	return res.(FeatureDetail), nil
}

// GetFeature returns a Feature with its Tasks and Evidence.
func (s *Service) GetFeature(ctx context.Context, c *auth.Caller, ref string) (FeatureDetail, error) {
	id, err := resolveFeature(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return FeatureDetail{}, err
	}
	return getFeatureDetail(ctx, s.store, c.OrgID, id, s.clock.Now())
}

// FeatureFilter narrows ListFeatures; nil fields do not.
type FeatureFilter struct {
	Team, State, Owner *string
	Limit              int
	Cursor             string
}

// ListFeatures lists Features by Team, then Rank.
func (s *Service) ListFeatures(ctx context.Context, c *auth.Caller, ff FeatureFilter) (Page[Feature], error) {
	offset, err := decodeCursor(ff.Cursor)
	if err != nil {
		return Page[Feature]{}, err
	}
	limit := limitOf(ff.Limit)
	where := []string{"f.org_id = $1"}
	args := []any{c.OrgID}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+itoa(len(args))))
	}
	if ff.Team != nil {
		id, err := resolveTeam(ctx, s.store, c.OrgID, *ff.Team)
		if err != nil {
			return Page[Feature]{}, err
		}
		add("f.team_id = ?", id)
	}
	if ff.State != nil {
		add("f.state = ?", *ff.State)
	}
	if ff.Owner != nil {
		id, err := resolveMember(ctx, s.store, c.OrgID, *ff.Owner)
		if err != nil {
			return Page[Feature]{}, err
		}
		add("f.owner_id = ?", id)
	}
	args = append(args, limit+1, offset)
	items, err := collect(ctx, s.store, scanFeature, `SELECT `+featureCols+` FROM features f JOIN teams tm ON tm.id = f.team_id
WHERE `+strings.Join(where, " AND ")+` ORDER BY tm.name, f.rank, f.id LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return Page[Feature]{}, err
	}
	return page(items, offset, limit), nil
}

func itoa64(n int64) string { return itoa(int(n)) }
