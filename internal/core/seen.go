package core

import (
	"context"
	"database/sql"
	"errors"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// A Member's mark of how far they have seen a Project's Activity, so the Project's page can show
// what happened since they looked. Like a View it is the Member's preference, not the record:
// setting it takes no sequence number and records no Activity, and only the Member reads it. It
// only moves forward, so two of the Member's tabs never pull it back (decisions.md).

// GetProjectSeen returns the caller's mark on a Project they are in.
func (s *Service) GetProjectSeen(ctx context.Context, c *auth.Caller, projectRef string) (ProjectSeen, error) {
	id, err := seenProject(ctx, s.store, c, projectRef)
	if err != nil {
		return ProjectSeen{}, err
	}
	return getProjectSeen(ctx, s.store, c, id)
}

// SetProjectSeen moves the caller's mark on a Project they are in forward to seq, the seq of the
// newest Activity entry they have seen there; a seq at or below the mark changes nothing. It
// returns the mark as kept.
func (s *Service) SetProjectSeen(ctx context.Context, c *auth.Caller, projectRef string, seq int64, idem Idem) (ProjectSeen, error) {
	if seq < 0 {
		return ProjectSeen{}, refuse(CodeInvalid, "seq is 0 or more, not %d", seq)
	}
	res, err := s.writeOwn(ctx, c, idem, func(t *tx) (any, error) {
		id, err := seenProject(ctx, t, c, projectRef)
		if err != nil {
			return nil, err
		}
		var newest int64
		if err := t.QueryRow(ctx, `SELECT seq FROM organisations WHERE id = $1`, c.OrgID).Scan(&newest); err != nil {
			return nil, err
		}
		if seq > newest {
			return nil, refuse(CodeInvalid, "there is no Activity entry %d yet; the newest is %d", seq, newest)
		}
		if _, err := t.Exec(ctx, `INSERT INTO project_seen (org_id, project_id, member_id, seq, updated_at) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (project_id, member_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
WHERE excluded.seq > project_seen.seq`, c.OrgID, id, c.MemberID, seq, ms(t.now)); err != nil {
			return nil, err
		}
		return getProjectSeen(ctx, t, c, id)
	})
	if err != nil {
		return ProjectSeen{}, err
	}
	return res.(ProjectSeen), nil
}

// seenProject resolves a Project the caller is in.
func seenProject(ctx context.Context, r store.Reader, c *auth.Caller, ref string) (string, error) {
	id, err := resolveProject(ctx, r, c.OrgID, ref)
	if err != nil {
		return "", err
	}
	in, err := inProject(ctx, r, c.OrgID, id, c.MemberID)
	if err != nil {
		return "", err
	}
	if !in {
		return "", refuse(CodeForbidden, "only a Member of Project %s has a mark of what they have seen in it", ref)
	}
	return id, nil
}

func getProjectSeen(ctx context.Context, r store.Reader, c *auth.Caller, projectID string) (ProjectSeen, error) {
	var seq, at int64
	err := r.QueryRow(ctx, `SELECT seq, updated_at FROM project_seen WHERE org_id = $1 AND project_id = $2 AND member_id = $3`,
		c.OrgID, projectID, c.MemberID).Scan(&seq, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return ProjectSeen{}, nil
	}
	if err != nil {
		return ProjectSeen{}, err
	}
	return ProjectSeen{Seq: &seq, At: ptr(fromMS(at))}, nil
}
