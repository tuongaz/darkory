package blob_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Evidence attached through /v1 to an Install set to S3 lands in the bucket under its prefix, and
// downloads back.
func TestEvidenceThroughTheAPIInS3(t *testing.T) {
	set := blob.StartMinIO(t)
	ctx := t.Context()
	blobs, err := blob.Open(ctx, blob.Settings{Dir: t.TempDir(), S3: &set}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := blobs.(*blob.S3); !ok {
		t.Fatalf("opened a %T, want S3", blobs)
	}
	srv := server.New(storetest.Open(t, store.SQLite), server.Options{Blobs: blobs})
	init, err := srv.Core().Init(ctx, "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	ada, err := client.NewClientWithResponses(ts.URL, client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+init.Token.Secret)
		req.Header.Set("Darkory-Session", "ada-1")
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if res, err := ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"}); err != nil || res.StatusCode() != http.StatusCreated {
		t.Fatalf("create team: %v", err)
	}
	if res, err := ada.AddTeamMemberWithResponse(ctx, "WEB", "ada", &client.AddTeamMemberParams{}); err != nil || res.StatusCode() != http.StatusNoContent {
		t.Fatalf("join team: %v", err)
	}
	filed, err := ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Sign-up"})
	if err != nil || filed.JSON201 == nil {
		t.Fatalf("file feature: %v", err)
	}
	png := bytes.Repeat([]byte("screenshot "), 1000)
	att, err := ada.AttachFeatureEvidenceWithBodyWithResponse(ctx, filed.JSON201.Feature.Key,
		&client.AttachFeatureEvidenceParams{Filename: "shot.png"}, "image/png", bytes.NewReader(png))
	if err != nil || att.JSON201 == nil {
		t.Fatalf("attach: %v %s", err, att.Body)
	}

	// In the bucket, under the Install's prefix, at <organisation>/<evidence>.
	direct, err := blob.NewS3(set, nil)
	if err != nil {
		t.Fatal(err)
	}
	r, err := direct.Get(ctx, init.Organisation.ID+"/"+att.JSON201.ID)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := io.ReadAll(r)
	r.Close()
	if !bytes.Equal(stored, png) {
		t.Fatalf("the bucket holds %d bytes, want %d", len(stored), len(png))
	}
	dl, err := ada.DownloadEvidenceWithResponse(ctx, att.JSON201.ID)
	if err != nil || dl.StatusCode() != http.StatusOK || !bytes.Equal(dl.Body, png) {
		t.Fatalf("download: %v, status %d, %d bytes", err, dl.StatusCode(), len(dl.Body))
	}
}
