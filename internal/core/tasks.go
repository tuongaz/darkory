package core

import (
	"context"

	"github.com/tuongaz/darkory/internal/auth"
)

// NewTask is a Task to file. It needs a Skill or is aimed at a Member, not both.
type NewTask struct {
	Feature     *string
	Title       string
	Description string
	Skill       *string
	AimedAt     *string
	// Blocks names a Task the new one blocks: a question or Escalation. The new Task joins that
	// Task's Feature, even when the Feature has ended.
	Blocks *string
	// Status names the Status it starts in, of an open kind; nil for the first todo one.
	Status *string
	// Workspaces names the Workspaces it names, in order; nil for its Team's default, an empty
	// list for none.
	Workspaces *[]string
}

// FileTask files a Task on a Feature of any Team. A Task that blocks another (a question or an
// Escalation) joins the Feature of the Task it blocks and blocks it in the same write; the asker
// keeps their Claim. Any other Task needs its Feature open: an ended Feature holds no open Task
// but its Retrospective and the questions blocking its Tasks.
func (s *Service) FileTask(ctx context.Context, c *auth.Caller, nt NewTask, idem Idem) (TaskDetail, error) {
	if err := validTitle(nt.Title); err != nil {
		return TaskDetail{}, err
	}
	if nt.Feature == nil && nt.Blocks == nil {
		return TaskDetail{}, refuse(CodeInvalid, "name the feature the Task belongs to, or the Task it blocks")
	}
	if (nt.Skill == nil) == (nt.AimedAt == nil) {
		return TaskDetail{}, refuse(CodeInvalid, "a Task needs a skill or is aimed_at a Member, not both")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		var featureID string
		var blocked *Task
		if nt.Blocks != nil {
			id, err := resolveTask(ctx, t, c.OrgID, *nt.Blocks)
			if err != nil {
				return nil, err
			}
			b, err := getTask(ctx, t, c.OrgID, id, t.now)
			if err != nil {
				return nil, err
			}
			if b.State != "open" {
				return nil, refuse(CodeEnded, "Task %s is %s; a question blocks an open Task", b.Key, b.State)
			}
			bf, err := getFeature(ctx, t, c.OrgID, b.FeatureID, t.now)
			if err != nil {
				return nil, err
			}
			if err := mayBlock(ctx, t, c, b, bf); err != nil {
				return nil, err
			}
			blocked, featureID = &b, b.FeatureID
		}
		if nt.Feature != nil {
			id, err := resolveFeature(ctx, t, c.OrgID, *nt.Feature)
			if err != nil {
				return nil, err
			}
			if blocked != nil && id != featureID {
				return nil, refuse(CodeInvalid, "a Task that blocks %s joins its Feature; leave feature out or name that one", blocked.Key)
			}
			featureID = id
		}
		f, err := getFeature(ctx, t, c.OrgID, featureID, t.now)
		if err != nil {
			return nil, err
		}
		if f.State != "open" && blocked == nil {
			return nil, refuse(CodeEnded, "Feature %s has %s; it takes only questions that block its Tasks", f.Key, f.State)
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
		status, err := fileStatus(t, nt.Status)
		if err != nil {
			return nil, err
		}
		workspaces, err := taskWorkspaces(t, f.TeamID, nt.Workspaces)
		if err != nil {
			return nil, err
		}
		id, key, err := insertTask(t, f, "work", nt.Title, nt.Description, skill, aimed, status.ID)
		if err != nil {
			return nil, err
		}
		if err := nameWorkspaces(t, id, workspaces); err != nil {
			return nil, err
		}
		payload := map[string]any{"key": key, "title": nt.Title, "feature_id": f.ID, "kind": "work", "status_id": status.ID}
		if skill != nil {
			payload["skill_id"] = *skill
		} else {
			payload["aimed_at_id"] = *aimed
		}
		if blocked != nil {
			payload["blocks"] = blocked.ID
		}
		if err := t.recordByCaller("task.filed", id, payload); err != nil {
			return nil, err
		}
		if blocked != nil {
			if _, err := t.Exec(ctx, `INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ($1, $2, $3, $4, $5)`,
				c.OrgID, blocked.ID, id, c.MemberID, ms(t.now)); err != nil {
				return nil, err
			}
			if err := t.recordByCaller("task.blocker_added", blocked.ID, map[string]any{"blocker_id": id, "blocker_key": key}); err != nil {
				return nil, err
			}
		}
		return getTaskDetail(ctx, t, c.OrgID, id, t.now)
	})
	if err != nil {
		return TaskDetail{}, err
	}
	return res.(TaskDetail), nil
}

