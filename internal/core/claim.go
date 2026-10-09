package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// The claim path: claim, next, heartbeat, release and complete. Each write is one batch, sent in
// one round trip on Postgres (plan invariant 4). Because nothing is read back before the batch
// commits, each operation reads the Task first and sends, with the write, the response the write
// will make true; a guard in the batch checks the write happened as read, so the response stored
// under an Idempotency-Key is the one the caller gets. When a guard refuses, the reason is read
// after the rollback, and a refusal of a rule's is then kept under the key (keepRefusal).

// ClaimOptions are what claim and next accept besides the Task.
type ClaimOptions struct {
	// Timeout is the heartbeat timeout: nil takes the token's default, zero asks for none.
	Timeout *time.Duration
	// ModelLabel is the AI model the holder says it uses.
	ModelLabel *string
}

func (o ClaimOptions) timeout(c *auth.Caller) time.Duration {
	if o.Timeout != nil {
		return *o.Timeout
	}
	return c.DefaultTimeout
}

// claimStmts claims taskID for c when the Task is takeable, as one conditional UPDATE carrying the
// whole Takeable rule (ADR 0004). The UPDATE copies the Claim it replaces into the outgoing
// columns, so the lapse of an expired Claim nobody has recorded yet is recorded here, numbered
// before the new Claim's own Activity. The Claim records the Skill of the Task's Step as it stands
// (ADR 0016); a claim moves nothing. The guard after it checks the Task is at the Step the
// response names, whose Skill is the one read, at the version read, and has the Claims read.
func claimStmts(c *auth.Caller, taskID, claimID string, pre TaskDetail, version *int64, o ClaimOptions, now time.Time) []store.Stmt {
	args := takeableArgs(c, now)
	timeout := o.timeout(c)
	var timeoutMS, expires *int64
	if timeout > 0 {
		timeoutMS, expires = ptr(timeout.Milliseconds()), ptr(ms(now.Add(timeout)))
	}
	// The Claims read that had not ended in the record: claimsOf gives the current one its expiry,
	// and shows it lapsed at that expiry once passed, before the lapse is recorded.
	var open int64
	for _, old := range pre.Claims {
		if old.EndedAt == nil || old.ExpiresAt != nil {
			open++
		}
	}
	for k, v := range map[string]any{
		"task": taskID, "claim": claimID, "session": c.SessionID, "timeout": timeoutMS, "expires": expires,
		"label": o.ModelLabel, "step": pre.Task.StepID, "skill": pre.Task.SkillID,
		"workflow": pre.Task.StepWorkflowID, "version": version,
		"claims": int64(len(pre.Claims)), "open": open,
	} {
		args[k] = v
	}
	payload := map[string]any{"claim_id": claimID, "session_id": c.ChosenID}
	if pre.Task.StepID != nil {
		payload["step_id"] = *pre.Task.StepID
	}
	if pre.Task.SkillID != nil {
		payload["skill_id"] = *pre.Task.SkillID
	}
	if timeoutMS != nil {
		payload["heartbeat_timeout_seconds"] = int64(timeout / time.Second)
	}
	if o.ModelLabel != nil {
		payload["model_label"] = *o.ModelLabel
	}
	outgoingOpen := `FROM tasks ot JOIN claims oc ON oc.id = ot.outgoing_claim_id
WHERE ot.org_id = @org AND ot.id = @task AND oc.org_id = @org AND oc.ended_at IS NULL`
	return []store.Stmt{
		// The Session claiming is still open: a claim cannot outlive a revocation or close it races.
		withGuard(store.S(sessionOpenGuard, args)),
		// No earlier Claim on the Task ended after @now. A claim read before another write ended
		// the Task's Claim, and run after it, would otherwise start before that Claim ended; it is
		// refused, and tried again at a fresh time.
		withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task
AND NOT EXISTS (SELECT 1 FROM claims pc WHERE pc.org_id = @org AND pc.task_id = @task AND pc.ended_at > @now)`, args)),
		store.S(`UPDATE tasks AS t SET outgoing_claim_id = claim_id, outgoing_holder_id = claim_holder_id,
outgoing_expires_at = claim_expires_at, claim_id = @claim, claim_holder_id = @member, claim_session_id = @session,
claim_skill_id = (SELECT cst.skill_id FROM steps cst WHERE cst.org_id = @org AND cst.id = t.step_id),
claim_timeout_ms = @timeout, claim_expires_at = @expires
WHERE t.id = @task AND `+takeableSQL, args),
		claimGuard(args),
		store.S(`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at)
SELECT @org, o.seq, NULL, 'task.lapsed', ot.id, '{"claim_id":"' || oc.id || '","holder_id":"' || oc.holder_id || '","how_ended":"lapsed"}', CAST(@now AS BIGINT)
FROM tasks ot JOIN claims oc ON oc.id = ot.outgoing_claim_id JOIN organisations o ON o.id = @org
WHERE ot.org_id = @org AND ot.id = @task AND oc.org_id = @org AND oc.ended_at IS NULL`, args),
		store.S(`UPDATE organisations SET seq = seq + 1 WHERE id = @org AND EXISTS (SELECT 1 `+outgoingOpen+`)`, args),
		store.S(`UPDATE claims SET ended_at = (SELECT outgoing_expires_at FROM tasks WHERE org_id = @org AND id = @task), how_ended = 'lapsed'
WHERE org_id = @org AND id = (SELECT outgoing_claim_id FROM tasks WHERE org_id = @org AND id = @task) AND ended_at IS NULL`, args),
		store.S(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at)
SELECT @claim, @org, t.id, @member, @session, t.claim_skill_id, s.current_version, CAST(@label AS TEXT), CAST(@timeout AS BIGINT), CAST(@now AS BIGINT)
FROM tasks t LEFT JOIN skills s ON s.org_id = @org AND s.id = t.claim_skill_id WHERE t.org_id = @org AND t.id = @task`, args),
		activityStmt(c.OrgID, &c.MemberID, "task.claimed", taskID, payload, now),
	}
}

