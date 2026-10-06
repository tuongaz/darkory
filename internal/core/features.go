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
	// Quick files a quick Feature: its one Task, needing Skill, instead of the Break down (ADR
	// 0014). Workspaces are that Task's, nil for the Team's default.
	Quick      bool
	Skill      *string
	Workspaces *[]string
	// ShipWhenDone is nil for the Team's default; a quick Feature always has it.
	ShipWhenDone *bool
}

func (nf NewFeature) validate() error {
	if err := validTitle(nf.Title); err != nil {
		return err
	}
	switch {
	case nf.Quick && nf.Skill == nil:
		return refuse(CodeInvalid, "a quick Feature names the Skill its one Task needs in skill")
	case nf.Quick && nf.FromRetrospective != nil:
		return refuse(CodeInvalid, "a Retrospective files Features that are broken down; a quick Feature cannot name from_retrospective")
	case nf.Quick && nf.ShipWhenDone != nil && !*nf.ShipWhenDone:
		return refuse(CodeInvalid, "a quick Feature always ships when done")
	case !nf.Quick && nf.Skill != nil:
		return refuse(CodeInvalid, "skill names the Skill a quick Feature's one Task needs; this Feature is not quick")
	case !nf.Quick && nf.Workspaces != nil:
		return refuse(CodeInvalid, "workspaces names a quick Feature's Task's Workspaces; this Feature is not quick")
	}
	return nil
}

