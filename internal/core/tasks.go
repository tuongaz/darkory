package core

import (
	"context"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
)

// NewTask is a Task to file. It needs a Skill or is aimed at a Member, not both.
type NewTask struct {
	Feature     *string
	Title       string
	Description string
	Skill       *string
	AimedAt     *string
	// Blocks names a Task the new one blocks (a question or Escalation); built with Blocking.
	Blocks *string
}

// FileTask files a Task on a Feature of any Team.
func (s *Service) FileTask(ctx context.Context, c *auth.Caller, nt NewTask, idem Idem) (TaskDetail, error) {
	if err := validTitle(nt.Title); err != nil {
		return TaskDetail{}, err
	}
	if nt.Blocks != nil {
		return TaskDetail{}, refuse(CodeNotImplemented, "filing a Task that blocks another arrives with Blocking")
	}
	if nt.Feature == nil {
		return TaskDetail{}, refuse(CodeInvalid, "name the feature the Task belongs to")
	}
	if (nt.Skill == nil) == (nt.AimedAt == nil) {
		return TaskDetail{}, refuse(CodeInvalid, "a Task needs a skill or is aimed_at a Member, not both")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		featureID, err := resolveFeature(ctx, t, c.OrgID, *nt.Feature)
		if err != nil {
			return nil, err
		}
		f, err := getFeature(ctx, t, c.OrgID, featureID)
		if err != nil {
			return nil, err
		}
		if f.State != "open" {
			return nil, refuse(CodeEnded, "Feature %s has %s", f.Key, f.State)
		}
		var skill, aimed *string
		if nt.Skill != nil {
			id, err := resolveSkill(ctx, t, c.OrgID, *nt.Skill)
			if err != nil {
				return nil, err
			}
			skill = &id
		} else {
			id, err := resolveMember(ctx, t, c.OrgID, *nt.AimedAt)
			if err != nil {
				return nil, err
			}
			aimed = &id
		}
		var prefix string
		var last int64
		if err := t.QueryRow(ctx, `UPDATE teams SET last_number = last_number + 1 WHERE org_id = $1 AND id = $2 RETURNING key_prefix, last_number`, c.OrgID, f.TeamID).
			Scan(&prefix, &last); err != nil {
			return nil, err
		}
		id, key := newID(), prefix+"-"+itoa64(last)
		if _, err := t.Exec(ctx, `INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, description, state, skill_id, aimed_at_id,
filed_by, waiting_since, created_at) VALUES ($1, $2, $3, $4, 'work', $5, $6, 'open', $7, $8, $9, $10, $10)`,
			id, c.OrgID, featureID, key, nt.Title, nt.Description, skill, aimed, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		payload := map[string]any{"key": key, "title": nt.Title, "feature_id": featureID, "kind": "work"}
		if skill != nil {
			payload["skill_id"] = *skill
		} else {
			payload["aimed_at_id"] = *aimed
		}
		if err := t.recordByCaller("task.filed", id, payload); err != nil {
			return nil, err
		}
		return getTaskDetail(ctx, t, c.OrgID, id, t.now)
	})
	if err != nil {
		return TaskDetail{}, err
	}
	return res.(TaskDetail), nil
}

// GetTask returns a Task with its Claims, Notes, Evidence, blockers and Observations.
func (s *Service) GetTask(ctx context.Context, c *auth.Caller, ref string) (TaskDetail, error) {
	id, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return TaskDetail{}, err
	}
	return getTaskDetail(ctx, s.store, c.OrgID, id, s.clock.Now())
}

// TaskFilter narrows ListTasks; nil fields do not.
type TaskFilter struct {
	Feature, Team, State, Skill, AimedAt, Holder *string
	Limit                                        int
	Cursor                                       string
}

// ListTasks lists Tasks by their Feature's Rank, then by how long each has waited.
func (s *Service) ListTasks(ctx context.Context, c *auth.Caller, tf TaskFilter) (Page[Task], error) {
	offset, err := decodeCursor(tf.Cursor)
	if err != nil {
		return Page[Task]{}, err
	}
	limit := limitOf(tf.Limit)
	now := s.clock.Now()
	where := []string{"t.org_id = $1"}
	args := []any{c.OrgID}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+itoa(len(args))))
	}
	refs := []struct {
		ref     *string
		resolve func(context.Context, storeReader, string, string) (string, error)
		cond    string
	}{
		{tf.Feature, resolveFeature, "t.feature_id = ?"},
		{tf.Team, resolveTeam, "f.team_id = ?"},
		{tf.Skill, resolveSkill, "t.skill_id = ?"},
		{tf.AimedAt, resolveMember, "t.aimed_at_id = ?"},
		{tf.Holder, resolveMember, "t.claim_holder_id = ?"},
	}
	for _, r := range refs {
		if r.ref == nil {
			continue
		}
		id, err := r.resolve(ctx, s.store, c.OrgID, *r.ref)
		if err != nil {
			return Page[Task]{}, err
		}
		add(r.cond, id)
	}
	if tf.Holder != nil {
		add("(t.claim_expires_at IS NULL OR t.claim_expires_at > ?)", ms(now))
	}
	if tf.State != nil {
		add("t.state = ?", *tf.State)
	}
	args = append(args, limit+1, offset)
	items, err := tasksWhere(ctx, s.store, now, strings.Join(where, " AND ")+
		` ORDER BY f.rank, t.waiting_since, t.id LIMIT $`+itoa(len(args)-1)+` OFFSET $`+itoa(len(args)), args...)
	if err != nil {
		return Page[Task]{}, err
	}
	return page(items, offset, limit), nil
}
