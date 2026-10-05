package core

import (
	"context"
	"slices"

	"github.com/tuongaz/darkory/internal/auth"
)

// ActivityKinds lists every kind of Activity entry Darkory writes; the API's ActivityKind enum
// lists the same. The part before the dot names the subject's type (SubjectTypes).
var ActivityKinds = []string{
	"feature.filed", "feature.ranked", "feature.shipped", "feature.dropped", "feature.owner_passed", "feature.evidence_attached",
	"task.filed", "task.claimed", "task.lapsed", "task.released", "task.handed_over", "task.completed", "task.dropped",
	"task.taken_back", "task.claim_ended", "task.note_added", "task.observed", "task.blocker_added", "task.blocker_removed",
	"task.evidence_attached", "task.skill_proposed",
	"skill.created", "skill.version_published",
	"member.created", "member.updated", "member.manager_set", "member.manager_cleared", "member.skill_granted", "member.skill_revoked",
	"member.deactivated", "member.reactivated",
	"team.created", "team.member_added", "team.member_removed",
	"token.issued", "token.revoked",
	"session.closed",
	"login_link.issued", "login_link.redeemed",
}

// SubjectTypes lists the kinds of record an Activity entry can be about.
var SubjectTypes = []string{"feature", "task", "skill", "member", "team", "token", "session", "login_link"}

// ActivityQuery picks a page of Activity: the entries numbered above After and below Before
// (zero for no bound), at most Limit of them. With Before the page is the entries closest below
// it, still in sequence order.
type ActivityQuery struct {
	After, Before int64
	Limit         int
}

// ListActivity returns a page of Activity entries in sequence order. Numbers are allocated in
// commit order (ADR 0011), so a reader that passes the last number it saw as After never misses
// an entry, and one that passes the first as Before reads back through the history.
func (s *Service) ListActivity(ctx context.Context, c *auth.Caller, q ActivityQuery) (ActivityPage, error) {
	const cols = `SELECT seq, at, actor_id, kind, subject_id, payload FROM activity WHERE org_id = $1 AND seq > $2`
	var items []Activity
	var err error
	if q.Before > 0 {
		items, err = collect(ctx, s.store, scanActivity, cols+` AND seq < $3 ORDER BY seq DESC LIMIT $4`, c.OrgID, q.After, q.Before, limitOf(q.Limit))
		slices.Reverse(items)
	} else {
		items, err = collect(ctx, s.store, scanActivity, cols+` ORDER BY seq LIMIT $3`, c.OrgID, q.After, limitOf(q.Limit))
	}
	if err != nil {
		return ActivityPage{}, err
	}
	p := ActivityPage{Items: items, LastSeq: q.After}
	if len(items) > 0 {
		p.FirstSeq, p.LastSeq = items[0].Seq, items[len(items)-1].Seq
	}
	return p, nil
}

// LatestSeq is the number of the Organisation's newest Activity entry, 0 when it has none: where
// a stream that starts from now begins.
func (s *Service) LatestSeq(ctx context.Context, c *auth.Caller) (int64, error) {
	var seq int64
	err := s.store.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM activity WHERE org_id = $1`, c.OrgID).Scan(&seq)
	return seq, err
}