// FileFeature files a Feature at the bottom of its Team's Rank, and its Break down Task needing
// the breakdown Skill, in one write (ADR 0010); a quick Feature files its one work Task instead
// (ADR 0014). The filer must be in the Team. Every Task filed names the Team's default Workspace,
// unless a quick Feature names others.
func (s *Service) FileFeature(ctx context.Context, c *auth.Caller, nf NewFeature, idem Idem) (FeatureDetail, error) {
	if err := nf.validate(); err != nil {
		return FeatureDetail{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		team, err := resolveTeam(ctx, t, c.OrgID, nf.Team)
		if err != nil {
			return nil, err
		}
		tm, err := getTeam(ctx, t, c.OrgID, team)
		if err != nil {
			return nil, err
		}
		if in, err := inTeam(ctx, t, c.OrgID, team, c.MemberID); err != nil {
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
			if err := t.QueryRow(ctx, `SELECT kind FROM tasks WHERE org_id = $1 AND id = $2`, c.OrgID, id).Scan(&kind); err != nil {
				return nil, err
			}
			if kind != "retrospective" {
				return nil, refuse(CodeInvalid, "%s is not a Retrospective", *nf.FromRetrospective)
			}
			fromRetro = &id
		}
		shipWhenDone := tm.ShipWhenDone
		if nf.ShipWhenDone != nil {
			shipWhenDone = *nf.ShipWhenDone
		}
		kind, title, description := "breakdown", "Break down: "+nf.Title, ""
		var skill string
		if nf.Quick {
			shipWhenDone, kind, title, description = true, "work", nf.Title, nf.Description
			skill, err = resolveSkill(ctx, t, c.OrgID, *nf.Skill)
		} else {
			skill, err = skillByName(ctx, t, c.OrgID, SkillBreakdown)
		}
		if err != nil {
			return nil, err
		}
		workspaces, err := taskWorkspaces(t, team, nf.Workspaces)
		if err != nil {
			return nil, err
		}
		if nf.Quick && len(workspaces) == 0 {
			return nil, refuse(CodeInvalid, "Team %s has no default Workspace, and a quick Feature's Task works in one: name it in workspaces, "+
				"or set the Team's with darkory team set %s --default-workspace <workspace>", tm.Key, tm.Key)
		}
		// The Feature and its first Task take two numbers from the Team's one counter.
		var prefix string
		var last int64
		if err := t.QueryRow(ctx, `UPDATE teams SET last_number = last_number + 2 WHERE org_id = $1 AND id = $2 RETURNING key_prefix, last_number`, c.OrgID, team).
			Scan(&prefix, &last); err != nil {
			return nil, err
		}
		var rank int64
		if err := t.QueryRow(ctx, `SELECT COALESCE(MAX(rank), 0) + 1 FROM features WHERE org_id = $1 AND team_id = $2`, c.OrgID, team).Scan(&rank); err != nil {
			return nil, err
		}
		featureID, taskID := newID(), newID()
		featureKey, taskKey := prefix+"-"+itoa64(last-1), prefix+"-"+itoa64(last)
		if _, err := t.Exec(ctx, `INSERT INTO features (id, org_id, team_id, display_key, title, description, owner_id, state, rank,
from_retrospective_task_id, quick, ship_when_done, filed_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12, $13)`,
			featureID, c.OrgID, team, featureKey, nf.Title, nf.Description, owner, rank, fromRetro, nf.Quick, shipWhenDone, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		filed := map[string]any{"key": featureKey, "title": nf.Title, "team_id": team, "owner_id": owner}
		if nf.Quick {
			filed["quick"] = true
		}
		if shipWhenDone {
			filed["ship_when_done"] = true
		}
		if err := t.recordByCaller("feature.filed", featureID, filed); err != nil {
			return nil, err
		}
		status, err := fileStatus(t, nil)
		if err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, description, state, skill_id, filed_by,
waiting_since, created_at, status_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $10, $11)`,
			taskID, c.OrgID, featureID, taskKey, kind, title, description, skill, c.MemberID, ms(t.now), status.ID); err != nil {
			return nil, err
		}
		if err := nameWorkspaces(t, taskID, workspaces); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("task.filed", taskID, map[string]any{"key": taskKey, "title": title, "feature_id": featureID, "kind": kind,
			"skill_id": skill, "status_id": status.ID}); err != nil {
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
	p := page(items, offset, limit)
	return p, fillTaskCounts(ctx, s.store, c.OrgID, s.clock.Now(), p.Items)
}

// RankFeature moves a Feature to position within its Team's Rank, 1 first; a position past the
// end moves it last. Ended Features keep their places and count as positions (ADR 0010). By a
// Member of the Feature's Team or its owner.
func (s *Service) RankFeature(ctx context.Context, c *auth.Caller, ref string, position int64, idem Idem) (Feature, error) {
	if position < 1 {
		return Feature{}, refuse(CodeInvalid, "position is 1 or more")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		f, err := featureOf(t, ref)
		if err != nil {
			return nil, err
		}
		if f.OwnerID != c.MemberID {
			in, err := inTeam(ctx, t, c.OrgID, f.TeamID, c.MemberID)
			if err != nil {
				return nil, err
			}
			if !in {
				return nil, refuse(CodeForbidden, "only a Member of the Team or the owner may rank Feature %s", f.Key)
			}
		}
		var n int64
		if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM features WHERE org_id = $1 AND team_id = $2`, c.OrgID, f.TeamID).Scan(&n); err != nil {
			return nil, err
		}
		to, from := min(position, n), f.Rank
		if to == from {
			return f, nil
		}
		// Positions are 1…n; the Features between the two places each move one step.
		shift := `UPDATE features SET rank = rank - 1 WHERE org_id = $1 AND team_id = $2 AND rank > $3 AND rank <= $4`
		lo, hi := from, to
		if to < from {
			shift = `UPDATE features SET rank = rank + 1 WHERE org_id = $1 AND team_id = $2 AND rank >= $3 AND rank < $4`
			lo, hi = to, from
		}
		if _, err := t.Exec(ctx, shift, c.OrgID, f.TeamID, lo, hi); err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `UPDATE features SET rank = $1 WHERE org_id = $2 AND id = $3`, to, c.OrgID, f.ID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("feature.ranked", f.ID, map[string]any{"from": from, "to": to}); err != nil {
			return nil, err
		}
		return getFeature(ctx, t, c.OrgID, f.ID, t.now)
	})
	if err != nil {
		return Feature{}, err
	}
	return res.(Feature), nil
}

// ShipFeature ends a Feature shipped, by its owner, once every one of its Tasks has ended, and
// files its Retrospective in the same write (ADR 0010) unless it is quick (ADR 0014).
func (s *Service) ShipFeature(ctx context.Context, c *auth.Caller, ref string, idem Idem) (FeatureDetail, error) {
	return s.endFeature(ctx, c, ref, "shipped", idem)
}

// DropFeature ends a Feature dropped, by its owner: it drops the Feature's open Tasks, ending
// their Claims, and files its Retrospective in the same write (ADR 0010) unless it is quick.
func (s *Service) DropFeature(ctx context.Context, c *auth.Caller, ref string, idem Idem) (FeatureDetail, error) {
	return s.endFeature(ctx, c, ref, "dropped", idem)
}