// claimGuard holds when the claim happened, on the Task as it was read: at the same Step @step,
// whose Skill @skill is the one read, at the same version @version, in the Workflow @workflow of
// that Step (nil at no Step), and with the Claims it lists, @claims — none made since the read,
// and @open of them open — none open then ended since (the response would show a Claim released
// meanwhile as lapsed). Claims are never removed, and this runs before the new Claim is added.
func claimGuard(args map[string]any) store.Stmt {
	return withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t LEFT JOIN steps gs ON gs.org_id = @org AND gs.id = t.step_id
WHERE t.org_id = @org AND t.id = @task AND t.claim_id = @claim
AND t.step_id IS NOT DISTINCT FROM @step AND gs.skill_id IS NOT DISTINCT FROM @skill
AND gs.workflow_id IS NOT DISTINCT FROM @workflow
AND (gs.skill_id IS NULL OR EXISTS (SELECT 1 FROM skills s WHERE s.org_id = @org AND s.id = gs.skill_id AND s.current_version = @version))
AND (SELECT COUNT(*) FROM claims c WHERE c.org_id = @org AND c.task_id = @task) = @claims
AND (SELECT COUNT(*) FROM claims c WHERE c.org_id = @org AND c.task_id = @task AND c.ended_at IS NULL) = @open`, args))
}

// sessionOpenGuard holds while the Session @session is open and its token, if any, unrevoked.
const sessionOpenGuard = `SELECT 1 / COUNT(*) FROM sessions s LEFT JOIN tokens tk ON tk.id = s.token_id
WHERE s.org_id = @org AND s.id = @session AND s.closed_at IS NULL AND (s.token_id IS NULL OR tk.revoked_at IS NULL)`

func withGuard(st store.Stmt) store.Stmt {
	st.Guard = true
	return st
}

// tryClaim reads the Task, then claims it in one batch if it is still takeable. It returns
// store.ErrConditionFailed when the batch was refused.
func (s *Service) tryClaim(ctx context.Context, c *auth.Caller, taskID string, o ClaimOptions, idem Idem) (TaskDetail, error) {
	now := s.clock.Now()
	pre, err := getTaskDetail(ctx, s.store, c.OrgID, taskID, now)
	if err != nil {
		return TaskDetail{}, err
	}
	var version *int64
	if pre.Task.SkillID != nil {
		sk, err := getSkill(ctx, s.store, c.OrgID, *pre.Task.SkillID)
		if err != nil {
			return TaskDetail{}, err
		}
		version = &sk.CurrentVersion
	}
	claimID := newID()
	timeout := o.timeout(c)
	claim := Claim{
		ID: claimID, TaskID: taskID, HolderID: c.MemberID, SessionID: c.ChosenID,
		SkillID: pre.Task.SkillID, SkillVersion: version, ModelLabel: o.ModelLabel,
		Timeout: timeout, StartedAt: now,
	}
	if timeout > 0 {
		claim.ExpiresAt = ptr(now.Add(timeout))
	}
	// If the claim succeeds, every Claim before it has ended and none is current. The guard holds
	// the Claims to those read, so none live when read can have ended since: one that had expired
	// is already shown lapsed at its expiry, which the claim records.
	out := pre
	out.Claims = make([]Claim, 0, len(pre.Claims)+1)
	for _, old := range pre.Claims {
		old.ExpiresAt = nil
		out.Claims = append(out.Claims, old)
	}
	out.Claims = append(out.Claims, claim)
	out.Task.Claim = &claim

	stmts, err := idemStmts(c, idem, out, now)
	if err != nil {
		return TaskDetail{}, err
	}
	stmts = append(stmts, claimStmts(c, taskID, claimID, pre, version, o, now)...)
	if err := s.writeBatch(ctx, c.OrgID, stmts); err != nil {
		return TaskDetail{}, err
	}
	return out, nil
}

func refused(err error) bool {
	return errors.Is(err, store.ErrConditionFailed) || store.IsUniqueViolation(err)
}

// Claim claims a Task for the caller when it is takeable. The loser of a race gets
// already_claimed and should stop rather than retry; a Task the caller could never take gets
// not_takeable. Either refusal is kept under the Idempotency-Key.
func (s *Service) Claim(ctx context.Context, c *auth.Caller, ref string, o ClaimOptions, idem Idem) (TaskDetail, error) {
	out, err := s.runClaim(ctx, c, ref, o, idem)
	return out, s.keepRefusal(ctx, c, idem, err)
}

func (s *Service) runClaim(ctx context.Context, c *auth.Caller, ref string, o ClaimOptions, idem Idem) (TaskDetail, error) {
	taskID, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return TaskDetail{}, err
	}
	for range 3 {
		out, err := s.tryClaim(ctx, c, taskID, o, idem)
		if !refused(err) {
			return out, err
		}
		if err := s.afterRefusal(ctx, c, idem, nil); err != nil {
			return TaskDetail{}, err
		}
		retry, err := s.whyNotClaimed(ctx, c, taskID)
		if !retry {
			return TaskDetail{}, err
		}
	}
	return TaskDetail{}, refuse(CodeNotTakeable, "the Task kept changing while it was being claimed; read it and try again")
}

// whyNotClaimed reads, after a refused claim, why it was refused. It asks for a retry when the
// Task is still takeable: the Task changed between the read and the write.
func (s *Service) whyNotClaimed(ctx context.Context, c *auth.Caller, taskID string) (bool, error) {
	if err := s.mustBeValid(ctx, c); err != nil {
		return false, err
	}
	now := s.clock.Now()
	t, err := getTask(ctx, s.store, c.OrgID, taskID, now)
	if err != nil {
		return false, err
	}
	switch {
	case t.State != "open":
		return false, refuse(CodeNotTakeable, "Task %s is %s", t.Key, t.State)
	case t.Claim != nil && t.Claim.HolderID == c.MemberID:
		return false, refuse(CodeAlreadyClaimed, "you already hold Task %s", t.Key)
	case t.Claim != nil:
		return false, refuse(CodeAlreadyClaimed, "Task %s is held by another Member", t.Key)
	}
	ok, err := s.isTakeable(ctx, c, taskID, now)
	if err != nil {
		return false, err
	}
	if ok {
		return true, nil
	}
	switch {
	case t.SubtaskCounts != nil:
		return false, refuse(CodeNotTakeable, "Task %s is a Parent: its Subtasks are taken, never it", t.Key)
	case t.Blocked:
		return false, refuse(CodeNotTakeable, "Task %s is blocked", t.Key)
	case t.StepID != nil && t.SkillID == nil:
		if st, err := getStep(ctx, s.store, c.OrgID, *t.StepID); err == nil {
			return false, refuse(CodeNotTakeable, "Task %s is at %s, a hold: no one is offered it there until it is moved on", t.Key, st.Name)
		}
	}
	return false, refuse(CodeNotTakeable, "Task %s is not takeable by you", t.Key)
}

// NextWait bounds how long `next` waits: 30 s unless asked, 60 s at most (decisions.md).
const (
	NextWaitDefault = 30 * time.Second
	NextWaitMax     = 60 * time.Second
	// nextRecheck re-reads while waiting, in case a Claim lapsed and nothing has recorded it.
	nextRecheck = 2 * time.Second
	// nextCandidates is how many takeable Tasks one read offers to claim in turn.
	nextCandidates = 10
)

// Next claims the first Task takeable by the caller, in `next`'s order, waiting up to wait for
// one to become takeable. It returns found false when the wait ends with nothing claimed. While
// waiting it reads before it writes (ADR 0011), and wakes when any write to the Organisation
// commits. On losing a race for a Task it tries the next one.
func (s *Service) Next(ctx context.Context, c *auth.Caller, wait time.Duration, o ClaimOptions, idem Idem) (TaskDetail, bool, error) {
	deadline := time.Now().Add(min(wait, NextWaitMax))
	for {
		woken := s.wake.Wait(c.OrgID)
		// Read again at once after losing every candidate, a few times, before waiting.
		for range 5 {
			// A token revoked or a Session closed while this call waited stops it before it claims.
			if err := s.mustBeValid(ctx, c); err != nil {
				return TaskDetail{}, false, err
			}
			ids, err := s.takeableIDs(ctx, c, s.clock.Now(), nextCandidates)
			if err != nil {
				return TaskDetail{}, false, err
			}
			if len(ids) == 0 {
				break
			}
			for _, id := range ids {
				out, err := s.tryClaim(ctx, c, id, o, idem)
				if err == nil {
					return out, true, nil
				}
				if !refused(err) {
					return TaskDetail{}, false, err
				}
				if err := s.afterRefusal(ctx, c, idem, nil); err != nil {
					return TaskDetail{}, false, err
				}
			}
		}
		left := time.Until(deadline)
		if left <= 0 {
			return TaskDetail{}, false, nil
		}
		timer := time.NewTimer(min(left, nextRecheck))
		select {
		case <-woken:
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return TaskDetail{}, false, ctx.Err()
		}
		timer.Stop()
	}
}

// Heartbeat extends the caller's Claim on a Task by its timeout. It is one conditional UPDATE
// that takes no sequence number and records no Activity (ADR 0011), allowed only for the holder,
// through the Session that made the Claim, before it expires. A late Heartbeat is refused: the
// reply says lapsed, and the lapse is recorded if nobody has yet (ADR 0003).
func (s *Service) Heartbeat(ctx context.Context, c *auth.Caller, ref string) (HeartbeatReply, error) {
	// An id is used as it is, without a read; a display key is resolved.
	taskID, isID := shortid.Parse(ref)
	if !isID {
		var err error
		if taskID, err = resolveTask(ctx, s.store, c.OrgID, ref); err != nil {
			return HeartbeatReply{}, err
		}
	}
	now := s.clock.Now()
	var expires int64
	found := false
	st := store.S(`UPDATE tasks SET claim_expires_at = @now + claim_timeout_ms
WHERE id = @task AND org_id = @org AND state = 'open' AND claim_holder_id = @member AND claim_session_id = @session
AND claim_timeout_ms IS NOT NULL AND claim_expires_at > @now
RETURNING claim_expires_at`, map[string]any{"now": ms(now), "task": taskID, "org": c.OrgID, "member": c.MemberID, "session": c.SessionID})
	st.Scan = func(r store.Row) error {
		found = true
		return r.Scan(&expires)
	}
	if err := s.store.WriteBatchNoSeq(ctx, st); err != nil {
		return HeartbeatReply{}, err
	}
	if found {
		return HeartbeatReply{Status: "ok", ExpiresAt: ptr(fromMS(expires))}, nil
	}
	return s.whyNoHeartbeat(ctx, c, taskID, now)
}

func (s *Service) whyNoHeartbeat(ctx context.Context, c *auth.Caller, taskID string, now time.Time) (HeartbeatReply, error) {
	var currentClaim sql.NullString
	var expires sql.NullInt64
	err := s.store.QueryRow(ctx, `SELECT claim_id, claim_expires_at FROM tasks WHERE org_id = $1 AND id = $2`, c.OrgID, taskID).
		Scan(&currentClaim, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return HeartbeatReply{}, refuse(CodeNotFound, "no Task %s", taskID)
	}
	if err != nil {
		return HeartbeatReply{}, err
	}
	// The caller's latest Claim on the Task: through this Session when it was bound to one.
	var claimID string
	var how sql.NullString
	var ended, timeout sql.NullInt64
	err = s.store.QueryRow(ctx, `SELECT id, how_ended, ended_at, timeout_ms FROM claims
WHERE org_id = $1 AND task_id = $2 AND holder_id = $3 AND (timeout_ms IS NULL OR session_id = $4)
ORDER BY started_at DESC, id DESC LIMIT 1`, c.OrgID, taskID, c.MemberID, c.SessionID).Scan(&claimID, &how, &ended, &timeout)
	if errors.Is(err, sql.ErrNoRows) {
		return HeartbeatReply{}, refuse(CodeNotHolder, "you have never held a Claim on this Task through this Session")
	}
	if err != nil {
		return HeartbeatReply{}, err
	}
	if ended.Valid {
		switch how.String {
		case "lapsed", "taken_back":
			return HeartbeatReply{Status: how.String}, nil
		}
		return HeartbeatReply{Status: "ended"}, nil
	}
	if currentClaim.String == claimID {
		if !timeout.Valid {
			// Bound to the Member and never lapsing: nothing to extend.
			return HeartbeatReply{Status: "ok"}, nil
		}
		if expires.Valid && expires.Int64 <= ms(now) {
			if err := s.recordLapse(ctx, c.OrgID, taskID, claimID, now); err != nil {
				return HeartbeatReply{}, err
			}
			return HeartbeatReply{Status: "lapsed"}, nil
		}
	}
	return HeartbeatReply{Status: "ended"}, nil
}

// recordLapse writes the lapse of an expired Claim nobody has recorded yet: it ends the Claim at
// its expiry, frees the Task and appends Activity. Whoever meets the expired Claim first writes
// it — a refused Heartbeat, the next claimer, or the sweeper — and the others find it written.
func (s *Service) recordLapse(ctx context.Context, orgID, taskID, claimID string, now time.Time) error {
	args := map[string]any{"org": orgID, "task": taskID, "claim": claimID, "now": ms(now)}
	var holder string
	if err := s.store.QueryRow(ctx, `SELECT holder_id FROM claims WHERE org_id = $1 AND id = $2`, orgID, claimID).Scan(&holder); err != nil {
		return err
	}
	err := s.writeBatch(ctx, orgID, []store.Stmt{
		withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t JOIN claims c ON c.id = t.claim_id
WHERE t.org_id = @org AND t.id = @task AND t.claim_id = @claim AND c.ended_at IS NULL AND t.claim_expires_at <= @now`, args)),
		activityStmt(orgID, nil, "task.lapsed", taskID, map[string]any{"claim_id": claimID, "holder_id": holder, "how_ended": "lapsed"}, now),
		store.S(`UPDATE claims SET ended_at = (SELECT claim_expires_at FROM tasks WHERE org_id = @org AND id = @task), how_ended = 'lapsed'
WHERE org_id = @org AND id = @claim`, args),
		store.S(clearClaimSQL+` WHERE org_id = @org AND id = @task AND claim_id = @claim`, args),
	})
	if errors.Is(err, store.ErrConditionFailed) {
		return nil // someone else recorded it first
	}
	return err
}

