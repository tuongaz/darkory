package core

import (
	"context"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// Blocking: one Task blocks another until it ends, across Features if need be (CONTEXT.md). The
// edges live in the blocks table and the Takeable rule reads them; nothing stores "blocked".

// mayBlock refuses a caller who may not change what blocks the Task t of Feature f: while t is
// held only its holder may (plan invariant 6); otherwise its Feature's owner or a Member of the
// Feature's Team (decisions.md).
func mayBlock(ctx context.Context, r store.Reader, c *auth.Caller, t Task, f Feature) error {
	if t.Claim != nil {
		return holds(c, t)
	}
	if f.OwnerID == c.MemberID {
		return nil
	}
	in, err := inTeam(ctx, r, c.OrgID, f.TeamID, c.MemberID)
	if err != nil {
		return err
	}
	if !in {
		return refuse(CodeForbidden, "while nobody holds Task %s, only its Feature's owner or a Member of its Team may change what blocks it", t.Key)
	}
	return nil
}

// blocksTransitively reports whether task already blocks other, directly or through other Tasks:
// it walks up other's blockers with a recursive query. Run inside a write, after the counter, so
// two opposite edges added at once never both pass (ADR 0011).
func blocksTransitively(t *tx, task, other string) (bool, error) {
	var n int
	err := t.QueryRow(t.ctx, `WITH RECURSIVE up(id) AS (
	SELECT blocker_task_id FROM blocks WHERE org_id = $1 AND task_id = $2
	UNION
	SELECT b.blocker_task_id FROM blocks b JOIN up ON b.task_id = up.id WHERE b.org_id = $1
) SELECT COUNT(*) FROM up WHERE id = $3`, t.caller.OrgID, other, task).Scan(&n)
	return n > 0, err
}

// AddBlocker lets blockerRef block taskRef: taskRef is not takeable until blockerRef has ended.
// An edge that would close a loop is refused with cycle.
func (s *Service) AddBlocker(ctx context.Context, c *auth.Caller, taskRef, blockerRef string, idem Idem) error {
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, blocker, f, err := blockEdge(t, taskRef, blockerRef)
		if err != nil {
			return nil, err
		}
		if task.ID == blocker.ID {
			return nil, refuse(CodeCycle, "Task %s cannot block itself", task.Key)
		}
		if task.State != "open" {
			return nil, refuse(CodeEnded, "Task %s is %s", task.Key, task.State)
		}
		if err := mayBlock(ctx, t, c, task, f); err != nil {
			return nil, err
		}
		var n int
		if err := t.QueryRow(ctx, `SELECT COUNT(*) FROM blocks WHERE org_id = $1 AND task_id = $2 AND blocker_task_id = $3`,
			c.OrgID, task.ID, blocker.ID).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, nil
		}
		loops, err := blocksTransitively(t, task.ID, blocker.ID)
		if err != nil {
			return nil, err
		}
		if loops {
			return nil, refuse(CodeCycle, "%s already blocks %s, so %s cannot block %s", task.Key, blocker.Key, blocker.Key, task.Key)
		}
		if _, err := t.Exec(ctx, `INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ($1, $2, $3, $4, $5)`,
			c.OrgID, task.ID, blocker.ID, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		return nil, t.recordByCaller("task.blocker_added", task.ID, map[string]any{"blocker_id": blocker.ID, "blocker_key": blocker.Key})
	})
	return err
}

// RemoveBlocker stops blockerRef blocking taskRef. It needs the same authority as adding it.
func (s *Service) RemoveBlocker(ctx context.Context, c *auth.Caller, taskRef, blockerRef string, idem Idem) error {
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, blocker, f, err := blockEdge(t, taskRef, blockerRef)
		if err != nil {
			return nil, err
		}
		if err := mayBlock(ctx, t, c, task, f); err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM blocks WHERE org_id = $1 AND task_id = $2 AND blocker_task_id = $3`, c.OrgID, task.ID, blocker.ID)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		return nil, t.recordByCaller("task.blocker_removed", task.ID, map[string]any{"blocker_id": blocker.ID, "blocker_key": blocker.Key})
	})
	return err
}

// blockEdge reads the two Tasks of an edge and the blocked Task's Feature.
func blockEdge(t *tx, taskRef, blockerRef string) (task, blocker Task, f Feature, err error) {
	org := t.caller.OrgID
	taskID, err := resolveTask(t.ctx, t, org, taskRef)
	if err != nil {
		return
	}
	blockerID, err := resolveTask(t.ctx, t, org, blockerRef)
	if err != nil {
		return
	}
	if task, err = getTask(t.ctx, t, org, taskID, t.now); err != nil {
		return
	}
	if blocker, err = getTask(t.ctx, t, org, blockerID, t.now); err != nil {
		return
	}
	f, err = getFeature(t.ctx, t, org, task.FeatureID, t.now)
	return
}
