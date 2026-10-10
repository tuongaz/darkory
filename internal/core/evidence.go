package core

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
)

// Evidence: files attached to a Task — Evidence on a Parent is Evidence whose Task is the Parent.
// The file goes to the Evidence store before the write that records it, so no upload holds the
// Organisation's counter (ADR 0011); only its metadata is written here.

// EvidenceTarget names the Task Evidence is attached to.
type EvidenceTarget struct {
	Task string
}

// NewEvidence is a file already in the Evidence store, under BlobKey, to record. Kind is
// EvidenceKindEvidence when empty.
type NewEvidence struct {
	ID          string
	Kind        string
	BlobKey     string
	Filename    string
	ContentType string
	Size        int64
	SHA256      string
}

// MayAttachEvidence refuses a caller who may not attach Evidence to target, before the file is
// uploaded; AttachEvidence checks again under the counter.
func (s *Service) MayAttachEvidence(ctx context.Context, c *auth.Caller, target EvidenceTarget) error {
	_, err := evidenceTarget(ctx, s.store, c, target, s.clock.Now())
	return err
}

// evidenceTarget resolves target and checks the caller may attach to it: a held Task needs its
// Claim (plan invariant 6); a Task nobody holds, its Owner or a Member of its Project.
func evidenceTarget(ctx context.Context, r store.Reader, c *auth.Caller, target EvidenceTarget, now time.Time) (Task, error) {
	id, err := resolveTask(ctx, r, c.OrgID, target.Task)
	if err != nil {
		return Task{}, err
	}
	t, err := getTask(ctx, r, c.OrgID, id, now)
	if err != nil {
		return Task{}, err
	}
	if t.Claim != nil {
		return t, holds(c, t)
	}
	return t, inProjectOrOwner(ctx, r, c, t, "attach Evidence, while nobody holds it, to")
}

// AttachEvidence records Evidence whose file is already in the Evidence store. When it fails, the
// caller deletes the file.
func (s *Service) AttachEvidence(ctx context.Context, c *auth.Caller, target EvidenceTarget, ne NewEvidence, idem Idem) (Evidence, error) {
	switch ne.Kind {
	case "":
		ne.Kind = EvidenceKindEvidence
	case EvidenceKindEvidence, EvidenceKindLog:
	default:
		return Evidence{}, refuse(CodeInvalid, "Evidence is of kind evidence or log, not %q", ne.Kind)
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		task, err := evidenceTarget(ctx, t, c, target, t.now)
		if err != nil {
			return nil, err
		}
		if _, err := t.Exec(ctx, `INSERT INTO evidence (id, org_id, task_id, kind, filename, content_type, size, sha256, blob_key, attached_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, ne.ID, c.OrgID, task.ID, ne.Kind, ne.Filename, ne.ContentType, ne.Size, ne.SHA256,
			ne.BlobKey, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		payload := map[string]any{"evidence_id": ne.ID, "filename": ne.Filename, "size": ne.Size, "kind": ne.Kind}
		if err := t.recordByCaller("task.evidence_attached", task.ID, payload); err != nil {
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
	id = shortid.Canonical(id) // either form (ADR 0017)
	e, err := scanEvidence(r.QueryRow(ctx, `SELECT `+evidenceCols+` FROM evidence e WHERE e.org_id = $1 AND e.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return e, refuse(CodeNotFound, "no Evidence %s", id)
	}
	return e, err
}
