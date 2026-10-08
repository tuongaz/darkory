package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/avatar"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
)

// Files travel as the raw request body, as Evidence does (decisions.md). The server reads the
// type from the bytes and keeps that; the request's Content-Type is never trusted. The bytes go
// to the file store, hashed on the way, before the write that records them, so no upload holds
// the Organisation's counter (ADR 0011); a record that fails deletes them.

// DefaultMaxFileSize is the largest file an Install takes unless set otherwise.
const DefaultMaxFileSize = 10 << 20

// purgeBatch bounds how many deleted files' bytes one request removes.
const purgeBatch = 50

func (s *Server) UploadFile(w http.ResponseWriter, r *http.Request, params gen.UploadFileParams) {
	ctx, c := r.Context(), caller(r)
	if s.files == nil {
		writeError(w, http.StatusNotImplemented, gen.ErrorCodeNotImplemented, "this Install has no file store")
		return
	}
	if msg := checkFilename(params.Name); msg != "" {
		invalid(w, strings.Replace(msg, "filename", "name", 1))
		return
	}
	purpose := core.FileGeneral
	if params.Purpose != nil {
		purpose = string(*params.Purpose)
	}
	limit := s.maxFile
	if purpose == core.FileAvatar {
		limit = avatar.MaxBytes
	} else if purpose != core.FileGeneral {
		invalid(w, "purpose is general or avatar")
		return
	}
	switch {
	case r.ContentLength < 0:
		invalid(w, "send the file with a Content-Length")
		return
	case r.ContentLength == 0:
		invalid(w, "the file is empty")
		return
	case r.ContentLength > limit:
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, tooLargeMessage(purpose, limit))
		return
	}
	s.bodyDeadline(w, s.bodyTimeout+time.Duration(r.ContentLength/evidenceMinRate)*time.Second)
	body := http.MaxBytesReader(w, r.Body, limit)

	nf := core.NewFile{ID: store.NewID(), Name: params.Name, Purpose: purpose}
	nf.BlobKey = c.OrgID + "/" + nf.ID
	hash := sha256.New()
	var err error
	if purpose == core.FileAvatar {
		var png []byte
		if png, err = avatar.Square(body); err != nil {
			s.uploadFailed(w, r, err, purpose, limit)
			return
		}
		// The bytes are a PNG now, and the name says so.
		nf.Name = strings.TrimSuffix(nf.Name, path.Ext(nf.Name)) + ".png"
		nf.ContentType, nf.Size = "image/png", int64(len(png))
		hash.Write(png)
		err = s.files.Put(ctx, nf.BlobKey, bytes.NewReader(png), nf.Size, nf.ContentType)
	} else {
		br := bufio.NewReaderSize(body, 512)
		head, perr := br.Peek(512)
		if perr != nil && !errors.Is(perr, io.EOF) && !errors.Is(perr, bufio.ErrBufferFull) {
			s.uploadFailed(w, r, perr, purpose, limit)
			return
		}
		nf.ContentType, nf.Size = http.DetectContentType(head), r.ContentLength
		err = s.files.Put(ctx, nf.BlobKey, io.TeeReader(br, hash), nf.Size, nf.ContentType)
	}
	if err != nil {
		s.uploadFailed(w, r, err, purpose, limit)
		return
	}
	nf.SHA256 = hex.EncodeToString(hash.Sum(nil))
	out := as(http.StatusCreated, func(f core.File) any { return fileOut(f) })
	idem := core.Idem{Render: out, RenderRefusal: refusalOut}
	if params.IdempotencyKey != nil {
		// The file is identified by its hash, which is known only now.
		req := sha256.Sum256([]byte(r.Method + " " + r.URL.RequestURI() + "\n" + nf.SHA256))
		idem.Key, idem.Hash = *params.IdempotencyKey, hex.EncodeToString(req[:])
	}
	f, err := s.core.RecordFile(ctx, c, nf, idem)
	if err != nil {
		if derr := s.files.Delete(context.WithoutCancel(ctx), nf.BlobKey); derr != nil {
			s.log.Error("could not delete a file whose record failed", "key", nf.BlobKey, "err", derr)
		}
	}
	s.respond(w, r, out, f, err)
}

func tooLargeMessage(purpose string, limit int64) string {
	if purpose == core.FileAvatar {
		return "an avatar is at most 2 MiB"
	}
	return "the file is over this Install's limit of " + strconv.FormatInt(limit, 10) + " bytes"
}

