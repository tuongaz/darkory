package core

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// How a Task moves between Members besides Advance: Notes and Observations written while holding
// it, take-back up the Reporting line or by the Owner, a human moving it to another Step by hand,
// and the Owner's drop.

// AddNote adds a Note to a Task's running log. Notes stay on the Task, so they carry its context
// across a Handover. A held Task takes Notes from its holder alone, in one batch, under the Skill
// of their Claim; a Task nobody holds, open or ended, from its Owner or a Member of its Project,
// under no Skill, as the Runner notes a merge on a Task just completed.
func (s *Service) AddNote(ctx context.Context, c *auth.Caller, ref, body string, idem Idem) (Note, error) {
	if strings.TrimSpace(body) == "" {
		return Note{}, refuse(CodeInvalid, "a Note has a body")
	}
	taskID, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return Note{}, err
	}
	t, err := getTask(ctx, s.store, c.OrgID, taskID, s.clock.Now())
	if err != nil {
		return Note{}, err
	}
	if t.Claim == nil {
		return s.addUnheldNote(ctx, c, taskID, body, idem)
	}
	res, err := s.heldWrite(ctx, c, taskID, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		n := Note{ID: newID(), TaskID: pre.ID, AuthorID: c.MemberID, SkillID: pre.Claim.SkillID, Body: body, CreatedAt: now}
		return n, []store.Stmt{
			noteStmt(pre, args, n.ID, body),
			activityStmt(c.OrgID, &c.MemberID, "task.note_added", pre.ID, map[string]any{"note_id": n.ID}, now),
		}, nil
	}})
	if err != nil {
		return Note{}, err
	}
	return res.(Note), nil
}

// addUnheldNote adds a Note to a Task that was read unheld. The write reads it again under the
// counter: claimed since, it takes the Note from the holder alone, under their Claim's Skill.
func (s *Service) addUnheldNote(ctx context.Context, c *auth.Caller, taskID, body string, idem Idem) (Note, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		var skill *string
		if task.Claim != nil {
			if err := holds(c, task); err != nil {
				return nil, err
			}
			skill = task.Claim.SkillID
		} else if err := inProjectOrOwner(ctx, t, c, task, "add a Note, while nobody holds it, to"); err != nil {
			return nil, err
		}
		n := Note{ID: newID(), TaskID: taskID, AuthorID: c.MemberID, SkillID: skill, Body: body, CreatedAt: t.now}
		if _, err := t.Exec(ctx, `INSERT INTO notes (id, org_id, task_id, author_id, skill_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			n.ID, c.OrgID, taskID, c.MemberID, skill, body, ms(t.now)); err != nil {
			return nil, err
		}
		return n, t.recordByCaller("task.note_added", taskID, map[string]any{"note_id": n.ID})
	})
	if err != nil {
		return Note{}, err
	}
	return res.(Note), nil
}

// addNote adds a Note by the caller under skill inside a write, recording task.note_added.
func addNote(t *tx, taskID string, skill *string, body string) error {
	id := newID()
	if _, err := t.Exec(t.ctx, `INSERT INTO notes (id, org_id, task_id, author_id, skill_id, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, t.caller.OrgID, taskID, t.caller.MemberID, skill, body, ms(t.now)); err != nil {
		return err
	}
	return t.recordByCaller("task.note_added", taskID, map[string]any{"note_id": id})
}

// Observe records an Observation on a Task the caller holds, marked worked or didn't work, with
// the Skill they hold it under, in one batch (ADR 0010). It feeds the Retrospective of the Task's
// Parent.
func (s *Service) Observe(ctx context.Context, c *auth.Caller, ref, outcome, body string, idem Idem) (Observation, error) {
	if outcome != "worked" && outcome != "didnt_work" {
		return Observation{}, refuse(CodeInvalid, "outcome is worked or didnt_work")
	}
	if strings.TrimSpace(body) == "" {
		return Observation{}, refuse(CodeInvalid, "an Observation has a body")
	}
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		o := Observation{ID: newID(), TaskID: pre.ID, AuthorID: c.MemberID, SkillID: pre.Claim.SkillID, Outcome: outcome, Body: body, CreatedAt: now}
		a := with(args, map[string]any{"id": o.ID, "skill": o.SkillID, "outcome": outcome, "body": body})
		return o, []store.Stmt{
			store.S(`INSERT INTO observations (id, org_id, task_id, author_id, skill_id, outcome, body, created_at)
VALUES (@id, @org, @task, @member, CAST(@skill AS TEXT), @outcome, @body, @now)`, a),
			activityStmt(c.OrgID, &c.MemberID, "task.observed", pre.ID, map[string]any{"observation_id": o.ID, "outcome": outcome}, now),
		}, nil
	}})
	if err != nil {
		return Observation{}, err
	}
	return res.(Observation), nil
}

