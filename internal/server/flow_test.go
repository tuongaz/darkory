package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
	"github.com/tuongaz/darkory/internal/update"
)

// model v2: the test that the spec's ActivityKind and SubjectType enums list exactly
// core.ActivityKinds and core.SubjectTypes went until M1b writes the spec's new enums; M1b
// restores it (git history, TestActivityKindsMatchTheSpec).

// Health says how humans sign in and, once the server has checked, whether a newer release exists.
func TestHealthReportsSignInAndUpdates(t *testing.T) {
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: mail.NewFake(), PublicURL: publicURL})
	anon := h.client("", "")
	res := got(anon.GetHealthWithResponse(t.Context())).want(t, http.StatusOK).JSON200
	if !slices.Equal(res.SignInModes, []client.SignInMode{client.SignInPrintedLink, client.SignInEmailLink}) ||
		res.UpdateAvailable != nil || res.LatestVersion != nil {
		t.Fatalf("health %+v", res)
	}
	h.srv.setUpdate(update.Status{Current: "v1.0.0", Latest: "v1.2.0"})
	res = got(anon.GetHealthWithResponse(t.Context())).want(t, http.StatusOK).JSON200
	if res.UpdateAvailable == nil || !*res.UpdateAvailable || res.LatestVersion == nil || *res.LatestVersion != "v1.2.0" {
		t.Fatalf("health after a check %+v", res)
	}

	plain := newHarness(t, storetest.Open(t, store.SQLite))
	res = got(plain.client("", "").GetHealthWithResponse(t.Context())).want(t, http.StatusOK).JSON200
	if !slices.Equal(res.SignInModes, []client.SignInMode{client.SignInPrintedLink}) {
		t.Fatalf("sign-in without email %v", res.SignInModes)
	}
}

// Activity reads backwards with `before`: a number past the newest entry reads the latest page,
// and each page's first_seq is the next page's `before`.
func TestActivityPagesBackwards(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		for _, k := range []string{"AA", "BB", "CC", "DD", "EE"} {
			got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: k, Name: k})).want(t, http.StatusCreated)
		}
		// Each Project records its creation and its first Workflow.
		all := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200
		n := len(all.Items)
		latest := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: ptr64(1 << 53), Limit: ptrInt(3)})).want(t, http.StatusOK).JSON200
		if len(latest.Items) != 3 || latest.Items[0].Seq != all.Items[n-3].Seq || latest.LastSeq != all.LastSeq || *latest.FirstSeq != latest.Items[0].Seq {
			t.Fatalf("latest page %+v", latest)
		}
		for _, a := range latest.Items {
			if (a.Kind != "project.created" || a.SubjectType != "project") && (a.Kind != "workflow.changed" || a.SubjectType != "workflow") {
				t.Fatalf("entry %+v", a)
			}
		}
		earlier := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: latest.FirstSeq, Limit: ptrInt(3)})).want(t, http.StatusOK).JSON200
		if len(earlier.Items) != 3 || earlier.Items[2].Seq != *latest.FirstSeq-1 {
			t.Fatalf("earlier page %+v", earlier)
		}
		first := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: ptr64(1)})).want(t, http.StatusOK).JSON200
		if len(first.Items) != 0 || first.FirstSeq != nil {
			t.Fatalf("before the first entry %+v", first)
		}
		got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: ptr64(0)})).want(t, http.StatusBadRequest)
	})
}

// With neither Last-Event-ID nor `after`, the stream starts from now.
func TestActivityStreamStartsFromNow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		before := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200.LastSeq
		stream := h.openStream(t, "")
		defer stream.close()
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		if ids := stream.events(t, 1); ids[0] != before+1 {
			t.Fatalf("the stream began with %v, want %d", ids, before+1)
		}
	})
}

