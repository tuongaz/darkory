package core

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// Evidence: files attached to a Task or a Feature. The file goes to the Evidence store before the
// write that records it, so no upload holds the Organisation's counter (ADR 0011); only its
// metadata is written here.

// EvidenceTarget names what Evidence is attached to: a Task, or a Feature itself.
type EvidenceTarget struct {
	Task    *string
	Feature *string
}

// NewEvidence is a file already in the Evidence store, under BlobKey, to record.
type NewEvidence struct {
	ID          string
	BlobKey     string
	Filename    string
	ContentType string
	Size        int64
	SHA256      string
}

// MayAttachEvidence refuses a caller who may not attach Evidence to target, before the file is
// uploaded; AttachEvidence checks again under the counter.
func (s *Service) MayAttachEvidence(ctx context.Context, c *auth.Caller, target EvidenceTarget) error {
	_, _, err := evidenceTarget(ctx, s.store, c, target, s.clock.Now())
	return err
}

// evidenceTarget resolves target and checks the caller may attach to it: a held Task needs its
// Claim (plan invariant 6); a Task nobody holds, or a Feature, needs the Feature's owner or a
// Member of its Team.
func evidenceTarget(ctx context.Context, r store.Reader, c *auth.Caller, target EvidenceTarget, now time.Time) (Feature, *Task, error) {
	if (target.Task == nil) == (target.Feature == nil) {
		return Feature{}, nil, refuse(CodeInvalid, "Evidence is attached to a Task or to a Feature")
	}
	var task *Task
	var featureID string
	if target.Task != nil {
		id, err := resolveTask(ctx, r, c.OrgID, *target.Task)
		if err != nil {
			return Feature{}, nil, err
		}
		t, err := getTask(ctx, r, c.OrgID, id, now)
		if err != nil {
			return Feature{}, nil, err
		}
		task, featureID = &t, t.FeatureID
	} else {
		id, err := resolveFeature(ctx, r, c.OrgID, *target.Feature)
		if err != nil {
			return Feature{}, nil, err
		}
		featureID = id
	}
	f, err := getFeature(ctx, r, c.OrgID, featureID, now)
	if err != nil {
		return Feature{}, nil, err
	}
	if task != nil && task.Claim != nil {
		return f, task, holds(c, *task)
	}
	if f.OwnerID == c.MemberID {
		return f, task, nil
	}
	in, err := inTeam(ctx, r, c.OrgID, f.TeamID, c.MemberID)
	if err != nil {
		return Feature{}, nil, err
	}
	if !in {
		return Feature{}, nil, refuse(CodeForbidden, "only the owner of Feature %s or a Member of its Team may attach Evidence here", f.Key)
	}
	return f, task, nil
}

// AttachEvidence records Evidence whose file is already in the Evidence store. When it fails, the
// caller deletes the file.
func (s *Service) AttachEvidence(ctx context.Context, c *auth.Caller, target EvidenceTarget, ne NewEvidence, idem Idem) (Evidence, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		f, task, err := evidenceTarget(ctx, t, c, target, t.now)
		if err != nil {
			return nil, err
		}
		var taskID *string
		if task != nil {
			taskID = &task.ID
		}
		if _, err := t.Exec(ctx, `INSERT INTO evidence (id, org_id, feature_id, task_id, filename, content_type, size, sha256, blob_key, attached_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, ne.ID, c.OrgID, f.ID, taskID, ne.Filename, ne.ContentType, ne.Size, ne.SHA256,
			ne.BlobKey, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		payload := map[string]any{"evidence_id": ne.ID, "filename": ne.Filename, "size": ne.Size}
		if task != nil {
			err = t.recordByCaller("task.evidence_attached", task.ID, payload)
		} else {
			err = t.recordByCaller("feature.evidence_attached", f.ID, payload)
		}
		if err != nil {
			return nil, err
		}
		return getEvidence(ctx, t, c.OrgID, ne.ID)
	})
	if err != nil {
		return Evidence{}, err
	}
	return res.(Evidence), nil
}

// GetEvidence returns an Evidence record, with the key its file is stored under.
func (s *Service) GetEvidence(ctx context.Context, c *auth.Caller, id string) (Evidence, error) {
	return getEvidence(ctx, s.store, c.OrgID, id)
}

func getEvidence(ctx context.Context, r store.Reader, orgID, id string) (Evidence, error) {
	e, err := scanEvidence(r.QueryRow(ctx, `SELECT `+evidenceCols+` FROM evidence e WHERE e.org_id = $1 AND e.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, refuse(CodeNotFound, "no Evidence %s", id)
	}
	return e, err
}