// Sweep records the lapse of every expired Claim nobody has recorded yet, so the Task's Owner
// sees it without waiting for someone to meet it. It is for visibility only: a lapsed Claim is
// already takeable whether or not it has run (ADR 0004).
func (s *Service) Sweep(ctx context.Context) (int, error) {
	orgs, err := s.organisations(ctx)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, org := range orgs {
		now := s.clock.Now()
		type expired struct{ task, claim string }
		rows, err := collect(ctx, s.store, func(row interface{ Scan(...any) error }) (expired, error) {
			var e expired
			return e, row.Scan(&e.task, &e.claim)
		}, `SELECT t.id, t.claim_id FROM tasks t JOIN claims c ON c.id = t.claim_id
WHERE t.org_id = $1 AND t.claim_expires_at IS NOT NULL AND t.claim_expires_at <= $2 AND c.ended_at IS NULL
ORDER BY t.claim_expires_at LIMIT 100`, org, ms(now))
		if err != nil {
			return n, err
		}
		for _, e := range rows {
			if err := s.recordLapse(ctx, org, e.task, e.claim, now); err != nil {
				return n, fmt.Errorf("core: sweep %s: %w", e.task, err)
			}
			n++
		}
	}
	return n, nil
}

// holderGuard is the Claim guard (plan invariant 6) of a batch write on a held Task: it holds
// while the caller holds the Task's live Claim @claim, through its Session when the Claim has a
// timeout. The counter is held, so the Task cannot change after this check except by a
// Heartbeat, which only moves the expiry later.
const holderGuard = `SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task AND t.state = 'open'
AND t.claim_id = @claim AND t.claim_holder_id = @member AND (t.claim_timeout_ms IS NULL OR t.claim_session_id = @session)
AND (t.claim_expires_at IS NULL OR t.claim_expires_at > @now)`

