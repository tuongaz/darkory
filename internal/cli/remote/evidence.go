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

// Attach attaches content as Evidence to the Task ref names, or to the Feature when no Task has
// that reference or toFeature says so. Display keys share one counter per Team across Features and
// Tasks, so WEB-1 may be either; a Task is asked for first. It returns the Evidence and the reply
// body.
func (c *Conn) Attach(ctx context.Context, ref, filename, contentType string, content []byte, toFeature bool) (client.Evidence, []byte, error) {
	if !toFeature {
		res, err := c.GetTaskWithResponse(ctx, ref)
		err = Check(res, err, http.StatusOK)
		if err != nil && CodeOf(err) != client.ErrorCodeNotFound {
			return client.Evidence{}, nil, err
		}
		toFeature = err != nil
	}
	// A *bytes.Reader lets a retry resend the body.
	if !toFeature {
		res, err := c.AttachTaskEvidenceWithBodyWithResponse(ctx, ref, &client.AttachTaskEvidenceParams{Filename: filename}, contentType, bytes.NewReader(content))
		if err := Check(res, err, http.StatusCreated); err != nil {
			return client.Evidence{}, nil, err
		}
		return *res.JSON201, res.Body, nil
	}
	res, err := c.AttachFeatureEvidenceWithBodyWithResponse(ctx, ref, &client.AttachFeatureEvidenceParams{Filename: filename}, contentType, bytes.NewReader(content))
	if err := Check(res, err, http.StatusCreated); err != nil {
		return client.Evidence{}, nil, err
	}
	return *res.JSON201, res.Body, nil
}
