package core

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// How a worked Task moves on (ADR 0016): its holder advances it along a Connector out of its
// Step, to the next Step or into Done, which completes it. Each is one batch, sent in one round
// trip on Postgres (plan invariant 4), whatever a Subtask's ending sets off in its Parent.

// Advance ends the caller's work on a Task they hold along a Connector out of its Step: the one
// named outcome, ignoring case, or the only one when outcome is empty; refused no_connector
// otherwise, naming the Step's outcomes. Along a Connector to a Step the Claim ends advanced and
// the Task waits there for whoever has that Step's Skill; into Done the Task completes, as
// Complete says. A Task aimed at a Member is at no Step and has no outcomes: advancing it, with or
// without one, completes it. A Note, when given, is written with it under the Skill of the Claim.
func (s *Service) Advance(ctx context.Context, c *auth.Caller, ref, outcome string, note *string, idem Idem) (Task, error) {
	return s.endWork(ctx, c, ref, &outcome, note, idem)
}

// Complete ends a Task done. A Task the caller holds completes along the one Connector out of its
// Step into Done — refused use_advance when the Step has none or several, naming its outcomes —
// and one aimed at a Member, at no Step, completes as it is. A Parent is completed by its Owner
// once every Subtask has ended (tasks_open otherwise), and files its Retrospective.
func (s *Service) Complete(ctx context.Context, c *auth.Caller, ref string, note *string, idem Idem) (Task, error) {
	taskID, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return Task{}, err
	}
	t, err := getTask(ctx, s.store, c.OrgID, taskID, s.clock.Now())
	if err != nil {
		return Task{}, err
	}
	if t.SubtaskCounts != nil {
		return s.completeParent(ctx, c, taskID, note, idem)
	}
	return s.endWork(ctx, c, taskID, nil, note, idem)
}

// endWork ends the caller's Claim on a Task along a Connector: the one outcome names (Advance),
// or the one into Done (Complete, outcome nil).
func (s *Service) endWork(ctx context.Context, c *auth.Caller, ref string, outcome *string, note *string, idem Idem) (Task, error) {
	var review []SkillProposal
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{
		build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
			review = nil
			k, err := s.connectorFor(ctx, c, pre, outcome)
			if err != nil {
				return nil, nil, err
			}
			if k != nil && k.ToStepID != nil {
				to, err := getStep(ctx, s.store, c.OrgID, *k.ToStepID)
				if err != nil {
					return nil, nil, err
				}
				out, stmts := advanceStmts(c, pre, *k, to, note, nil, args, now)
				return out, stmts, nil
			}
			ps, err := s.pendingReview(ctx, c, pre)
			if codeOf(err) == CodeProposalStale {
				return s.sendBack(ctx, c, pre, err.(*Error), args, now)
			}
			if err != nil {
				return nil, nil, err
			}
			review = ps
			return s.doneStmts(ctx, c, pre, k, ps, note, args, now)
		},
		explain: func(ctx context.Context, t Task) error {
			for _, p := range review {
				err := s.whyNotPublished(ctx, c, p)
				if codeOf(err) == CodeProposalStale {
					// Another review published on the same base after the read: read again, and the
					// next attempt sends the Task back as a stale one is.
					return nil
				}
				if err != nil {
					return err
				}
			}
			return nil
		},
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// connectorFor is the Connector a holder ends their work on pre along: the one named outcome, the
// only one when outcome is empty, or for Complete (outcome nil) the one into Done. It is nil for a
// Task at no Step — one aimed at a Member — which completes as it is.
func (s *Service) connectorFor(ctx context.Context, c *auth.Caller, pre Task, outcome *string) (*Connector, error) {
	if pre.StepID == nil {
		// Aimed at a Member, at no Step: no outcomes to choose between, so advancing it, with or
		// without one, completes it.
		return nil, nil
	}
	st, err := getStep(ctx, s.store, c.OrgID, *pre.StepID)
	if err != nil {
		return nil, err
	}
	ks, err := connectorsFrom(ctx, s.store, c.OrgID, st.ID)
	if err != nil {
		return nil, err
	}
	if outcome == nil {
		var done []Connector
		for _, k := range ks {
			if k.ToStepID == nil {
				done = append(done, k)
			}
		}
		if len(done) != 1 {
			return nil, refuse(CodeUseAdvance, "Task %s is at %s, where %d ways lead into Done: advance it along one; %s",
				pre.Key, st.Name, len(done), outcomes(ks)).with("outcomes", outcomeNames(ks))
		}
		return &done[0], nil
	}
	name := strings.TrimSpace(*outcome)
	if name == "" {
		if len(ks) != 1 {
			return nil, refuse(CodeNoConnector, "Task %s is at %s, which has %d ways out: name the outcome; %s", pre.Key, st.Name, len(ks), outcomes(ks)).
				with("outcomes", outcomeNames(ks))
		}
		return &ks[0], nil
	}
	for _, k := range ks {
		if strings.EqualFold(k.Name, name) {
			return &k, nil
		}
	}
	return nil, refuse(CodeNoConnector, "%s has no outcome %q; %s", st.Name, name, outcomes(ks)).with("outcomes", outcomeNames(ks))
}

// fromGuard holds while the Task is at the Step @from it was read at and the Connector @connector
// still leads from there to @to: a Task moved, or a Workflow edited, since the read is refused
// and read again. A Task at no Step has no Connector.
func fromGuard(args map[string]any, pre Task, k *Connector) store.Stmt {
	if k == nil {
		return withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task AND t.step_id IS NULL`, args))
	}
	return withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t JOIN connectors k ON k.org_id = t.org_id AND k.from_step_id = t.step_id
WHERE t.org_id = @org AND t.id = @task AND t.step_id = @from AND k.id = @connector AND k.to_step_id IS NOT DISTINCT FROM @to`,
		with(args, map[string]any{"from": pre.StepID, "connector": k.ID, "to": k.ToStepID})))
}