// heldOp is a hot-path write on a Task the caller holds.
type heldOp struct {
	// build gets the Task as read, with the batch's arguments (org, task, claim, member, session,
	// now), and returns the result the write will make true and the statements to run after the
	// Claim guard. A result that is an *Error is a refusal the write answers with once it has
	// committed, kept under the Idempotency-Key in the same batch.
	build func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error)
	// explain, when set, says why a refused batch was refused when the caller still holds the
	// Task afterwards: a guard of build's own failed.
	explain func(ctx context.Context, t Task) error
}

// answered is a refusal a held write answered with after committing: it is already kept under
// the Idempotency-Key.
type answered struct{ refusal *Error }

func (a *answered) Error() string { return a.refusal.Error() }

// heldWrite runs op as one batch (one round trip on Postgres): the Idempotency-Key's response,
// the Claim guard, then op's statements. A refused batch is explained after the rollback. One
// refused while the caller still holds the same Claim met a Task that changed between the read
// and the write, such as its Workflow edited; it is tried again, at most three times in all, as a
// claim is. A refusal of a rule's is kept under the Idempotency-Key.
func (s *Service) heldWrite(ctx context.Context, c *auth.Caller, ref string, idem Idem, op heldOp) (any, error) {
	res, err := s.runHeldWrite(ctx, c, ref, idem, op)
	var a *answered
	if errors.As(err, &a) {
		return nil, a.refusal
	}
	return res, s.keepRefusal(ctx, c, idem, err)
}