// member makes a Member in team with skills and a token, and returns its client.
func (h *harness) member(name string, kind client.MemberKind, team string, skills ...string) (*client.ClientWithResponses, string) {
	t := h.t
	ctx := t.Context()
	m := got(h.admin.CreateMemberWithResponse(ctx, &client.CreateMemberParams{}, client.CreateMemberBody{Name: name, Kind: kind})).want(t, http.StatusCreated)
	if team != "" {
		got(h.admin.AddTeamMemberWithResponse(ctx, team, name, &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
	}
	for _, s := range skills {
		got(h.admin.GrantSkillWithResponse(ctx, name, s, &client.GrantSkillParams{})).want(t, http.StatusNoContent)
	}
	tok := got(h.admin.IssueTokenWithResponse(ctx, name, &client.IssueTokenParams{}, client.IssueTokenBody{Name: "main"})).want(t, http.StatusCreated)
	h.secrets[name] = tok.JSON201.Secret
	return h.client(tok.JSON201.Secret, name+"-1"), m.JSON201.ID
}

// blobFiles lists the files in an Evidence store's directory.
func blobFiles(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(p string, e fs.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			out = append(out, p)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func attach(t *testing.T, c *client.ClientWithResponses, task, filename, contentType string, body []byte, key *string) *client.AttachTaskEvidenceResponse {
	t.Helper()
	res, err := c.AttachTaskEvidenceWithBodyWithResponse(t.Context(), task, &client.AttachTaskEvidenceParams{Filename: filename, IdempotencyKey: key},
		contentType, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// Evidence goes to the store before its record; only the holder attaches to a held Task, and the
// owner or the Team to a Feature. A file over the limit, a path for a name or a refused record
// leaves no file behind. Downloads are attachments that are never sniffed.
func TestEvidence(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		dir := filepath.Join(t.TempDir(), "evidence")
		disk, err := blob.NewDisk(dir)
		if err != nil {
			t.Fatal(err)
		}
		h := newHarnessWith(t, st, Options{Blobs: disk, MaxEvidenceSize: 1024})
		ctx := t.Context()
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "OPS", Name: "Ops"})).want(t, http.StatusCreated)
		lead, _ := h.member("lead", client.Agent, "WEB")
		builder, builderID := h.member("builder", client.Agent, "WEB", "engineer")
		outsider, _ := h.member("outsider", client.Agent, "OPS")
		task := h.seed(h.secrets["lead"], core.NewTask{Project: ptrStr("WEB"), Title: "Build", Step: ptrStr("Build")}).Task
		got(builder.ClaimTaskWithResponse(ctx, task.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusOK)

		for _, c := range []*client.ClientWithResponses{lead, outsider} {
			if res := attach(t, c, task.Key, "x.txt", "text/plain", []byte("x"), nil); res.StatusCode() != http.StatusConflict || res.JSONDefault.Code != client.ErrorCodeNotHolder {
				t.Fatalf("a non-holder attached: %d %s", res.StatusCode(), res.Body)
			}
		}
		report := []byte("all green\n")
		first := attach(t, builder, task.Key, "report.txt", "text/plain; charset=utf-8", report, key("ev-1"))
		if first.StatusCode() != http.StatusCreated {
			t.Fatalf("attach: %d %s", first.StatusCode(), first.Body)
		}
		sum := sha256.Sum256(report)
		ev := first.JSON201
		if ev.Sha256 != hex.EncodeToString(sum[:]) || ev.Size != int64(len(report)) || ev.AttachedBy != builderID ||
			ev.TaskID == nil || *ev.TaskID != task.ID || ev.Filename != "report.txt" {
			t.Fatalf("evidence %+v", ev)
		}
		// A retry with its key gets the first reply; the key on another file is refused. Neither
		// leaves a second file.
		again := attach(t, builder, task.Key, "report.txt", "text/plain; charset=utf-8", report, key("ev-1"))
		if again.StatusCode() != http.StatusCreated || !bytes.Equal(again.Body, first.Body) {
			t.Fatalf("retry: %d %s", again.StatusCode(), again.Body)
		}
		reused := attach(t, builder, task.Key, "report.txt", "text/plain", []byte("other"), key("ev-1"))
		if reused.StatusCode() != http.StatusUnprocessableEntity {
			t.Fatalf("reused key: %d %s", reused.StatusCode(), reused.Body)
		}
		if files := blobFiles(t, dir); len(files) != 1 {
			t.Fatalf("files %v", files)
		}

		// Over the limit, a path for a name, no Content-Length: refused, nothing stored.
		if res := attach(t, builder, task.Key, "big.bin", "application/octet-stream", make([]byte, 2000), nil); res.StatusCode() != http.StatusRequestEntityTooLarge ||
			res.JSONDefault.Code != client.ErrorCodeTooLarge {
			t.Fatalf("too large: %d %s", res.StatusCode(), res.Body)
		}
		for _, bad := range []string{"../../etc/passwd", "a/b.txt", `..\x`, "bad\nname", " "} {
			if res := attach(t, builder, task.Key, bad, "text/plain", []byte("x"), nil); res.StatusCode() != http.StatusBadRequest {
				t.Fatalf("filename %q: %d %s", bad, res.StatusCode(), res.Body)
			}
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.ts.URL+"/v1/tasks/"+task.Key+"/evidence?filename=c.txt", io.NopCloser(strings.NewReader("chunked")))
		req.ContentLength = -1
		req.Header.Set("Authorization", "Bearer "+h.secrets["builder"])
		req.Header.Set("Darkory-Session", "builder-1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		assertError(t, res, http.StatusBadRequest, "invalid")
		if files := blobFiles(t, dir); len(files) != 1 {
			t.Fatalf("files after refusals %v", files)
		}

		// An uploaded page downloads as an attachment, never sniffed or run.
		page := []byte("<html><script>alert(document.cookie)</script></html>")
		html := attach(t, builder, task.Key, "page.html", "text/html", page, nil).JSON201
		dl := got(lead.DownloadEvidenceWithResponse(ctx, html.ID)).want(t, http.StatusOK)
		hd := dl.HTTPResponse.Header
		if hd.Get("Content-Type") != "text/html" || hd.Get("X-Content-Type-Options") != "nosniff" ||
			hd.Get("Content-Disposition") != `attachment; filename="page.html"; filename*=UTF-8''page.html` || !strings.Contains(hd.Get("Content-Security-Policy"), "sandbox") ||
			!bytes.Equal(dl.Body, page) {
			t.Fatalf("download headers %v body %q", hd, dl.Body)
		}
		meta := got(outsider.GetEvidenceWithResponse(ctx, html.ID)).want(t, http.StatusOK).JSON200
		if meta.ContentType != "text/html" || meta.Size != int64(len(page)) {
			t.Fatalf("record %+v", meta)
		}

		td := got(lead.GetTaskWithResponse(ctx, task.Key)).want(t, http.StatusOK).JSON200
		if len(td.Evidence) != 2 {
			t.Fatalf("Task Evidence %d", len(td.Evidence))
		}
		// model v2: Evidence on a Feature is Evidence on the Task it is now (M1b drops the route).
		got(builder.AttachFeatureEvidenceWithBodyWithResponse(ctx, task.Key, &client.AttachFeatureEvidenceParams{Filename: "shot.png"},
			"image/png", bytes.NewReader([]byte("png")))).want(t, http.StatusNotImplemented)
		// Once nobody holds the Task, its Project attaches to it.
		got(builder.ReleaseTaskWithResponse(ctx, task.Key, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{})).want(t, http.StatusOK)
		if res := attach(t, lead, task.Key, "after.txt", "text/plain", []byte("late"), nil); res.StatusCode() != http.StatusCreated {
			t.Fatalf("Team Member on a Task nobody holds: %d %s", res.StatusCode(), res.Body)
		}
		if files := blobFiles(t, dir); len(files) != 3 {
			t.Fatalf("files %v", files)
		}
		for _, f := range blobFiles(t, dir) {
			if !strings.HasPrefix(f, dir+string(os.PathSeparator)) || strings.Contains(filepath.Base(f), ".put-") {
				t.Fatalf("stray file %s", f)
			}
		}
	})
}

func ptrStr(s string) *string { return &s }

func ptr64(n int64) *int64 { return &n }
