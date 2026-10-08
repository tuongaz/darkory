package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

func upload(t *testing.T, c *client.ClientWithResponses, name, purpose, contentType string, body []byte, key *string) *client.UploadFileResponse {
	t.Helper()
	params := &client.UploadFileParams{Name: name, IdempotencyKey: key}
	if purpose != "" {
		p := client.FilePurpose(purpose)
		params.Purpose = &p
	}
	res, err := c.UploadFileWithBodyWithResponse(t.Context(), params, contentType, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func setAvatar(t *testing.T, c *client.ClientWithResponses, member, file string) (*client.UpdateMemberResponse, error) {
	t.Helper()
	return c.UpdateMemberWithResponse(t.Context(), member, &client.UpdateMemberParams{}, client.UpdateMemberBody{AvatarFileID: &file})
}

// otherOrganisation makes a second Organisation on the Install, as a Cloud Install holds, with
// an admin and a client for them.
func otherOrganisation(t *testing.T, h *harness, st *store.Store) *client.ClientWithResponses {
	t.Helper()
	ctx := t.Context()
	org := storetest.Organisation(t, st)
	boot := &auth.Caller{OrgID: org, MemberID: h.adminID, Admin: true}
	m, err := h.srv.Core().CreateMember(ctx, boot, core.NewMember{Name: "zed", Kind: "human", Admin: true}, core.Idem{})
	if err != nil {
		t.Fatal(err)
	}
	tok, err := h.srv.Core().IssueToken(ctx, &auth.Caller{OrgID: org, MemberID: m.ID, Admin: true}, m.ID, "main", 0, core.Idem{})
	if err != nil {
		t.Fatal(err)
	}
	return h.client(tok.Secret, "zed-1")
}

// Files: the server keeps the type it reads in the bytes, never the one claimed; images are served
// inline and everything else as an attachment, never sniffed, cached by their hash. An avatar is
// checked to be an image and made a square PNG. A Member sets their own avatar if human, an admin
// anyone's; a released avatar is deleted and its bytes purged. Another Organisation finds nothing.
func TestFiles(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		dir := filepath.Join(t.TempDir(), "files")
		disk, err := blob.NewDisk(dir)
		if err != nil {
			t.Fatal(err)
		}
		h := newHarnessWith(t, st, Options{Files: disk, MaxFileSize: 4096})
		ctx := t.Context()
		got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bob, bobID := h.member("bob", client.Human, "WEB")
		qa, qaID := h.member("qa", client.Agent, "WEB")

		// A general file: its type is read from its bytes, whatever the request said.
		notes := []byte("plain notes\n")
		first := upload(t, bob, "notes.png", "", "image/png", notes, key("f-1"))
		if first.StatusCode() != http.StatusCreated {
			t.Fatalf("upload: %d %s", first.StatusCode(), first.Body)
		}
		f := first.JSON201
		sum := sha256.Sum256(notes)
		if f.ContentType != "text/plain; charset=utf-8" || f.Size != int64(len(notes)) || f.Sha256 != hex.EncodeToString(sum[:]) ||
			f.Purpose != client.FilePurposeGeneral || f.CreatedBy != bobID || f.Name != "notes.png" {
			t.Fatalf("file %+v", f)
		}
		again := upload(t, bob, "notes.png", "", "image/png", notes, key("f-1"))
		if again.StatusCode() != http.StatusCreated || !bytes.Equal(again.Body, first.Body) {
			t.Fatalf("retry: %d %s", again.StatusCode(), again.Body)
		}
		if files := blobFiles(t, dir); len(files) != 1 {
			t.Fatalf("a retry stored a second file: %v", files)
		}
		meta := got(qa.GetFileWithResponse(ctx, f.ID)).want(t, http.StatusOK).JSON200
		if meta.ID != f.ID || meta.ContentType != f.ContentType {
			t.Fatalf("record %+v", meta)
		}
		dl := got(qa.DownloadFileWithResponse(ctx, f.ID, &client.DownloadFileParams{})).want(t, http.StatusOK)
		hd := dl.HTTPResponse.Header
		if hd.Get("Content-Type") != "text/plain; charset=utf-8" || hd.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.HasPrefix(hd.Get("Content-Disposition"), "attachment;") || hd.Get("ETag") != `"`+f.Sha256+`"` ||
			!strings.Contains(hd.Get("Cache-Control"), "private") || !strings.Contains(hd.Get("Content-Security-Policy"), "sandbox") ||
			!bytes.Equal(dl.Body, notes) {
			t.Fatalf("download headers %v body %q", hd, dl.Body)
		}
		etag := hd.Get("ETag")
		got(qa.DownloadFileWithResponse(ctx, f.ID, &client.DownloadFileParams{IfNoneMatch: &etag})).want(t, http.StatusNotModified)

		// A page is kept as one but only ever downloads as an attachment.
		page := []byte("<!DOCTYPE html><html><script>alert(document.cookie)</script></html>")
		pg := upload(t, bob, "page.txt", "", "text/plain", page, nil).JSON201
		if pg == nil || pg.ContentType != "text/html; charset=utf-8" {
			t.Fatalf("page %+v", pg)
		}
		pdl := got(bob.DownloadFileWithResponse(ctx, pg.ID, &client.DownloadFileParams{})).want(t, http.StatusOK)
		if d := pdl.HTTPResponse.Header.Get("Content-Disposition"); !strings.HasPrefix(d, "attachment;") {
			t.Fatalf("a page downloads as %q", d)
		}

		// Refusals leave nothing behind: over the limit, a path for a name, an empty file.
		if res := upload(t, bob, "big.bin", "", "application/octet-stream", make([]byte, 5000), nil); res.StatusCode() != http.StatusRequestEntityTooLarge {
			t.Fatalf("too large: %d %s", res.StatusCode(), res.Body)
		}
		for _, bad := range []string{"../x", "a/b", "bad‮name", " "} {
			if res := upload(t, bob, bad, "", "text/plain", []byte("x"), nil); res.StatusCode() != http.StatusBadRequest {
				t.Fatalf("name %q: %d %s", bad, res.StatusCode(), res.Body)
			}
		}
		if res := upload(t, bob, "empty.txt", "", "text/plain", nil, nil); res.StatusCode() != http.StatusBadRequest {
			t.Fatalf("empty: %d %s", res.StatusCode(), res.Body)
		}

		// An avatar must be an image, never SVG or HTML, and at most 2 MiB; it is kept as a PNG
		// at most 256 pixels square, shown inline.
		svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`)
		for name, body := range map[string][]byte{"a.svg": svg, "a.html": page, "a.txt": notes} {
			res := upload(t, h.admin, name, "avatar", "image/png", body, nil)
			if res.StatusCode() != http.StatusBadRequest || res.JSONDefault.Code != client.ErrorCodeInvalid {
				t.Fatalf("%s as an avatar: %d %s", name, res.StatusCode(), res.Body)
			}
		}
		if res := upload(t, h.admin, "huge.png", "avatar", "image/png", make([]byte, 2<<20+1), nil); res.StatusCode() != http.StatusRequestEntityTooLarge {
			t.Fatalf("an avatar over 2 MiB: %d %s", res.StatusCode(), res.Body)
		}
		before := len(blobFiles(t, dir))
		av := upload(t, h.admin, "qa.jpeg", "avatar", "image/jpeg", pngOf(t, 600, 300), nil)
		if av.StatusCode() != http.StatusCreated {
			t.Fatalf("avatar: %d %s", av.StatusCode(), av.Body)
		}
		a := av.JSON201
		if a.ContentType != "image/png" || a.Purpose != client.FilePurposeAvatar || a.Name != "qa.png" {
			t.Fatalf("avatar %+v", a)
		}
		adl := got(bob.DownloadFileWithResponse(ctx, a.ID, &client.DownloadFileParams{})).want(t, http.StatusOK)
		if d := adl.HTTPResponse.Header.Get("Content-Disposition"); !strings.HasPrefix(d, "inline;") {
			t.Fatalf("an avatar is served as %q", d)
		}
		img, err := png.Decode(bytes.NewReader(adl.Body))
		if err != nil || img.Bounds().Dx() != 256 || img.Bounds().Dy() != 256 {
			t.Fatalf("avatar image %v %v", img.Bounds(), err)
		}
		if n := len(blobFiles(t, dir)); n != before+1 {
			t.Fatalf("files %d, want %d", n, before+1)
		}

		// Who sets an avatar: an admin anyone's; a human their own, and nothing else; an agent
		// not even its own. Only a file uploaded as an avatar.
		m := got(setAvatar(t, h.admin, "qa", a.ID)).want(t, http.StatusOK).JSON200
		if m.AvatarFileID == nil || *m.AvatarFileID != a.ID {
			t.Fatalf("qa %+v", m)
		}
		listed := got(bob.ListMembersWithResponse(ctx, &client.ListMembersParams{})).want(t, http.StatusOK).JSON200
		for _, x := range listed.Items {
			if x.ID == qaID && (x.AvatarFileID == nil || *x.AvatarFileID != a.ID) {
				t.Fatalf("listed qa %+v", x)
			}
		}
		mine := upload(t, bob, "me.png", "avatar", "image/png", pngOf(t, 40, 40), nil).JSON201
		got(setAvatar(t, bob, "qa", mine.ID)).want(t, http.StatusForbidden)
		got(setAvatar(t, bob, "ada", mine.ID)).want(t, http.StatusForbidden)
		got(setAvatar(t, qa, "qa", mine.ID)).want(t, http.StatusForbidden)
		got(setAvatar(t, bob, "bob", f.ID)).want(t, http.StatusBadRequest)
		name := "robert"
		got(bob.UpdateMemberWithResponse(ctx, "bob", &client.UpdateMemberParams{}, client.UpdateMemberBody{Name: &name, AvatarFileID: &mine.ID})).
			want(t, http.StatusForbidden)
		if me := got(setAvatar(t, bob, "bob", mine.ID)).want(t, http.StatusOK).JSON200; me.AvatarFileID == nil || *me.AvatarFileID != mine.ID {
			t.Fatalf("bob %+v", me)
		}

		// A file someone shows as their avatar is not deleted; only its uploader or an admin
		// deletes a file, and its bytes go.
		del := got(h.admin.DeleteFileWithResponse(ctx, a.ID, &client.DeleteFileParams{})).want(t, http.StatusConflict)
		if del.JSONDefault.Code != client.ErrorCodeConflict {
			t.Fatalf("delete an avatar: %s", del.Body)
		}
		got(qa.DeleteFileWithResponse(ctx, f.ID, &client.DeleteFileParams{})).want(t, http.StatusForbidden)
		count := len(blobFiles(t, dir))
		got(bob.DeleteFileWithResponse(ctx, f.ID, &client.DeleteFileParams{})).want(t, http.StatusNoContent)
		got(bob.GetFileWithResponse(ctx, f.ID)).want(t, http.StatusNotFound)
		got(bob.DownloadFileWithResponse(ctx, f.ID, &client.DownloadFileParams{})).want(t, http.StatusNotFound)
		if n := len(blobFiles(t, dir)); n != count-1 {
			t.Fatalf("files after delete %d, want %d", n, count-1)
		}
		got(h.admin.DeleteFileWithResponse(ctx, pg.ID, &client.DeleteFileParams{})).want(t, http.StatusNoContent)

		// Replacing an avatar deletes the one it replaces; removing it does too.
		next := upload(t, h.admin, "qa2.png", "avatar", "image/png", pngOf(t, 300, 300), nil).JSON201
		got(setAvatar(t, h.admin, "qa", next.ID)).want(t, http.StatusOK)
		got(h.admin.GetFileWithResponse(ctx, a.ID)).want(t, http.StatusNotFound)
		cleared := got(setAvatar(t, h.admin, qaID, "")).want(t, http.StatusOK).JSON200
		if cleared.AvatarFileID != nil {
			t.Fatalf("cleared %+v", cleared)
		}
		got(h.admin.GetFileWithResponse(ctx, next.ID)).want(t, http.StatusNotFound)
		if n := len(blobFiles(t, dir)); n != 1 {
			t.Fatalf("only bob's avatar should be left: %v", blobFiles(t, dir))
		}
		unp, err := h.srv.Core().Unpurged(ctx, orgOf(t, h), 10)
		if err != nil || len(unp) != 0 {
			t.Fatalf("unpurged %v %v", unp, err)
		}

		// Uploads and deletions are in the Activity.
		kinds := []client.ActivityKind{client.ActivityKindFileUploaded, client.ActivityKindFileDeleted}
		page2 := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{Kind: &kinds})).want(t, http.StatusOK).JSON200
		if len(page2.Items) < 6 {
			t.Fatalf("file Activity %d entries", len(page2.Items))
		}

		// Another Organisation finds none of it.
		zed := otherOrganisation(t, h, st)
		got(zed.GetFileWithResponse(ctx, mine.ID)).want(t, http.StatusNotFound)
		got(zed.DownloadFileWithResponse(ctx, mine.ID, &client.DownloadFileParams{})).want(t, http.StatusNotFound)
		got(zed.DeleteFileWithResponse(ctx, mine.ID, &client.DeleteFileParams{})).want(t, http.StatusNotFound)
		got(setAvatar(t, zed, "zed", mine.ID)).want(t, http.StatusNotFound)
		got(bob.GetFileWithResponse(ctx, mine.ID)).want(t, http.StatusOK)
	})
}

// orgOf returns the harness's Organisation id.
func orgOf(t *testing.T, h *harness) string {
	t.Helper()
	me := got(h.admin.GetMeWithResponse(t.Context())).want(t, http.StatusOK).JSON200
	return me.Organisation.ID
}

// An Install with no file store says so.
func TestFilesWithoutStore(t *testing.T) {
	h := newHarness(t, storetest.Open(t, store.SQLite))
	res := upload(t, h.admin, "a.txt", "", "text/plain", []byte("x"), nil)
	if res.StatusCode() != http.StatusNotImplemented {
		t.Fatalf("no store: %d %s", res.StatusCode(), res.Body)
	}
}
