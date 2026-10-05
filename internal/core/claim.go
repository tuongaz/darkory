package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// The claim path: claim, next, heartbeat, release and complete. Each write is one batch, sent in
// one round trip on Postgres (plan invariant 4). Because nothing is read back before the batch
// commits, each operation reads the Task first and sends, with the write, the response the write
// will make true; a guard in the batch checks the write happened as read, so the response stored
// under an Idempotency-Key is the one the caller gets. When a guard refuses, the reason is read
// after the rollback.

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
// before the new Claim's own Activity.
func claimStmts(c *auth.Caller, taskID, claimID string, pre Task, version *int64, o ClaimOptions, now time.Time) []store.Stmt {
	args := takeableArgs(c, now)
	timeout := o.timeout(c)
	var timeoutMS, expires *int64
	if timeout > 0 {
		timeoutMS, expires = ptr(timeout.Milliseconds()), ptr(ms(now.Add(timeout)))
	}
	for k, v := range map[string]any{
		"task": taskID, "claim": claimID, "session": c.SessionID, "timeout": timeoutMS, "expires": expires,
		"label": o.ModelLabel, "skill": pre.SkillID, "version": version,
	} {
		args[k] = v
	}
	payload := map[string]any{"claim_id": claimID, "session_id": c.ChosenID}
	if pre.SkillID != nil {
		payload["skill_id"] = *pre.SkillID
	}
	if timeoutMS != nil {
		payload["heartbeat_timeout_seconds"] = int64(timeout / time.Second)
	}
	if o.ModelLabel != nil {
		payload["model_label"] = *o.ModelLabel
	}
	outgoingOpen := `FROM tasks ot JOIN claims oc ON oc.id = ot.outgoing_claim_id WHERE ot.id = @task AND oc.ended_at IS NULL`
	return []store.Stmt{
		store.S(`UPDATE tasks AS t SET outgoing_claim_id = claim_id, outgoing_holder_id = claim_holder_id,
outgoing_expires_at = claim_expires_at, claim_id = @claim, claim_holder_id = @member, claim_session_id = @session,
claim_skill_id = skill_id, claim_timeout_ms = @timeout, claim_expires_at = @expires
WHERE t.id = @task AND `+takeableSQL, args),
		// The claim happened, on the Task as it was read: the same Skill, at the same version.
		withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t WHERE t.id = @task AND t.claim_id = @claim
AND t.skill_id IS NOT DISTINCT FROM @skill
AND (t.skill_id IS NULL OR EXISTS (SELECT 1 FROM skills s WHERE s.id = t.skill_id AND s.current_version = @version))`, args)),
		store.S(`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at)
SELECT @org, o.seq, NULL, 'task.lapsed', ot.id, '{"claim_id":"' || oc.id || '","holder_id":"' || oc.holder_id || '","how_ended":"lapsed"}', CAST(@now AS BIGINT)
FROM tasks ot JOIN claims oc ON oc.id = ot.outgoing_claim_id JOIN organisations o ON o.id = @org
WHERE ot.id = @task AND oc.ended_at IS NULL`, args),
		store.S(`UPDATE organisations SET seq = seq + 1 WHERE id = @org AND EXISTS (SELECT 1 `+outgoingOpen+`)`, args),
		store.S(`UPDATE claims SET ended_at = (SELECT outgoing_expires_at FROM tasks WHERE id = @task), how_ended = 'lapsed'
WHERE id = (SELECT outgoing_claim_id FROM tasks WHERE id = @task) AND ended_at IS NULL`, args),
		store.S(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, model_label, timeout_ms, started_at)
SELECT @claim, @org, t.id, @member, @session, t.skill_id, s.current_version, CAST(@label AS TEXT), CAST(@timeout AS BIGINT), CAST(@now AS BIGINT)
FROM tasks t LEFT JOIN skills s ON s.id = t.skill_id WHERE t.id = @task`, args),
		activityStmt(c.OrgID, &c.MemberID, "task.claimed", taskID, payload, now),
	}
}

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
	// If the claim succeeds, every Claim before it has ended and none is current; one still open
	// had lapsed at its expiry.
	out := pre
	out.Claims = make([]Claim, 0, len(pre.Claims)+1)
	for _, old := range pre.Claims {
		if old.EndedAt == nil {
			old.EndedAt, old.HowEnded = old.ExpiresAt, ptr("lapsed")
		}
		old.ExpiresAt = nil
		out.Claims = append(out.Claims, old)
	}
	out.Claims = append(out.Claims, claim)
	out.Task.Claim = &claim

	stmts, err := idemStmts(c, idem, out, now)
	if err != nil {
		return TaskDetail{}, err
	}
	stmts = append(stmts, claimStmts(c, taskID, claimID, pre.Task, version, o, now)...)
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
// not_takeable.
func (s *Service) Claim(ctx context.Context, c *auth.Caller, ref string, o ClaimOptions, idem Idem) (TaskDetail, error) {
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
	if t.Blocked {
		return false, refuse(CodeNotTakeable, "Task %s is blocked", t.Key)
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
	taskID := ref
	if _, err := uuid.Parse(ref); err != nil {
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
		store.S(`UPDATE claims SET ended_at = (SELECT claim_expires_at FROM tasks WHERE id = @task), how_ended = 'lapsed' WHERE id = @claim`, args),
		store.S(clearClaimSQL+` WHERE id = @task AND claim_id = @claim`, args),
	})
	if errors.Is(err, store.ErrConditionFailed) {
		return nil // someone else recorded it first
	}
	return err
}