func (s *Service) endFeature(ctx context.Context, c *auth.Caller, ref, state string, idem Idem) (FeatureDetail, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		f, err := featureOf(t, ref)
		if err != nil {
			return nil, err
		}
		if f.OwnerID != c.MemberID {
			return nil, refuse(CodeForbidden, "only the owner of Feature %s may ship or drop it", f.Key)
		}
		if f.State != "open" {
			return nil, refuse(CodeEnded, "Feature %s has %s", f.Key, f.State)
		}
		open, err := collect(ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
			var id string
			return id, row.Scan(&id)
		}, `SELECT id FROM tasks WHERE org_id = $1 AND feature_id = $2 AND state = 'open' ORDER BY created_at, id`, c.OrgID, f.ID)
		if err != nil {
			return nil, err
		}
		if state == "shipped" && len(open) > 0 {
			return nil, refuse(CodeTasksOpen, "Feature %s has %d open Tasks; each must end, done or dropped, before it ships", f.Key, len(open))
		}
		if _, err := t.Exec(ctx, `UPDATE features SET state = $1, ended_at = $2 WHERE org_id = $3 AND id = $4`, state, ms(t.now), c.OrgID, f.ID); err != nil {
			return nil, err
		}
		kind, payload := "feature.shipped", map[string]any{}
		if state == "dropped" {
			kind, payload = "feature.dropped", map[string]any{"open_tasks_dropped": len(open)}
		}
		if err := t.recordByCaller(kind, f.ID, payload); err != nil {
			return nil, err
		}
		for _, id := range open {
			if err := dropTask(t, id, map[string]any{"feature_dropped": true}); err != nil {
				return nil, err
			}
		}
		// A quick Feature has no Retrospective (ADR 0014).
		if !f.Quick {
			if err := fileRetrospective(t, f); err != nil {
				return nil, err
			}
		}
		return getFeatureDetail(ctx, t, c.OrgID, f.ID, t.now)
	})
	if err != nil {
		return FeatureDetail{}, err
	}
	return res.(FeatureDetail), nil
}

// fileRetrospective files "Retrospective: <title>" needing the retro Skill on an ended Feature
// (ADR 0010). It sorts by the Feature's Rank, which an ended Feature keeps.
func fileRetrospective(t *tx, f Feature) error {
	retro, err := skillByName(t.ctx, t, t.caller.OrgID, SkillRetro)
	if err != nil {
		return err
	}
	title := "Retrospective: " + f.Title
	status, err := fileStatus(t, nil)
	if err != nil {
		return err
	}
	id, key, err := insertTask(t, f, "retrospective", title, "", &retro, nil, status.ID)
	if err != nil {
		return err
	}
	workspaces, err := taskWorkspaces(t, f.TeamID, nil)
	if err != nil {
		return err
	}
	if err := nameWorkspaces(t, id, workspaces); err != nil {
		return err
	}
	return t.recordByCaller("task.filed", id, map[string]any{"key": key, "title": title, "feature_id": f.ID, "kind": "retrospective",
		"skill_id": retro, "status_id": status.ID})
}

// PassFeatureOwnership makes another Member the Feature's owner: by the owner, or by someone
// above the owner on their Reporting line (decisions.md).
func (s *Service) PassFeatureOwnership(ctx context.Context, c *auth.Caller, ref, ownerRef string, idem Idem) (Feature, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		f, err := featureOf(t, ref)
		if err != nil {
			return nil, err
		}
		if f.OwnerID != c.MemberID {
			above, err := onReportingLine(ctx, t, c.OrgID, f.OwnerID, c.MemberID)
			if err != nil {
				return nil, err
			}
			if !above {
				return nil, refuse(CodeForbidden, "only the owner of Feature %s, or someone above them on their Reporting line, may pass it on", f.Key)
			}
		}
		owner, err := resolveMember(ctx, t, c.OrgID, ownerRef)
		if err != nil {
			return nil, err
		}
		if owner == f.OwnerID {
			return f, nil
		}
		if _, err := t.Exec(ctx, `UPDATE features SET owner_id = $1 WHERE org_id = $2 AND id = $3`, owner, c.OrgID, f.ID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("feature.owner_passed", f.ID, map[string]any{"from": f.OwnerID, "to": owner}); err != nil {
			return nil, err
		}
		return getFeature(ctx, t, c.OrgID, f.ID, t.now)
	})
	if err != nil {
		return Feature{}, err
	}
	return res.(Feature), nil
}

// featureOf reads the Feature ref names inside a write.
func featureOf(t *tx, ref string) (Feature, error) {
	id, err := resolveFeature(t.ctx, t, t.caller.OrgID, ref)
	if err != nil {
		return Feature{}, err
	}
	return getFeature(t.ctx, t, t.caller.OrgID, id, t.now)
}

func itoa64(n int64) string { return itoa(int(n)) }
