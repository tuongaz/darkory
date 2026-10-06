package core

import (
	"context"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// takeableSQL is the one Takeable rule (CONTEXT.md, ADR 0004), written once and used by the claim
// UPDATE, by `next` and by the takeable list, over a Task aliased t. It binds @org, @member (the
// caller) and @now. A Task is takeable by the caller when it is open; is in a todo or in_progress
// Status, not a backlog one (ADR 0012; in_progress, so that a lapsed Claim's Task can be taken
// again before anyone records the lapse); has no live Claim (none, or one whose expiry has
// passed); has no open blocker; and is aimed at the caller, or needs a Skill
// the caller has and belongs to a Feature in one of the caller's Teams, or needs skill-review,
// which the caller has, from any Team, or belongs to a Feature the caller owns and no active
// Member could take it by its Skill: none in the Feature's Team has the Skill, or, for
// skill-review, which any Team may take, none in the Organisation has it. Whoever has held it under one Skill
// may take it again only under that Skill: no one judges their own work.
const takeableSQL = `t.org_id = @org
AND t.state = 'open'
AND EXISTS (SELECT 1 FROM statuses ts WHERE ts.org_id = @org AND ts.id = t.status_id AND ts.kind IN ('todo', 'in_progress'))
AND (t.claim_holder_id IS NULL OR (t.claim_expires_at IS NOT NULL AND t.claim_expires_at <= @now))
AND NOT EXISTS (SELECT 1 FROM blocks b JOIN tasks bt ON bt.id = b.blocker_task_id
	WHERE b.org_id = @org AND b.task_id = t.id AND bt.state = 'open')
AND (
	t.aimed_at_id = @member
	OR (t.aimed_at_id IS NULL
		AND EXISTS (SELECT 1 FROM member_skills ms WHERE ms.org_id = @org AND ms.member_id = @member AND ms.skill_id = t.skill_id)
		AND (EXISTS (SELECT 1 FROM features f JOIN team_members tm ON tm.team_id = f.team_id
				WHERE f.org_id = @org AND f.id = t.feature_id AND tm.member_id = @member)
			OR EXISTS (SELECT 1 FROM skills sr WHERE sr.org_id = @org AND sr.id = t.skill_id AND sr.builtin = TRUE AND sr.name = 'skill-review')))
	OR (t.aimed_at_id IS NULL
		AND EXISTS (SELECT 1 FROM features f WHERE f.org_id = @org AND f.id = t.feature_id AND f.owner_id = @member
			AND NOT EXISTS (SELECT 1 FROM member_skills ms JOIN members pm ON pm.id = ms.member_id
				WHERE ms.org_id = @org AND ms.skill_id = t.skill_id AND pm.deactivated_at IS NULL
				AND (EXISTS (SELECT 1 FROM team_members tm WHERE tm.org_id = @org AND tm.team_id = f.team_id AND tm.member_id = ms.member_id)
					OR EXISTS (SELECT 1 FROM skills sr WHERE sr.org_id = @org AND sr.id = t.skill_id AND sr.builtin = TRUE AND sr.name = 'skill-review')))))
)
AND NOT EXISTS (SELECT 1 FROM claims pc WHERE pc.org_id = @org AND pc.task_id = t.id AND pc.holder_id = @member
	AND pc.skill_id IS DISTINCT FROM t.skill_id)`

// nextOrder is the order `next` offers takeable Tasks in, over t and its Feature f (ADR 0005):
// Rank position across the caller's Teams, then Tasks that block another open Task, then the
// Task that has waited longest since it was filed or last handed over.
const nextOrder = ` ORDER BY f.rank,
CASE WHEN EXISTS (SELECT 1 FROM blocks nb JOIN tasks nt ON nt.id = nb.task_id
	WHERE nb.org_id = t.org_id AND nb.blocker_task_id = t.id AND nt.state = 'open') THEN 0 ELSE 1 END,
t.waiting_since, t.id`

func takeableArgs(c *auth.Caller, now time.Time) map[string]any {
	return map[string]any{"org": c.OrgID, "member": c.MemberID, "now": ms(now)}
}

// ListTakeable lists the Tasks the caller can take now, in the order `next` would offer them.
func (s *Service) ListTakeable(ctx context.Context, c *auth.Caller, limit int) ([]Task, error) {
	now := s.clock.Now()
	args := takeableArgs(c, now)
	args["limit"] = limitOf(limit)
	q, a := store.Bind(takeableSQL+nextOrder+` LIMIT @limit`, args)
	return tasksWhere(ctx, s.store, c.OrgID, now, q, a...)
}

// takeableIDs lists the ids of up to limit Tasks takeable by the caller, in `next`'s order.
func (s *Service) takeableIDs(ctx context.Context, c *auth.Caller, now time.Time, limit int) ([]string, error) {
	args := takeableArgs(c, now)
	args["limit"] = limit
	q, a := store.Bind(`SELECT t.id FROM tasks t JOIN features f ON f.id = t.feature_id WHERE `+takeableSQL+nextOrder+` LIMIT @limit`, args)
	return collect(ctx, s.store, func(row interface{ Scan(...any) error }) (string, error) {
		var id string
		return id, row.Scan(&id)
	}, q, a...)
}

// isTakeable reports whether the caller could take the Task now.
func (s *Service) isTakeable(ctx context.Context, c *auth.Caller, taskID string, now time.Time) (bool, error) {
	args := takeableArgs(c, now)
	args["task"] = taskID
	q, a := store.Bind(`SELECT COUNT(*) FROM tasks t WHERE t.id = @task AND `+takeableSQL, args)
	var n int
	err := s.store.QueryRow(ctx, q, a...).Scan(&n)
	return n > 0, err
}