// advanceStmts move pre along k to its Step to: the Claim ends advanced, and the Task waits at
// the Step from now. extra is added to task.advanced's payload.
func advanceStmts(c *auth.Caller, pre Task, k Connector, to Step, note *string, extra map[string]any, args map[string]any, now time.Time) (Task, []store.Stmt) {
	out := pre
	out.Claim, out.StepID, out.StepSince, out.WaitingSince, out.SkillID = nil, k.ToStepID, &now, now, to.SkillID
	out.WorkflowID = &to.WorkflowID
	a := with(args, map[string]any{"to": k.ToStepID})
	stmts := []store.Stmt{fromGuard(args, pre, &k)}
	if note != nil && *note != "" {
		stmts = append(stmts, noteStmt(pre, args, newID(), *note))
	}
	payload := map[string]any{"claim_id": pre.Claim.ID, "from": *pre.StepID, "to": *k.ToStepID, "outcome": k.Name}
	if pre.StepSince != nil {
		payload["since"] = ms(*pre.StepSince)
	}
	for key, v := range extra {
		payload[key] = v
	}
	stmts = append(stmts,
		store.S(`UPDATE claims SET ended_at = @now, how_ended = 'advanced', ended_by = @member WHERE org_id = @org AND id = @claim`, a),
		store.S(clearClaimSQL+`, step_id = @to, step_since = @now, waiting_since = @now WHERE org_id = @org AND id = @task`, a),
		activityStmt(c.OrgID, &c.MemberID, "task.advanced", pre.ID, payload, now),
		stepGuard(args, k.ToStepID, to.SkillID),
	)
	return out, stmts
}