// insertTask files an open Task on f in status, allocating its display key from f's Team.
func insertTask(t *tx, f Feature, kind, title, description string, skill, aimed *string, status string) (id, key string, err error) {
	var prefix string
	var last int64
	if err := t.QueryRow(t.ctx, `UPDATE teams SET last_number = last_number + 1 WHERE org_id = $1 AND id = $2 RETURNING key_prefix, last_number`,
		t.caller.OrgID, f.TeamID).Scan(&prefix, &last); err != nil {
		return "", "", err
	}
	id, key = newID(), prefix+"-"+itoa64(last)
	_, err = t.Exec(t.ctx, `INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, description, state, skill_id, aimed_at_id,
filed_by, waiting_since, created_at, status_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $11, $12)`,
		id, t.caller.OrgID, f.ID, key, kind, title, description, skill, aimed, t.caller.MemberID, ms(t.now), status)
	return id, key, err
}

// GetTask returns a Task with its Claims, Notes, Evidence, blockers and Observations.
func (s *Service) GetTask(ctx context.Context, c *auth.Caller, ref string) (TaskDetail, error) {
	id, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return TaskDetail{}, err
	}
	return getTaskDetail(ctx, s.store, c.OrgID, id, s.clock.Now())
}

// TaskFilter narrows ListTasks; nil fields do not. Filters are `filter` tokens (filter.go).
type TaskFilter struct {
	Feature, Team, State, Skill, AimedAt, Holder, Status *string
	Filters                                              []string
	Limit                                                int
	Cursor                                               string
}

// ListTasks lists Tasks by their Feature's Rank, then by how long each has waited.
func (s *Service) ListTasks(ctx context.Context, c *auth.Caller, tf TaskFilter) (Page[Task], error) {
	offset, err := decodeCursor(tf.Cursor)
	if err != nil {
		return Page[Task]{}, err
	}
	filters, err := parseFilters(EntityTasks, tf.Filters)
	if err != nil {
		return Page[Task]{}, err
	}
	limit := limitOf(tf.Limit)
	now := s.clock.Now()
	q := &sqlQuery{now: now}
	q.and("t.org_id = " + q.arg(c.OrgID))
	refs := []struct {
		ref     *string
		resolve func(context.Context, storeReader, string, string) (string, error)
		col     string
	}{
		{tf.Feature, resolveFeature, "t.feature_id"},
		{tf.Team, resolveTeam, "f.team_id"},
		{tf.Skill, resolveSkill, "t.skill_id"},
		{tf.AimedAt, resolveMember, "t.aimed_at_id"},
		{tf.Holder, resolveMember, "t.claim_holder_id"},
	}
	for _, r := range refs {
		if r.ref == nil {
			continue
		}
		id, err := r.resolve(ctx, s.store, c.OrgID, *r.ref)
		if err != nil {
			return Page[Task]{}, err
		}
		q.and(r.col + " = " + q.arg(id))
	}
	if tf.Holder != nil {
		q.and("(t.claim_expires_at IS NULL OR t.claim_expires_at > " + q.nowArg() + ")")
	}
	if tf.Status != nil {
		list, err := listStatuses(ctx, s.store, c.OrgID)
		if err != nil {
			return Page[Task]{}, err
		}
		st, err := list.find(*tf.Status)
		if err != nil {
			return Page[Task]{}, err
		}
		q.and("t.status_id = " + q.arg(st.ID))
	}
	if tf.State != nil {
		q.and("t.state = " + q.arg(*tf.State))
	}
	q.narrow(filters)
	items, err := tasksWhere(ctx, s.store, c.OrgID, now, q.sql()+
		` ORDER BY f.rank, t.waiting_since, t.id LIMIT `+q.arg(limit+1)+` OFFSET `+q.arg(offset), q.args...)
	if err != nil {
		return Page[Task]{}, err
	}
	return page(items, offset, limit), nil
}
