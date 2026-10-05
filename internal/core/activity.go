package core

import (
	"context"

	"github.com/tuongaz/darkory/internal/auth"
)

// ListActivity returns up to limit Activity entries numbered after after, in sequence order.
// Numbers are allocated in commit order (ADR 0011), so a reader that passes the last number it
// saw never misses an entry.
func (s *Service) ListActivity(ctx context.Context, c *auth.Caller, after int64, limit int) (ActivityPage, error) {
	items, err := collect(ctx, s.store, scanActivity, `SELECT seq, at, actor_id, kind, subject_id, payload FROM activity
WHERE org_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, c.OrgID, after, limitOf(limit))
	if err != nil {
		return ActivityPage{}, err
	}
	p := ActivityPage{Items: items, LastSeq: after}
	if len(items) > 0 {
		p.LastSeq = items[len(items)-1].Seq
	}
	return p, nil
}