// sendBack answers an advance into Done that would publish a proposal whose base is no longer
// current (ADR 0010): the Task goes back along the Step's "needs changes" Connector, or else its
// first Connector to a Step, with the refusal as its Note, and the caller is refused
// proposal_stale. Nothing is published; the proposals still current stay pending for the next
// review. With no way back, the advance is only refused.
func (s *Service) sendBack(ctx context.Context, c *auth.Caller, pre Task, stale *Error, args map[string]any, now time.Time) (any, []store.Stmt, error) {
	ks, err := connectorsFrom(ctx, s.store, c.OrgID, *pre.StepID)
	if err != nil {
		return nil, nil, err
	}
	var back *Connector
	for _, k := range ks {
		if k.ToStepID != nil && strings.EqualFold(k.Name, "needs changes") {
			back = &k
			break
		}
	}
	for _, k := range ks {
		if back == nil && k.ToStepID != nil {
			back = &k
		}
	}
	if back == nil {
		return nil, nil, stale
	}
	to, err := getStep(ctx, s.store, c.OrgID, *back.ToStepID)
	if err != nil {
		return nil, nil, err
	}
	_, stmts := advanceStmts(c, pre, *back, to, &stale.Message, map[string]any{"refused": string(stale.Code)}, args, now)
	return stale, stmts, nil
}

