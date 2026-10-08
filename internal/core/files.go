package core

import (
	"context"
	"database/sql"
	"errors"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

// Files: bytes an Organisation keeps, referenced by id, such as a Member's avatar. The bytes go
// to the file store before the write that records them, so no upload holds the Organisation's
// counter (ADR 0011); only what describes them is written here. Any Member of the Organisation
// reads any of its files; another Organisation's are not found.

// What a file was uploaded as. An avatar has passed the avatar checks (a PNG, JPEG, WebP or GIF
// of at most AvatarMaxBytes) and been made a square PNG, so it can be set as a Member's avatar.
const (
	FileGeneral = "general"
	FileAvatar  = "avatar"
)

// AvatarMaxBytes bounds an image uploaded as an avatar, before it is made a square.
const AvatarMaxBytes = 2 << 20

// avatarTypes are the types an avatar is kept as; the server writes PNG, the rest are accepted
// on upload.
var avatarTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true}

// NewFile is a file already in the file store, under BlobKey, to record.
type NewFile struct {
	ID          string
	BlobKey     string
	Name        string
	ContentType string
	Size        int64
	SHA256      string
	Purpose     string
}

// RecordFile records a file whose bytes are already in the file store, and records file.uploaded.
// When it fails, the caller deletes the bytes.
func (s *Service) RecordFile(ctx context.Context, c *auth.Caller, nf NewFile, idem Idem) (File, error) {
	if nf.Purpose != FileGeneral && nf.Purpose != FileAvatar {
		return File{}, refuse(CodeInvalid, "purpose is general or avatar")
	}
	if nf.Purpose == FileAvatar && (!avatarTypes[nf.ContentType] || nf.Size > AvatarMaxBytes) {
		return File{}, refuse(CodeInvalid, "an avatar is a PNG, JPEG, WebP or GIF image of at most 2 MiB")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		if _, err := t.Exec(ctx, `INSERT INTO files (id, org_id, name, content_type, size, sha256, purpose, blob_key, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, nf.ID, c.OrgID, nf.Name, nf.ContentType, nf.Size, nf.SHA256, nf.Purpose,
			nf.BlobKey, c.MemberID, ms(t.now)); err != nil {
			return nil, err
		}
		payload := map[string]any{"name": nf.Name, "content_type": nf.ContentType, "size": nf.Size, "purpose": nf.Purpose}
		if err := t.recordByCaller("file.uploaded", nf.ID, payload); err != nil {
			return nil, err
		}
		return getFile(ctx, t, c.OrgID, nf.ID)
	})
	if err != nil {
		return File{}, err
	}
	return res.(File), nil
}

// GetFile returns a file of the caller's Organisation, with the key its bytes are stored under.
// A deleted file is not found.
func (s *Service) GetFile(ctx context.Context, c *auth.Caller, id string) (File, error) {
	return getFile(ctx, s.store, c.OrgID, id)
}

// DeleteFile deletes a file: by the Member who uploaded it, or an admin. A file that is a
// Member's avatar is refused until the avatar is changed or removed, so no Member's mark breaks
// behind them. It returns the deleted file, whose bytes the caller then removes from the store.
func (s *Service) DeleteFile(ctx context.Context, c *auth.Caller, id string, idem Idem) (File, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		f, err := getFile(ctx, t, c.OrgID, id)
		if err != nil {
			return nil, err
		}
		if f.CreatedBy != c.MemberID && !c.Admin {
			return nil, refuse(CodeForbidden, "only the Member who uploaded file %s, or an admin, may delete it", id)
		}
		var name string
		err = t.QueryRow(ctx, `SELECT name FROM members WHERE org_id = $1 AND avatar_file_id = $2 ORDER BY name LIMIT 1`, c.OrgID, id).Scan(&name)
		if err == nil {
			return nil, refuse(CodeConflict, "file %s is %s's avatar: change or remove the avatar first", id, name)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if _, err := t.Exec(ctx, `UPDATE files SET deleted_at = $1, deleted_by = $2 WHERE org_id = $3 AND id = $4`,
			ms(t.now), c.MemberID, c.OrgID, id); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("file.deleted", id, map[string]any{"name": f.Name}); err != nil {
			return nil, err
		}
		return f, nil
	})
	if err != nil {
		return File{}, err
	}
	return res.(File), nil
}

const fileCols = `id, name, content_type, size, sha256, purpose, created_by, created_at, deleted_at, blob_key`

func scanFile(row interface{ Scan(...any) error }) (File, error) {
	var f File
	var created int64
	var deleted sql.NullInt64
	if err := row.Scan(&f.ID, &f.Name, &f.ContentType, &f.Size, &f.SHA256, &f.Purpose, &f.CreatedBy, &created, &deleted, &f.BlobKey); err != nil {
		return f, err
	}
	f.CreatedAt, f.DeletedAt = fromMS(created), nullTime(deleted)
	return f, nil
}

// getFile returns a file of orgID that is not deleted.
func getFile(ctx context.Context, r store.Reader, orgID, id string) (File, error) {
	f, err := scanFile(r.QueryRow(ctx, `SELECT `+fileCols+` FROM files WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return f, refuse(CodeNotFound, "no file %s", id)
	}
	return f, err
}

// Unpurged lists up to limit deleted files of orgID whose bytes are still in the file store:
// deleted by DeleteFile, or released when a Member's avatar was changed or removed.
func (s *Service) Unpurged(ctx context.Context, orgID string, limit int) ([]File, error) {
	return collect(ctx, s.store, scanFile, `SELECT `+fileCols+` FROM files
WHERE org_id = $1 AND deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY deleted_at LIMIT $2`, orgID, limit)
}

// MarkPurged records that a deleted file's bytes are gone from the file store. It is not the
// record, so it takes no sequence number and records no Activity.
func (s *Service) MarkPurged(ctx context.Context, orgID, id string) error {
	return s.store.WriteNoSeq(ctx, func(tx store.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE files SET purged_at = $1 WHERE org_id = $2 AND id = $3 AND deleted_at IS NOT NULL`,
			ms(s.clock.Now()), orgID, id)
		return err
	})
}

// releaseAvatar deletes the avatar file a Member no longer shows, inside the write that changed
// it, when it was uploaded as an avatar and no other Member shows it; its bytes are purged after.
func releaseAvatar(t *tx, fileID string) error {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM members WHERE org_id = $1 AND avatar_file_id = $2`, t.caller.OrgID, fileID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	f, err := scanFile(t.QueryRow(t.ctx, `SELECT `+fileCols+` FROM files WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
		t.caller.OrgID, fileID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if f.Purpose != FileAvatar {
		return nil
	}
	if _, err := t.Exec(t.ctx, `UPDATE files SET deleted_at = $1, deleted_by = $2 WHERE org_id = $3 AND id = $4`,
		ms(t.now), t.caller.MemberID, t.caller.OrgID, fileID); err != nil {
		return err
	}
	return t.recordByCaller("file.deleted", fileID, map[string]any{"name": f.Name, "released": true})
}

// avatarFile checks that id names a file of the caller's Organisation uploaded as an avatar.
func avatarFile(ctx context.Context, r store.Reader, orgID, id string) error {
	f, err := getFile(ctx, r, orgID, id)
	if err != nil {
		return err
	}
	if f.Purpose != FileAvatar || !avatarTypes[f.ContentType] || f.Size > AvatarMaxBytes {
		return refuse(CodeInvalid, "file %s was not uploaded as an avatar: upload the image with purpose avatar", id)
	}
	return nil
}