func (s *Service) runHeldWrite(ctx context.Context, c *auth.Caller, ref string, idem Idem, op heldOp) (any, error) {
	taskID, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return nil, err
	}
	for attempt := 1; ; attempt++ {
		now := s.clock.Now()
		pre, err := getTask(ctx, s.store, c.OrgID, taskID, now)
		if err != nil {
			return nil, err
		}
		// A retry under the key of a write that has just ended the Claim reads the Task after that
		// write committed: it answers with the stored response, not the refusal.
		if err := holds(c, pre); err != nil {
			return nil, s.afterRefusal(ctx, c, idem, err)
		}
		args := map[string]any{"org": c.OrgID, "task": taskID, "claim": pre.Claim.ID, "member": c.MemberID,
			"session": c.SessionID, "now": ms(now)}
		result, body, err := op.build(pre, args, now)
		if err != nil {
			return nil, s.afterRefusal(ctx, c, idem, err)
		}
		var stmts []store.Stmt
		refusal, refusing := result.(*Error)
		if refusing && idem.Key != "" {
			status, b, err := idem.RenderRefusal(refusal)
			if err != nil {
				return nil, err
			}
			stmts = keyStmts(c, idem, status, b, now)
		} else if !refusing {
			if stmts, err = idemStmts(c, idem, result, now); err != nil {
				return nil, err
			}
		}
		stmts = append(stmts, withGuard(store.S(holderGuard, args)))
		stmts = append(stmts, body...)
		err = s.writeBatch(ctx, c.OrgID, stmts)
		if refused(err) {
			if err := s.afterRefusal(ctx, c, idem, nil); err != nil {
				return nil, err
			}
			t, rerr := getTask(ctx, s.store, c.OrgID, taskID, s.clock.Now())
			if rerr != nil {
				return nil, rerr
			}
			if herr := holds(c, t); herr != nil {
				return nil, herr
			}
			if op.explain != nil {
				if eerr := op.explain(ctx, t); eerr != nil {
					return nil, eerr
				}
			}
			if t.Claim.ID == pre.Claim.ID && attempt < 3 {
				continue
			}
			return nil, refuse(CodeNotHolder, "your Claim on %s changed while this request ran; read the Task and try again", t.Key)
		}
		if err != nil {
			return nil, err
		}
		if refusing {
			return nil, &answered{refusal}
		}
		return result, nil
	}
}