// Sweep records the lapse of every expired Claim nobody has recorded yet, so the Feature owner
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

// endHeld ends the caller's Claim on a Task they hold, in one batch: release leaves the Task
// needing the same Skill; complete ends the Task done.
func (s *Service) endHeld(ctx context.Context, c *auth.Caller, ref, how string, note *string, idem Idem) (Task, error) {
	taskID, err := resolveTask(ctx, s.store, c.OrgID, ref)
	if err != nil {
		return Task{}, err
	}
	now := s.clock.Now()
	pre, err := getTask(ctx, s.store, c.OrgID, taskID, now)
	if err != nil {
		return Task{}, err
	}
	if err := holds(c, pre); err != nil {
		return Task{}, err
	}
	claim := pre.Claim
	out := pre
	out.Claim = nil
	setTask := clearClaimSQL
	kind := "task.released"
	if how == "completed" {
		out.State, out.EndedAt = "done", &now
		setTask = clearClaimSQL + `, state = 'done', ended_at = @now`
		kind = "task.completed"
	}
	args := map[string]any{"org": c.OrgID, "task": taskID, "claim": claim.ID, "member": c.MemberID,
		"session": c.SessionID, "now": ms(now), "how": how}
	stmts, err := idemStmts(c, idem, out, now)
	if err != nil {
		return Task{}, err
	}
	stmts = append(stmts,
		// The Claim guard (plan invariant 6): the caller holds the live Claim, through its Session
		// when it has a timeout. The counter is held, so the Task cannot change after this check
		// except by a Heartbeat, which only moves the expiry later.
		withGuard(store.S(`SELECT 1 / COUNT(*) FROM tasks t WHERE t.org_id = @org AND t.id = @task AND t.state = 'open'
AND t.claim_id = @claim AND t.claim_holder_id = @member AND (t.claim_timeout_ms IS NULL OR t.claim_session_id = @session)
AND (t.claim_expires_at IS NULL OR t.claim_expires_at > @now)`, args)),
		store.S(`UPDATE claims SET ended_at = @now, how_ended = @how, ended_by = @member WHERE id = @claim`, args),
		store.S(setTask+` WHERE id = @task`, args),
	)
	if note != nil && *note != "" {
		stmts = append(stmts, store.S(`INSERT INTO notes (id, org_id, task_id, author_id, skill_id, body, created_at)
VALUES (@id, @org, @task, @member, @skill, @body, @now)`,
			map[string]any{"id": newID(), "org": c.OrgID, "task": taskID, "member": c.MemberID, "skill": claim.SkillID, "body": *note, "now": ms(now)}))
	}
	stmts = append(stmts, activityStmt(c.OrgID, &c.MemberID, kind, taskID, map[string]any{"claim_id": claim.ID}, now))
	err = s.writeBatch(ctx, c.OrgID, stmts)
	if refused(err) {
		if err := s.afterRefusal(ctx, c, idem, nil); err != nil {
			return Task{}, err
		}
		t, rerr := getTask(ctx, s.store, c.OrgID, taskID, s.clock.Now())
		if rerr != nil {
			return Task{}, rerr
		}
		if herr := holds(c, t); herr != nil {
			return Task{}, herr
		}
		return Task{}, refuse(CodeNotHolder, "your Claim on %s changed while this request ran; read the Task and try again", t.Key)
	}
	if err != nil {
		return Task{}, err
	}
	return out, nil
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

// Release gives up the caller's Claim, leaving the Task needing the same Skill.
func (s *Service) Release(ctx context.Context, c *auth.Caller, ref string, note *string, idem Idem) (Task, error) {
	return s.endHeld(ctx, c, ref, "released", note, idem)
}

// Complete ends a Task the caller holds, done.
func (s *Service) Complete(ctx context.Context, c *auth.Caller, ref string, note *string, idem Idem) (Task, error) {
	return s.endHeld(ctx, c, ref, "completed", note, idem)
}