// uploadFailed answers an upload whose bytes could not be read or kept.
func (s *Server) uploadFailed(w http.ResponseWriter, r *http.Request, err error, purpose string, limit int64) {
	var tooBig *http.MaxBytesError
	var slow net.Error
	switch {
	case errors.As(err, &tooBig) || errors.Is(err, avatar.ErrTooLarge):
		msg := tooLargeMessage(purpose, limit)
		if errors.Is(err, avatar.ErrTooLarge) && !errors.As(err, &tooBig) {
			msg = "the image is too many pixels for an avatar"
		}
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, msg)
	case errors.Is(err, avatar.ErrNotImage):
		invalid(w, "an avatar is a PNG, JPEG, WebP or GIF image")
	case errors.As(err, &slow) && slow.Timeout():
		invalid(w, "the file did not arrive in time")
	default:
		s.fail(w, r, err)
	}
}

func (s *Server) GetFile(w http.ResponseWriter, r *http.Request, file gen.FileID) {
	f, err := s.core.GetFile(r.Context(), caller(r), file)
	s.respond(w, r, as(http.StatusOK, func(f core.File) any { return fileOut(f) }), f, err)
}

// DownloadFile streams a file's bytes with the type found in them, never sniffed by the browser:
// inline for an image an <img> may show, as an attachment for anything else, so an uploaded page
// or SVG never runs as the Install's own. Bytes never change under an id, so they are cached.
func (s *Server) DownloadFile(w http.ResponseWriter, r *http.Request, file gen.FileID, params gen.DownloadFileParams) {
	ctx := r.Context()
	f, err := s.core.GetFile(ctx, caller(r), file)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.files == nil {
		writeError(w, http.StatusNotImplemented, gen.ErrorCodeNotImplemented, "this Install has no file store")
		return
	}
	h := w.Header()
	etag := `"` + f.SHA256 + `"`
	h.Set("ETag", etag)
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	if params.IfNoneMatch != nil && etagMatches(*params.IfNoneMatch, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	rc, err := s.files.Get(ctx, f.BlobKey)
	if errors.Is(err, blob.ErrNotFound) {
		s.log.Error("a file's bytes are missing from the file store", "file", f.ID, "key", f.BlobKey)
		writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, "the bytes of file "+f.ID+" are missing")
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer rc.Close()
	disposition := attachment(f.Name)
	if avatar.Types[f.ContentType] {
		disposition = "inline" + strings.TrimPrefix(disposition, "attachment")
	}
	h.Set("Content-Type", f.ContentType)
	h.Set("Content-Disposition", disposition)
	h.Set("Content-Length", strconv.FormatInt(f.Size, 10))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil && ctx.Err() == nil {
		s.log.Error("sending a file", "file", f.ID, "err", err)
	}
}

// etagMatches reports whether an If-None-Match header names etag, or is *.
func etagMatches(header, etag string) bool {
	for _, v := range strings.Split(header, ",") {
		v = strings.TrimPrefix(strings.TrimSpace(v), "W/")
		if v == etag || v == "*" {
			return true
		}
	}
	return false
}

func (s *Server) DeleteFile(w http.ResponseWriter, r *http.Request, file gen.FileID, params gen.DeleteFileParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	_, err := s.core.DeleteFile(r.Context(), c, file, idem)
	if err == nil {
		s.purgeFiles(r.Context(), c)
	}
	s.respond(w, r, noContent, nil, err)
}

// purgeFiles removes the bytes of the caller's Organisation's deleted files from the file store,
// after the write that deleted them: the one just made, and any an earlier request could not
// finish. A failure is logged and tried again by the next.
func (s *Server) purgeFiles(ctx context.Context, c *auth.Caller) {
	if s.files == nil {
		return
	}
	ctx = context.WithoutCancel(ctx)
	gone, err := s.core.Unpurged(ctx, c.OrgID, purgeBatch)
	if err != nil {
		s.log.Error("listing deleted files to purge", "err", err)
		return
	}
	for _, f := range gone {
		if err := s.files.Delete(ctx, f.BlobKey); err != nil && !errors.Is(err, blob.ErrNotFound) {
			s.log.Error("could not remove a deleted file's bytes", "file", f.ID, "key", f.BlobKey, "err", err)
			continue
		}
		if err := s.core.MarkPurged(ctx, c.OrgID, f.ID); err != nil {
			s.log.Error("could not mark a deleted file purged", "file", f.ID, "err", err)
		}
	}
}

func fileOut(f core.File) gen.File {
	return gen.File{ID: f.ID, Name: f.Name, ContentType: f.ContentType, Size: f.Size, Sha256: f.SHA256,
		Purpose: gen.FilePurpose(f.Purpose), CreatedBy: f.CreatedBy, CreatedAt: f.CreatedAt}
}