// doneStmts complete pre along k into Done (k nil: a Task at no Step). Completing a Task at a
// skill-review Step publishes each pending proposal it carries, ps, as its Skill's next version,
// only while the version each was written against is still current and never by its author;
// completing a Retrospective marks its Parent's unreviewed Observations reviewed by it (ADR 0010).
// A proposal left pending on the Task is superseded. Then, for a Subtask, its Parent may take an
// Acceptance or complete itself (parentStmts).
func (s *Service) doneStmts(ctx context.Context, c *auth.Caller, pre Task, k *Connector, ps []SkillProposal, note *string, args map[string]any, now time.Time) (any, []store.Stmt, error) {
	out := pre
	out.Claim, out.State, out.EndedAt, out.StepID, out.StepSince, out.SkillID = nil, "done", &now, nil, nil, nil
	out.LastStepID = pre.StepID // its WorkflowID stays that Step's
	stmts := []store.Stmt{fromGuard(args, pre, k)}
	for _, p := range ps {
		stmts = append(stmts, publishStmts(p, args)...)
	}
	if note != nil && *note != "" {
		stmts = append(stmts, noteStmt(pre, args, newID(), *note))
	}
	stmts = append(stmts,
		store.S(`UPDATE claims SET ended_at = @now, how_ended = 'completed', ended_by = @member WHERE org_id = @org AND id = @claim`, args),
		store.S(clearClaimSQL+`, state = 'done', ended_at = @now, last_step_id = step_id, step_id = NULL, step_since = NULL
WHERE org_id = @org AND id = @task`, args),
		store.S(supersedeSQL+` WHERE org_id = @org AND task_id = @task AND state = 'pending'`, args),
	)
	if pre.Kind == "retrospective" && pre.ParentID != nil {
		stmts = append(stmts, store.S(`UPDATE observations SET reviewed_by_task_id = @task, reviewed_at = @now
WHERE org_id = @org AND reviewed_by_task_id IS NULL
AND task_id IN (SELECT ot.id FROM tasks ot WHERE ot.org_id = @org AND (ot.parent_id = @parent OR ot.id = @parent))`,
			with(args, map[string]any{"parent": *pre.ParentID})))
	}
	payload := map[string]any{"claim_id": pre.Claim.ID}
	if k != nil {
		payload["from"], payload["outcome"] = *pre.StepID, k.Name
		if pre.StepSince != nil {
			payload["since"] = ms(*pre.StepSince)
		}
	}
	stmts = append(stmts, activityStmt(c.OrgID, &c.MemberID, "task.completed", pre.ID, payload, now))
	for _, p := range ps {
		stmts = append(stmts, nextSeqStmt(c.OrgID), activityStmt(c.OrgID, &c.MemberID, "skill.version_published", p.SkillID,
			map[string]any{"version": p.BasedOnVersion + 1, "proposal_id": p.ID, "task_id": pre.ID}, now))
	}
	if pre.ParentID != nil {
		more, err := s.parentStmts(ctx, c, pre, args)
		if err != nil {
			return nil, nil, err
		}
		stmts = append(stmts, more...)
	}
	stmts = append(stmts, withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task AND t.state = 'done'`, args)))
	return out, stmts, nil
}

// parentStmts are what a Subtask ending done sets off in its Parent, decided inside the batch,
// which holds the counter, so no other write can file or end one of its Subtasks in between:
//
//   - Acceptance: when the Parent is still open with acceptance on, every other Subtask has ended,
//     and the Workflow has a Step carrying the acceptance Skill, Darkory files "Acceptance:
//     <Parent>" there — unless the Subtask that ended is itself an Acceptance.
//   - Auto-complete: otherwise, when the Parent is still open with auto_complete on and no Subtask
//     of it is open, it completes, recording task.completed with auto_complete in its payload,
//     and files its Retrospective at the Workflow's retro Step, if it has one.
//
// An Acceptance filed leaves a Subtask open, so the Parent does not also complete. A Subtask
// ending on an ended Parent — a Retrospective, a question — sets off neither. Statements after an
// effect cannot test its condition again, so they find it in what it wrote: the Subtask filed, or
// the newest Activity being the Parent's completion.
func (s *Service) parentStmts(ctx context.Context, c *auth.Caller, pre Task, args map[string]any) ([]store.Stmt, error) {
	// A Subtask's Parent, Project and kind never change, nor a Parent's title.
	var title string
	if err := s.store.QueryRow(ctx, `SELECT title FROM tasks WHERE org_id = $1 AND id = $2`, c.OrgID, *pre.ParentID).Scan(&title); err != nil {
		return nil, err
	}
	a := with(args, map[string]any{"parent": *pre.ParentID, "project": pre.ProjectID})
	open := `EXISTS (SELECT 1 FROM tasks pp WHERE pp.org_id = @org AND pp.id = @parent AND pp.state = 'open' AND pp.%s = TRUE)
AND NOT EXISTS (SELECT 1 FROM tasks ps WHERE ps.org_id = @org AND ps.parent_id = @parent AND ps.state = 'open')`
	var stmts []store.Stmt
	if pre.Kind != "acceptance" {
		acc, err := skillByName(ctx, s.store, c.OrgID, SkillAcceptance)
		if err != nil {
			return nil, err
		}
		filed, err := ownSubtaskStmts(with(a, map[string]any{"skill": acc}), "acceptance", "Acceptance: "+title,
			strings.Replace(open, "%s", "acceptance", 1)+` AND EXISTS (SELECT 1 FROM steps ast WHERE ast.org_id = @org AND ast.project_id = @project AND ast.skill_id = @skill)`)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, filed...)
	}
	auto := strings.Replace(open, "%s", "auto_complete", 1)
	stmts = append(stmts,
		store.S(`UPDATE organisations SET seq = seq + 1 WHERE id = @org AND `+auto, a),
		store.S(`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at)
SELECT @org, o.seq, CAST(@member AS TEXT), 'task.completed', CAST(@parent AS TEXT), '{"auto_complete":true}', CAST(@now AS BIGINT)
FROM organisations o WHERE o.id = @org AND `+auto, a),
		store.S(`UPDATE tasks SET state = 'done', ended_at = @now WHERE org_id = @org AND id = @parent AND `+auto, a),
	)
	retro, err := skillByName(ctx, s.store, c.OrgID, SkillRetro)
	if err != nil {
		return nil, err
	}
	completed := `EXISTS (SELECT 1 FROM activity sa JOIN organisations so ON so.id = sa.org_id AND so.seq = sa.seq
WHERE sa.org_id = @org AND sa.kind = 'task.completed' AND sa.subject_id = @parent)`
	filed, err := ownSubtaskStmts(with(a, map[string]any{"skill": retro}), "retrospective", "Retrospective: "+title,
		completed+` AND EXISTS (SELECT 1 FROM steps rst WHERE rst.org_id = @org AND rst.project_id = @project AND rst.skill_id = @skill)`)
	if err != nil {
		return nil, err
	}
	return append(stmts, filed...), nil
}

// ownSubtaskStmts file, inside a batch and when cond holds, a Subtask Darkory owns under @parent
// at the first Step of @project carrying the Skill @skill: filed by nobody, its Owner the Parent's,
// naming the Parent's Workspaces, and recorded with no actor. cond is tested once, before the
// Subtask exists; the statements after it find the Subtask instead.
func ownSubtaskStmts(args map[string]any, kind, title, cond string) ([]store.Stmt, error) {
	titleJSON, err := json.Marshal(title)
	if err != nil {
		return nil, err
	}
	a := with(args, map[string]any{"sub": newID(), "kind": kind, "title": title, "title_json": string(titleJSON)})
	filed := `EXISTS (SELECT 1 FROM tasks fs WHERE fs.org_id = @org AND fs.id = @sub)`
	return []store.Stmt{
		store.S(`UPDATE projects SET last_number = last_number + 1 WHERE org_id = @org AND id = @project AND `+cond, a),
		store.S(`INSERT INTO tasks (id, org_id, project_id, parent_id, display_key, kind, title, description, state, step_id, step_since,
owner_id, filed_by, waiting_since, created_at)
SELECT CAST(@sub AS TEXT), @org, pr.id, pp.id, pr.key_prefix || '-' || CAST(pr.last_number AS TEXT), CAST(@kind AS TEXT),
CAST(@title AS TEXT), '', 'open', `+builtinStepSQL("@skill")+`, CAST(@now AS BIGINT), pp.owner_id, NULL, CAST(@now AS BIGINT), CAST(@now AS BIGINT)
FROM projects pr JOIN tasks pp ON pp.org_id = pr.org_id AND pp.id = @parent WHERE pr.org_id = @org AND pr.id = @project AND `+cond, a),
		store.S(`INSERT INTO task_workspaces (org_id, task_id, workspace_id, position)
SELECT @org, CAST(@sub AS TEXT), tw.workspace_id, tw.position FROM task_workspaces tw
WHERE tw.org_id = @org AND tw.task_id = @parent AND `+filed, a),
		store.S(`UPDATE organisations SET seq = seq + 1 WHERE id = @org AND `+filed, a),
		store.S(`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at)
