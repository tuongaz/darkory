package core

import (
	"context"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// Blocking: one worked Task blocks another until it ends, across Parents if need be (CONTEXT.md);
// a Parent neither blocks nor is blocked. The edges live in the blocks table and the Takeable
// rule reads them; nothing stores "blocked".

// mayBlock refuses a caller who may not change what blocks the Task t: while t is held only its
// holder may (plan invariant 6); otherwise its Owner or a Member of its Project (decisions.md).
func mayBlock(ctx context.Context, r store.Reader, c *auth.Caller, t Task) error {
	if t.Claim != nil {
		return holds(c, t)
	}
	return inProjectOrOwner(ctx, r, c, t, "change, while nobody holds it, what blocks")
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
		task, blocker, err := blockEdge(t, taskRef, blockerRef)
		if err != nil {
			return nil, err
		}
		if task.ID == blocker.ID {
			return nil, refuse(CodeCycle, "Task %s cannot block itself", task.Key)
		}
		if task.State != "open" {
			return nil, refuse(CodeEnded, "Task %s is %s", task.Key, task.State)
		}
		for _, p := range []Task{task, blocker} {
			if p.SubtaskCounts != nil {
				return nil, refuse(CodeConflict, "%s is a Parent, and a Parent neither blocks nor is blocked: block one of its Subtasks", p.Key)
			}
		}
		if err := mayBlock(ctx, t, c, task); err != nil {
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

// RemoveBlocker stops blockerRef blocking taskRef. It needs the same authority as adding it. An
// open question under an ended Parent may not be left blocking no open Task, since an ended
// Parent holds no open Subtask but its Retrospective and the questions blocking its Subtasks
// (ADR 0010): the question is completed or dropped instead.
func (s *Service) RemoveBlocker(ctx context.Context, c *auth.Caller, taskRef, blockerRef string, idem Idem) error {
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, blocker, err := blockEdge(t, taskRef, blockerRef)
		if err != nil {
			return nil, err
		}
		if err := mayBlock(ctx, t, c, task); err != nil {
			return nil, err
		}
		res, err := t.Exec(ctx, `DELETE FROM blocks WHERE org_id = $1 AND task_id = $2 AND blocker_task_id = $3`, c.OrgID, task.ID, blocker.ID)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, nil
		}
		if err := questionStillBlocks(t, blocker); err != nil {
			return nil, err
		}
		return nil, t.recordByCaller("task.blocker_removed", task.ID, map[string]any{"blocker_id": blocker.ID, "blocker_key": blocker.Key})
	})
	return err
}

// questionStillBlocks refuses, once an edge from blocker is gone, to leave blocker open under an
// ended Parent blocking no open Task; the refusal rolls the removal back.
func questionStillBlocks(t *tx, blocker Task) error {
	if blocker.State != "open" || blocker.Kind == "retrospective" || blocker.ParentID == nil {
		return nil
	}
	p, err := getTask(t.ctx, t, t.caller.OrgID, *blocker.ParentID, t.now)
	if err != nil {
		return err
	}
	if p.State == "open" {
		return nil
	}
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM blocks b JOIN tasks bt ON bt.org_id = b.org_id AND bt.id = b.task_id
WHERE b.org_id = $1 AND b.blocker_task_id = $2 AND bt.state = 'open'`, t.caller.OrgID, blocker.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	return refuse(CodeEnded, "%s is %s, and %s may stay open under it only while it blocks an open Task: complete or drop %s instead",
		p.Key, p.State, blocker.Key, blocker.Key)
}

// blockEdge reads the two Tasks of an edge.
func blockEdge(t *tx, taskRef, blockerRef string) (task, blocker Task, err error) {
	if task, err = taskOf(t, taskRef); err != nil {
		return
	}
	blocker, err = taskOf(t, blockerRef)
	return
}
