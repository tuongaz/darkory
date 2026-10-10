package remote

import (
	"bytes"
	"context"
	"mime"
	"net/http"
	"path/filepath"

	"github.com/tuongaz/darkory/client"
)

// ContentType names a file's content type from its extension, else from its first bytes.
func ContentType(name string, content []byte) string {
	if t := mime.TypeByExtension(filepath.Ext(name)); t != "" {
		return t
	}
	return http.DetectContentType(content)
}

// Attach attaches content as Evidence of kind to the Task ref names (Evidence on a Parent is the
// Parent's own): evidence about the work, or a Shift's log. It returns the Evidence and the reply
// body.
func (c *Conn) Attach(ctx context.Context, ref, filename, contentType string, kind client.EvidenceKind, content []byte) (client.Evidence, []byte, error) {
	params := &client.AttachTaskEvidenceParams{Filename: filename}
	if kind != client.EvidenceKindEvidence {
		params.Kind = &kind // evidence is the default, so a plain attach asks as it always has
	}
	// A *bytes.Reader lets a retry resend the body.
	res, err := c.AttachTaskEvidenceWithBodyWithResponse(ctx, ref, params, contentType, bytes.NewReader(content))
	if err := Check(res, err, http.StatusCreated); err != nil {
		return client.Evidence{}, nil, err
	}
	return *res.JSON201, res.Body, nil
}
