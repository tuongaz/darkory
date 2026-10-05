package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
)

// Evidence travels as the raw request body (decisions.md). The file is streamed to the Evidence
// store, hashed on the way, before the write that records it, so no upload holds the
// Organisation's counter (ADR 0011); a record that fails deletes the file.

func (s *Server) AttachTaskEvidence(w http.ResponseWriter, r *http.Request, task gen.TaskRef, params gen.AttachTaskEvidenceParams) {
	s.attachEvidence(w, r, core.EvidenceTarget{Task: &task}, params.Filename, params.IdempotencyKey)
}

func (s *Server) AttachFeatureEvidence(w http.ResponseWriter, r *http.Request, feature gen.FeatureRef, params gen.AttachFeatureEvidenceParams) {
	s.attachEvidence(w, r, core.EvidenceTarget{Feature: &feature}, params.Filename, params.IdempotencyKey)
}

func (s *Server) attachEvidence(w http.ResponseWriter, r *http.Request, target core.EvidenceTarget, filename string, key *string) {
	ctx, c := r.Context(), caller(r)
	if s.blobs == nil {
		writeError(w, http.StatusNotImplemented, gen.ErrorCodeNotImplemented, "this Install has no Evidence store")
		return
	}
	if msg := checkFilename(filename); msg != "" {
		invalid(w, msg)
		return
	}
	contentType, ok := evidenceType(r.Header.Get("Content-Type"))
	if !ok {
		invalid(w, "the Content-Type is not a media type")
		return
	}
	switch {
	case r.ContentLength < 0:
		invalid(w, "send the file with a Content-Length")
		return
	case r.ContentLength > s.maxEvidence:
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge,
			"the file is over this Install's Evidence limit of "+strconv.FormatInt(s.maxEvidence, 10)+" bytes")
		return
	}
	// Refuse before uploading anything; the write checks again under the counter.
	if err := s.core.MayAttachEvidence(ctx, c, target); err != nil {
		s.fail(w, r, err)
		return
	}
	id := store.NewID()
	blobKey := c.OrgID + "/" + id
	hash := sha256.New()
	body := io.TeeReader(http.MaxBytesReader(w, r.Body, s.maxEvidence), hash)
	if err := s.blobs.Put(ctx, blobKey, body, r.ContentLength, contentType); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, "the file is over this Install's Evidence limit")
			return
		}
		s.fail(w, r, err)
		return
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	out := as(http.StatusCreated, func(e core.Evidence) any { return evidenceOut(e) })
	idem := core.Idem{Render: out}
	if key != nil {
		// The file is identified by its hash, which is known only now.
		req := sha256.Sum256([]byte(r.Method + " " + r.URL.RequestURI() + "\n" + contentType + "\n" + sum))
		idem.Key, idem.Hash = *key, hex.EncodeToString(req[:])
	}
	e, err := s.core.AttachEvidence(ctx, c, target, core.NewEvidence{ID: id, BlobKey: blobKey, Filename: filename,
		ContentType: contentType, Size: r.ContentLength, SHA256: sum}, idem)
	if err != nil {
		if derr := s.blobs.Delete(context.WithoutCancel(ctx), blobKey); derr != nil {
			s.log.Error("could not delete an Evidence file whose record failed", "key", blobKey, "err", derr)
		}
	}
	s.respond(w, r, out, e, err)
}

// checkFilename says what is wrong with an Evidence file name, or "" when nothing is.
func checkFilename(name string) string {
	switch {
	case strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > 255:
		return "filename is 1 to 255 characters"
	case !utf8.ValidString(name) || strings.ContainsFunc(name, unicode.IsControl):
		return "filename holds a control character"
	case strings.ContainsAny(name, `/\`):
		return "filename is a name, not a path"
	}
	return ""
}

// evidenceType normalises the upload's Content-Type; none means application/octet-stream.
func evidenceType(header string) (string, bool) {
	if strings.TrimSpace(header) == "" {
		return "application/octet-stream", true
	}
	mt, params, err := mime.ParseMediaType(header)
	if err != nil {
		return "", false
	}
	return mime.FormatMediaType(mt, params), true
}

func (s *Server) GetEvidence(w http.ResponseWriter, r *http.Request, evidence gen.EvidenceID) {
	e, err := s.core.GetEvidence(r.Context(), caller(r), evidence)
	s.respond(w, r, as(http.StatusOK, func(e core.Evidence) any { return evidenceOut(e) }), e, err)
}

// DownloadEvidence streams an Evidence file back with the content type it was attached with,
// always as an attachment and never sniffed, so an uploaded page cannot run as the Install's own.
func (s *Server) DownloadEvidence(w http.ResponseWriter, r *http.Request, evidence gen.EvidenceID) {
	ctx := r.Context()
	e, err := s.core.GetEvidence(ctx, caller(r), evidence)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if s.blobs == nil {
		writeError(w, http.StatusNotImplemented, gen.ErrorCodeNotImplemented, "this Install has no Evidence store")
		return
	}
	rc, err := s.blobs.Get(ctx, e.BlobKey)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	defer rc.Close()
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": e.Filename})
	if disposition == "" {
		disposition = "attachment"
	}
	h := w.Header()
	h.Set("Content-Type", e.ContentType)
	h.Set("Content-Disposition", disposition)
	h.Set("Content-Length", strconv.FormatInt(e.Size, 10))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, no-cache")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, rc); err != nil && ctx.Err() == nil {
		s.log.Error("sending an Evidence file", "evidence", e.ID, "err", err)
	}
}