SELECT @org, o.seq, NULL, 'task.filed', fs.id,
'{"key":"' || fs.display_key || '","kind":"' || fs.kind || '","owner_id":"' || fs.owner_id || '","parent_id":"' || fs.parent_id ||
'","step_id":"' || fs.step_id || '","title":' || CAST(@title_json AS TEXT) || '}', CAST(@now AS BIGINT)
FROM organisations o JOIN tasks fs ON fs.org_id = o.id AND fs.id = @sub WHERE o.id = @org`, a),
	}, nil
}

// completeParent completes a Parent, by its Owner, once every Subtask has ended, and files its
// Retrospective in the same write.
func (s *Service) completeParent(ctx context.Context, c *auth.Caller, taskID string, note *string, idem Idem) (Task, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		p, err := getTask(ctx, t, c.OrgID, taskID, t.now)
		if err != nil {
			return nil, err
		}
		if p.OwnerID != c.MemberID {
			return nil, refuse(CodeForbidden, "only the Owner of %s may complete it: it is a Parent, and its Subtasks are worked instead", p.Key)
		}
		if p.State != "open" {
			return nil, refuse(CodeEnded, "Task %s is %s", p.Key, p.State)
		}
		if p.SubtaskCounts.Open > 0 {
			return nil, refuse(CodeTasksOpen, "%s has %d open Subtasks; each must end, done or dropped, before it completes", p.Key, p.SubtaskCounts.Open)
		}
		if _, err := t.Exec(ctx, `UPDATE tasks SET state = 'done', ended_at = $1 WHERE org_id = $2 AND id = $3`, ms(t.now), c.OrgID, taskID); err != nil {
			return nil, err
		}
		if note != nil && *note != "" {
			if err := addNote(t, taskID, nil, *note); err != nil {
				return nil, err
			}
		}
		if err := t.recordByCaller("task.completed", taskID, map[string]any{}); err != nil {
			return nil, err
		}
		if err := fileRetrospective(t, p); err != nil {
			return nil, err
		}
		return getTask(ctx, t, c.OrgID, taskID, t.now)
	})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}