// mayTakeBack refuses a caller who may not end another Member's Claim on task: only its Owner or
// someone above the holder on their Reporting line may (plan invariant 6's exception).
func mayTakeBack(ctx context.Context, r store.Reader, c *auth.Caller, task Task, verb string) error {
	if task.OwnerID == c.MemberID {
		return nil
	}
	above, err := onReportingLine(ctx, r, c.OrgID, task.Claim.HolderID, c.MemberID)
	if err != nil {
		return err
	}
	if !above {
		return refuse(CodeForbidden, "only the Owner of %s or someone above its holder on their Reporting line may %s it while it is held", task.Key, verb)
	}
	return nil
}

// TakeBack ends another Member's Claim on a Task: by its Owner or anyone above the holder on
// their Reporting line. The Task stays at its Step and is takeable again, and the holder's next
// Heartbeat reports taken_back.
func (s *Service) TakeBack(ctx context.Context, c *auth.Caller, ref string, reason *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := taskOf(t, ref)
		if err != nil {
			return nil, err
		}
		if task.Claim == nil {
			return nil, refuse(CodeNotHolder, "nobody holds Task %s", task.Key)
		}
		if err := mayTakeBack(ctx, t, c, task, "take back"); err != nil {
			return nil, err
		}
		if err := takeBack(t, task, reason); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, task.ID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// takeBack ends task's live Claim as taken_back by the caller inside a write.
func takeBack(t *tx, task Task, reason *string) error {
	claim := task.Claim
	if _, err := t.Exec(t.ctx, `UPDATE claims SET ended_at = $1, how_ended = 'taken_back', ended_by = $2 WHERE org_id = $3 AND id = $4`,
		ms(t.now), t.caller.MemberID, t.caller.OrgID, claim.ID); err != nil {
		return err
	}
	if _, err := t.Exec(t.ctx, clearClaimSQL+` WHERE org_id = $1 AND id = $2 AND claim_id = $3`, t.caller.OrgID, task.ID, claim.ID); err != nil {
		return err
	}
	payload := map[string]any{"claim_id": claim.ID, "holder_id": claim.HolderID}
	if reason != nil && *reason != "" {
		payload["reason"] = *reason
	}
	return t.recordByCaller("task.taken_back", task.ID, payload)
}

// MoveTask moves an open Task that is not a Parent to a Step of its Project's Workflow by hand
// (ADR 0016), which is the only way out of a hold: by any Member of the Project or its Owner. A
// held Task may be moved only by whoever may take it back, and the move ends the Claim
// taken_back first; anyone else in the Project is refused held, and anyone outside it forbidden.
// A Task aimed at a Member then waits at the Step instead. A Note, when given, is the mover's,
// under no Skill. Naming the Step it is at writes nothing.
func (s *Service) MoveTask(ctx context.Context, c *auth.Caller, ref, stepRef string, note *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := taskOf(t, ref)
		if err != nil {
			return nil, err
		}
		switch {
		case task.State != "open":
			return nil, refuse(CodeEnded, "Task %s is %s, and stays where it ended", task.Key, task.State)
		case task.SubtaskCounts != nil:
			return nil, refuse(CodeConflict, "%s is a Parent, at no Step: its Subtasks are moved instead", task.Key)
		}
		if task.Claim != nil {
			if err := mayTakeBack(ctx, t, c, task, "move"); codeOf(err) == CodeForbidden {
				// Someone who may move it once it is free is told it is held; anyone else, that
				// they may not move it at all.
				if err := inProjectOrOwner(ctx, t, c, task, "move"); err != nil {
					return nil, err
				}
				return nil, refuse(CodeHeld, "Task %s is held; only its Owner or someone above its holder on their Reporting line may move it while it is held, and its holder advances it", task.Key)
			} else if err != nil {
				return nil, err
			}
		} else if err := inProjectOrOwner(ctx, t, c, task, "move"); err != nil {
			return nil, err
		}
		st, err := stepOf(ctx, t, c.OrgID, task.ProjectID, stepRef)
		if err != nil {
			return nil, err
		}
		if task.StepID != nil && *task.StepID == st.ID {
			return task, nil
		}
		if task.Claim != nil {
			if err := takeBack(t, task, ptr("moved to "+st.Name)); err != nil {
				return nil, err
			}
		}
		if note != nil && strings.TrimSpace(*note) != "" {
			if err := addNote(t, task.ID, nil, *note); err != nil {
				return nil, err
			}
		}
		if err := moveToStep(t, task.ID, task.StepID, st.ID, nil); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, task.ID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// moveToStep puts a Task at the Step to inside a write, aimed at no one and waiting there from
// now, and records task.moved with the Step it left, extra added to its payload.
func moveToStep(t *tx, taskID string, from *string, to string, extra map[string]any) error {
	var since sql.NullInt64
	if err := t.QueryRow(t.ctx, `SELECT step_since FROM tasks WHERE org_id = $1 AND id = $2`, t.caller.OrgID, taskID).Scan(&since); err != nil {
		return err
	}
	if _, err := t.Exec(t.ctx, `UPDATE tasks SET step_id = $1, step_since = $2, waiting_since = $2, aimed_at_id = NULL WHERE org_id = $3 AND id = $4`,
		to, ms(t.now), t.caller.OrgID, taskID); err != nil {
		return err
	}
	payload := map[string]any{"to": to}
	if from != nil {
		payload["from"] = *from
		if since.Valid {
			payload["since"] = since.Int64
		}
	}
	for k, v := range extra {
		payload[k] = v
	}
	return t.recordByCaller("task.moved", taskID, payload)
}

// DropTask ends a Task dropped: by its Owner only, who may do it while another Member holds it
// (plan invariant 6's exception). Any Claim on it ends. Dropping a Parent drops its open Subtasks
// and files its Retrospective in the same write (ADR 0010).
func (s *Service) DropTask(ctx context.Context, c *auth.Caller, ref string, reason *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := taskOf(t, ref)
		if err != nil {
			return nil, err
		}
		if task.OwnerID != c.MemberID {
			return nil, refuse(CodeForbidden, "only the Owner of %s may drop it", task.Key)
		}
		if task.State != "open" {
			return nil, refuse(CodeEnded, "Task %s is %s", task.Key, task.State)
		}
		payload := map[string]any{}
		if reason != nil && *reason != "" {
			payload["reason"] = *reason
		}
		if task.SubtaskCounts == nil {
			if err := dropTask(t, task, payload); err != nil {
				return nil, err
			}
			return getTask(ctx, t, c.OrgID, task.ID, t.now)
		}
		open, err := tasksWhere(ctx, t, c.OrgID, t.now, `t.org_id = $1 AND t.parent_id = $2 AND t.state = 'open' ORDER BY t.created_at, t.id`,
			c.OrgID, task.ID)
		if err != nil {
			return nil, err
		}
		payload["open_subtasks_dropped"] = len(open)
		if err := dropTask(t, task, payload); err != nil {
			return nil, err
		}
		for _, sub := range open {
			if err := dropTask(t, sub, map[string]any{"parent_dropped": true}); err != nil {
				return nil, err
			}
		}
		if err := fileRetrospective(t, task); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, task.ID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// dropTask ends an open Task dropped inside a write: it ends the Task's Claim, takes it off its
// Step, keeping it as the Step it ended at (last_step_id), supersedes a proposal left pending on
// it and records task.dropped with payload and the Step it left.
func dropTask(t *tx, task Task, payload map[string]any) error {
	claim, holder, live, err := endClaimOf(t, task.ID, "dropped")
	if err != nil {
		return err
	}
	if live {
		payload["claim_id"], payload["holder_id"] = claim, holder
	}
	if task.StepID != nil {
		payload["from"] = *task.StepID
		if task.StepSince != nil {
			payload["since"] = ms(*task.StepSince)
		}
	}
	if _, err := t.Exec(t.ctx, `UPDATE tasks SET state = 'dropped', ended_at = $1, last_step_id = step_id, step_id = NULL, step_since = NULL
WHERE org_id = $2 AND id = $3`,
		ms(t.now), t.caller.OrgID, task.ID); err != nil {
		return err
	}
	if _, err := t.Exec(t.ctx, `UPDATE skill_proposals SET state = 'superseded', decided_at = $1
WHERE org_id = $2 AND task_id = $3 AND state = 'pending'`, ms(t.now), t.caller.OrgID, task.ID); err != nil {
		return err
	}
	return t.recordByCaller("task.dropped", task.ID, payload)
}

// endClaimOf ends the Task's current Claim, if it has one, as how by the caller and clears the
// Task's claim columns. A Claim that had already run out ended at its expiry: it is recorded as
// lapsed, with no actor, as the claim path records it. live says whether the Claim was still live.
func endClaimOf(t *tx, taskID, how string) (claimID, holderID string, live bool, err error) {
	var expires sql.NullInt64
	err = t.QueryRow(t.ctx, `SELECT c.id, c.holder_id, tk.claim_expires_at FROM tasks tk JOIN claims c ON c.id = tk.claim_id
WHERE tk.org_id = $1 AND tk.id = $2 AND c.org_id = $1 AND c.ended_at IS NULL`, t.caller.OrgID, taskID).Scan(&claimID, &holderID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	endedAt, endedHow, by := ms(t.now), how, &t.caller.MemberID
	live = !expires.Valid || expires.Int64 > ms(t.now)
	if !live {
		endedAt, endedHow, by = expires.Int64, "lapsed", nil
	}
	if _, err := t.Exec(t.ctx, `UPDATE claims SET ended_at = $1, how_ended = $2, ended_by = $3 WHERE org_id = $4 AND id = $5`,
		endedAt, endedHow, by, t.caller.OrgID, claimID); err != nil {
		return "", "", false, err
	}
	if _, err := t.Exec(t.ctx, clearClaimSQL+` WHERE org_id = $1 AND id = $2 AND claim_id = $3`, t.caller.OrgID, taskID, claimID); err != nil {
		return "", "", false, err
	}
	if !live {
		err = t.record(nil, "task.lapsed", taskID, map[string]any{"claim_id": claimID, "holder_id": holderID, "how_ended": "lapsed"})
	}
	return claimID, holderID, live, err
}

// onReportingLine reports whether above directs member, directly or through others: it walks up
// member's Reporting line, which never loops (SetManager refuses that).
func onReportingLine(ctx context.Context, r store.Reader, orgID, member, above string) (bool, error) {
	var n int
	err := r.QueryRow(ctx, `WITH RECURSIVE up(id) AS (
	SELECT manager_id FROM reporting_lines WHERE org_id = $1 AND member_id = $2
	UNION
	SELECT rl.manager_id FROM reporting_lines rl JOIN up ON rl.member_id = up.id WHERE rl.org_id = $1
) SELECT COUNT(*) FROM up WHERE id = $3`, orgID, member, above).Scan(&n)
	return n > 0, err
}