// stepGuard is the guard a held write that answers with its Task ends with: the Task is at the
// Step the response names (none for nil), carrying the Skill and in the Workflow it names, either
// of which `SetWorkflow` may have changed. workflow is that Step's own Workflow, never the Task's
// WorkflowID, which also reads its last Step.
func stepGuard(args map[string]any, step, skill, workflow *string) store.Stmt {
	return withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t LEFT JOIN steps gs ON gs.org_id = t.org_id AND gs.id = t.step_id
WHERE t.org_id = @org AND t.id = @task AND t.step_id IS NOT DISTINCT FROM @step AND gs.skill_id IS NOT DISTINCT FROM @skill
AND gs.workflow_id IS NOT DISTINCT FROM @workflow`,
		with(args, map[string]any{"step": step, "skill": skill, "workflow": workflow})))
}

// with copies args and adds kv, so one op's statements can bind more than the guard.
func with(args map[string]any, kv map[string]any) map[string]any {
	out := make(map[string]any, len(args)+len(kv))
	for k, v := range args {
		out[k] = v
	}
	for k, v := range kv {
		out[k] = v
	}
	return out
}

// noteStmt adds a Note written by the holder under the Skill of their Claim.
func noteStmt(pre Task, args map[string]any, id, body string) store.Stmt {
	return store.S(`INSERT INTO notes (id, org_id, task_id, author_id, skill_id, body, created_at)
VALUES (@id, @org, @task, @member, CAST(@skill AS TEXT), @body, @now)`, with(args, map[string]any{"id": id, "skill": pre.Claim.SkillID, "body": body}))
}

// holds refuses a caller who does not hold the Task's live Claim: through the Session that made
// it when it has a heartbeat timeout, through any Session of the Member when it has none.
func holds(c *auth.Caller, t Task) error {
	switch {
	case t.Claim == nil && t.State != "open":
		return refuse(CodeNotHolder, "Task %s is %s", t.Key, t.State)
	case t.Claim == nil:
		return refuse(CodeNotHolder, "nobody holds Task %s", t.Key)
	case t.Claim.HolderID != c.MemberID:
		return refuse(CodeNotHolder, "Task %s is held by another Member", t.Key)
	case t.Claim.Timeout > 0 && t.Claim.SessionID != c.ChosenID:
		return refuse(CodeNotHolder, "Task %s is held by another of your Sessions (%s)", t.Key, t.Claim.SessionID)
	}
	return nil
}

// Release gives up the caller's Claim. The Task stays at its Step, for whoever has its Skill.
func (s *Service) Release(ctx context.Context, c *auth.Caller, ref string, note *string, idem Idem) (Task, error) {
	res, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		out := pre
		out.Claim = nil
		stmts := []store.Stmt{
			store.S(`UPDATE claims SET ended_at = @now, how_ended = 'released', ended_by = @member WHERE org_id = @org AND id = @claim`, args),
			store.S(clearClaimSQL+` WHERE org_id = @org AND id = @task`, args),
		}
		if note != nil && *note != "" {
			stmts = append(stmts, noteStmt(pre, args, newID(), *note))
		}
		stmts = append(stmts, activityStmt(c.OrgID, &c.MemberID, "task.released", pre.ID, map[string]any{"claim_id": pre.Claim.ID}, now),
			stepGuard(args, pre.StepID, pre.SkillID, pre.StepWorkflowID))
		return out, stmts, nil
	}})
	if err != nil {
		return Task{}, err
	}
	return res.(Task), nil
}

// RecordNudge records that the Runner nudged the agent holding a Task, nudge 1 or 2 of the two it
// sends before releasing the Task. The caller is that agent's Session holding the Claim, through
// which the Runner acts; the entry has no actor, since Darkory acted, as with a lapse.
func (s *Service) RecordNudge(ctx context.Context, c *auth.Caller, ref string, nudge int, idem Idem) error {
	if nudge != 1 && nudge != 2 {
		return refuse(CodeInvalid, "nudge is 1 or 2, not %d", nudge)
	}
	_, err := s.heldWrite(ctx, c, ref, idem, heldOp{build: func(pre Task, args map[string]any, now time.Time) (any, []store.Stmt, error) {
		return nil, []store.Stmt{activityStmt(c.OrgID, nil, "task.nudged", pre.ID,
			map[string]any{"claim_id": pre.Claim.ID, "holder_id": c.MemberID, "nudge": nudge}, now)}, nil
	}})
	return err
}

// nextSeqStmt takes the next number from the counter inside a batch, for a further Activity
// entry (decisions.md).
func nextSeqStmt(orgID string) store.Stmt {
	return store.Stmt{SQL: `UPDATE organisations SET seq = seq + 1 WHERE id = $1`, Args: []any{orgID}}
}
