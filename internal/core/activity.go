package core

import (
	"context"
	"slices"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
)

// ActivityKinds lists every kind of Activity entry Darkory writes; the API's ActivityKind enum
// lists the same. The part before the dot names the subject's type (SubjectTypes).
var ActivityKinds = []string{
	"feature.filed", "feature.ranked", "feature.shipped", "feature.dropped", "feature.owner_passed", "feature.evidence_attached",
	"task.filed", "task.claimed", "task.lapsed", "task.released", "task.handed_over", "task.completed", "task.dropped",
	"task.taken_back", "task.claim_ended", "task.note_added", "task.observed", "task.blocker_added", "task.blocker_removed",
	"task.evidence_attached", "task.skill_proposed", "task.status_set",
	"statuses.changed",
	"skill.created", "skill.version_published",
	"member.created", "member.updated", "member.manager_set", "member.manager_cleared", "member.skill_granted", "member.skill_revoked",
	"member.deactivated", "member.reactivated", "member.agent_changed",
	"team.created", "team.changed", "team.member_added", "team.member_removed",
	"workspace.added", "workspace.changed", "workspace.removed",
	"token.issued", "token.revoked",
	"session.closed",
	"login_link.issued", "login_link.redeemed",
}

// SubjectTypes lists the kinds of record an Activity entry can be about.
var SubjectTypes = []string{"feature", "task", "skill", "member", "team", "token", "session", "login_link", "statuses", "workspace"}

// ActivityQuery picks a page of Activity: the entries numbered above After and below Before
// (zero for no bound), at most Limit of them. With Before the page is the entries closest below
// it, still in sequence order. Member, Kinds and Team, when set, keep only the entries that match
// them all, and the page is then that many matching entries.
type ActivityQuery struct {
	After, Before int64
	Limit         int
	// Member keeps the entries a Member (id or name) acted in, or that ended a Claim they held.
	Member string
	// Kinds keeps the entries of these kinds.
	Kinds []string
	// Team keeps the entries about a Feature of a Team (id or key), or about a Task of one.
	Team string
}

// ListActivity returns a page of Activity entries in sequence order. Numbers are allocated in
// commit order (ADR 0011), so a reader that passes the last number it saw as After never misses
// an entry, and one that passes the first as Before reads back through the history.
func (s *Service) ListActivity(ctx context.Context, c *auth.Caller, q ActivityQuery) (ActivityPage, error) {
	where := []string{"a.org_id = $1", "a.seq > $2"}
	args := []any{c.OrgID, q.After}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+itoa(len(args))))
	}
	if q.Member != "" {
		id, err := resolveMember(ctx, s.store, c.OrgID, q.Member)
		if err != nil {
			return ActivityPage{}, err
		}
		// The entries that end a Claim name its holder in the payload (task.lapsed, taken_back,
		// claim_ended, dropped). Payloads are written compact, by json.Marshal or the claim batch's
		// own text in the same form, so a LIKE on the exact pair finds them on both engines.
		args = append(args, id, `%"holder_id":"`+id+`"%`)
		where = append(where, `(a.actor_id = $`+itoa(len(args)-1)+` OR a.payload LIKE $`+itoa(len(args))+`)`)
	}
	if len(q.Kinds) > 0 {
		marks := make([]string, len(q.Kinds))
		for i, k := range q.Kinds {
			if !slices.Contains(ActivityKinds, k) {
				return ActivityPage{}, refuse(CodeInvalid, "no Activity kind %q", k)
			}
			args = append(args, k)
			marks[i] = "$" + itoa(len(args))
		}
		where = append(where, "a.kind IN ("+strings.Join(marks, ", ")+")")
	}
	if q.Team != "" {
		id, err := resolveTeam(ctx, s.store, c.OrgID, q.Team)
		if err != nil {
			return ActivityPage{}, err
		}
		add(`(EXISTS (SELECT 1 FROM tasks ft JOIN features ff ON ff.id = ft.feature_id
	WHERE ft.org_id = a.org_id AND ft.id = a.subject_id AND ff.team_id = ?)
OR EXISTS (SELECT 1 FROM features ff WHERE ff.org_id = a.org_id AND ff.id = a.subject_id AND ff.team_id = ?))`, id)
	}
	query := `SELECT a.seq, a.at, a.actor_id, a.kind, a.subject_id, a.payload FROM activity a WHERE ` + strings.Join(where, " AND ")
	var items []Activity
	var err error
	if q.Before > 0 {
		args = append(args, q.Before, limitOf(q.Limit))
		items, err = collect(ctx, s.store, scanActivity, query+` AND a.seq < $`+itoa(len(args)-1)+` ORDER BY a.seq DESC LIMIT $`+itoa(len(args)), args...)
		slices.Reverse(items)
	} else {
		args = append(args, limitOf(q.Limit))
		items, err = collect(ctx, s.store, scanActivity, query+` ORDER BY a.seq LIMIT $`+itoa(len(args)), args...)
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
