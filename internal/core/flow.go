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

// How a Task moves between Members: Handover to the next Skill, Notes and Observations written
// while holding it, take-back up the Reporting line, and the Feature owner's drop.

// Handover ends the caller's Claim and sets the Skill the Task needs next, in one batch (ADR
// 0001). The Task waits for that Skill from now; it is no longer aimed at a Member. The Claim
// rows keep who held it under which Skill, which is what keeps a builder from reviewing their own
// work (the Takeable rule's last clause).
func (s *Service) Handover(ctx context.Context, c *auth.Caller, ref, skillRef string, note *string, idem Idem) (Task, error) {
	skillID, err := resolveSkill(ctx, s.store, c.OrgID, skillRef)
	if err != nil {
		return Task{}, err
	}
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		out := pre
		out.Claim, out.SkillID, out.AimedAtID, out.WaitingSince = nil, &skillID, nil, now
		a := with(args, map[string]any{"to": skillID})
		stmts := []store.Stmt{
			store.S(`UPDATE claims SET ended_at = @now, how_ended = 'handed_over', ended_by = @member WHERE org_id = @org AND id = @claim`, a),
			store.S(clearClaimSQL+`, skill_id = @to, aimed_at_id = NULL, waiting_since = @now WHERE org_id = @org AND id = @task`, a),
		}
		if note != nil && *note != "" {
			stmts = append(stmts, noteStmt(pre, args, newID(), *note))
		}
		payload := map[string]any{"claim_id": pre.Claim.ID, "skill_id": skillID}
		if pre.SkillID != nil {
			payload["from_skill_id"] = *pre.SkillID
		}
		stmts = append(stmts, activityStmt(c.OrgID, &c.MemberID, "task.handed_over", pre.ID, payload, now))
		return out, stmts, nil
	}})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// AddNote adds a Note to the running log of a Task the caller holds, in one batch. Notes stay on
// the Task, so they carry its context across a Handover.
func (s *Service) AddNote(ctx context.Context, c *auth.Caller, ref, body string, idem Idem) (Note, error) {
	if strings.TrimSpace(body) == "" {
		return Note{}, refuse(CodeInvalid, "a Note has a body")
	}
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
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

// Observe records an Observation on a Task the caller holds, marked worked or didn't work, with
// the Skill they hold it under, in one batch (ADR 0010).
func (s *Service) Observe(ctx context.Context, c *auth.Caller, ref, outcome, body string, idem Idem) (Observation, error) {
	if outcome != "worked" && outcome != "didnt_work" {
		return Observation{}, refuse(CodeInvalid, "outcome is worked or didnt_work")
	}
	if strings.TrimSpace(body) == "" {
		return Observation{}, refuse(CodeInvalid, "an Observation has a body")
	}
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		o := Observation{ID: newID(), TaskID: pre.ID, FeatureID: pre.FeatureID, AuthorID: c.MemberID, SkillID: pre.Claim.SkillID,
			Outcome: outcome, Body: body, CreatedAt: now}
		a := with(args, map[string]any{"id": o.ID, "feature": o.FeatureID, "skill": o.SkillID, "outcome": outcome, "body": body})
		return o, []store.Stmt{
			store.S(`INSERT INTO observations (id, org_id, task_id, feature_id, author_id, skill_id, outcome, body, created_at)
VALUES (@id, @org, @task, @feature, @member, CAST(@skill AS TEXT), @outcome, @body, @now)`, a),
			activityStmt(c.OrgID, &c.MemberID, "task.observed", pre.ID, map[string]any{"observation_id": o.ID, "outcome": outcome}, now),
		}, nil
	}})
	if err != nil {
		return Observation{}, err
	}
	return res.(Observation), nil
}

// TakeBack ends another Member's Claim on a Task: by anyone above the holder on their Reporting
// line, or by the Feature owner (plan invariant 6's exception). The Task becomes takeable again,
// and the holder's next Heartbeat reports taken_back.
func (s *Service) TakeBack(ctx context.Context, c *auth.Caller, ref string, reason *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		taskID, err := resolveTask(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		if task.Claim == nil {
			return nil, refuse(CodeNotHolder, "nobody holds Task %s", task.Key)
		}
		f, err := getFeature(ctx, t, c.OrgID, task.FeatureID, t.now)
		if err != nil {
			return nil, err
		}
		if f.OwnerID != c.MemberID {
			above, err := onReportingLine(ctx, t, c.OrgID, task.Claim.HolderID, c.MemberID)
			if err != nil {
				return nil, err
			}
			if !above {
				return nil, refuse(CodeForbidden, "only the Feature owner or someone above the holder on their Reporting line may take back Task %s", task.Key)
			}
		}
		claim := task.Claim
		if _, err := t.Exec(ctx, `UPDATE claims SET ended_at = $1, how_ended = 'taken_back', ended_by = $2 WHERE org_id = $3 AND id = $4`,
			ms(t.now), c.MemberID, c.OrgID, claim.ID); err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, clearClaimSQL+` WHERE org_id = $1 AND id = $2 AND claim_id = $3`, c.OrgID, taskID, claim.ID); err != nil {
			return nil, err
		}
		payload := map[string]any{"claim_id": claim.ID, "holder_id": claim.HolderID}
		if reason != nil && *reason != "" {
			payload["reason"] = *reason
		}
		if err := t.recordByCaller("task.taken_back", taskID, payload); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, taskID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// DropTask ends a Task dropped: by its Feature's owner only, who may do it while another Member
// holds it (plan invariant 6's exception). Any Claim on it ends.
func (s *Service) DropTask(ctx context.Context, c *auth.Caller, ref string, reason *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		taskID, err := resolveTask(ctx, t, c.OrgID, ref)
		if err != nil {
			return nil, err
		}
		task, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		f, err := getFeature(ctx, t, c.OrgID, task.FeatureID, t.now)
		if err != nil {
			return nil, err
		}
		if f.OwnerID != c.MemberID {
			return nil, refuse(CodeForbidden, "only the owner of Feature %s may drop its Tasks", f.Key)
		}
		if task.State != "open" {
			return nil, refuse(CodeEnded, "Task %s is %s", task.Key, task.State)
		}
		payload := map[string]any{}
		if reason != nil && *reason != "" {
			payload["reason"] = *reason
		}
		if err := dropTask(t, taskID, payload); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, taskID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// dropTask ends an open Task dropped inside a write: it ends the Task's Claim, supersedes a
// proposal left pending on it and records task.dropped with payload.
func dropTask(t *tx, taskID string, payload map[string]any) error {
	claim, holder, live, err := endClaimOf(t, taskID, "dropped")
	if err != nil {
		return err
	}
	if live {
		payload["claim_id"], payload["holder_id"] = claim, holder
	}
	if _, err := t.Exec(t.ctx, `UPDATE tasks SET state = 'dropped', ended_at = $1 WHERE org_id = $2 AND id = $3`,
		ms(t.now), t.caller.OrgID, taskID); err != nil {
		return err
	}
	if _, err := t.Exec(t.ctx, `UPDATE skill_proposals SET state = 'superseded', decided_at = $1
WHERE org_id = $2 AND task_id = $3 AND state = 'pending'`, ms(t.now), t.caller.OrgID, taskID); err != nil {
		return err
	}
	return t.recordByCaller("task.dropped", taskID, payload)
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
