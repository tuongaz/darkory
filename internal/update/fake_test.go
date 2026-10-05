package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

// fakeRelease is a release as goreleaser publishes it: the archive for one platform,
// checksums.txt and its signature. Tests break it by changing files.
type fakeRelease struct {
	version string
	files   map[string][]byte
}

func newFakeRelease(t *testing.T, key ed25519.PrivateKey, version, goos, goarch string, bin []byte) *fakeRelease {
	t.Helper()
	name := ArchiveName(version, goos, goarch)
	archive := makeArchive(t, name, goos, bin)
	sum := sha256.Sum256(archive)
	other := sha256.Sum256([]byte("another platform"))
	checksums := fmt.Appendf(nil, "%x  %s\n%x  %s\n", other, ArchiveName(version, "plan9", "386"), sum, name)
	return &fakeRelease{version: version, files: map[string][]byte{
		name:           archive,
		ChecksumsAsset: checksums,
		SignatureAsset: Sign(key, checksums),
	}}
}

// makeArchive packs bin as the darkory binary, beside a LICENSE, the way the release does.
func makeArchive(t *testing.T, name, goos string, bin []byte) []byte {
	t.Helper()
	binName := "darkory"
	if goos == "windows" {
		binName += ".exe"
	}
	var buf bytes.Buffer
	files := []struct {
		name string
		body []byte
	}{{"LICENSE", []byte("AGPL-3.0")}, {binName, bin}}
	if filepath.Ext(name) == ".zip" {
		zw := zip.NewWriter(&buf)
		for _, f := range files {
			h := &zip.FileHeader{Name: f.name, Method: zip.Deflate}
			h.SetMode(0o755)
			w, err := zw.CreateHeader(h)
			if err != nil {
				t.Fatal(err)
			}
			w.Write(f.body)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write(f.body)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// fakeGitHub serves releases through the parts of the GitHub API that Client uses. The last
// release is the latest.
type fakeGitHub struct {
	srv       *httptest.Server
	mu        sync.Mutex
	releases  []*fakeRelease
	lookups   atomic.Int32
	downloads atomic.Int32
}

func serveReleases(t *testing.T, releases ...*fakeRelease) *fakeGitHub {
	t.Helper()
	gh := &fakeGitHub{releases: releases}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/tuongaz/darkory/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		gh.lookups.Add(1)
		gh.mu.Lock()
		defer gh.mu.Unlock()
		if len(gh.releases) == 0 {
			http.NotFound(w, r)
			return
		}
		gh.writeRelease(w, gh.releases[len(gh.releases)-1])
	})
	mux.HandleFunc("GET /repos/tuongaz/darkory/releases/tags/{tag}", func(w http.ResponseWriter, r *http.Request) {
		gh.lookups.Add(1)
		gh.mu.Lock()
		defer gh.mu.Unlock()
		for _, rel := range gh.releases {
			if rel.version == r.PathValue("tag") {
				gh.writeRelease(w, rel)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("GET /download/{tag}/{name}", func(w http.ResponseWriter, r *http.Request) {
		gh.downloads.Add(1)
		gh.mu.Lock()
		defer gh.mu.Unlock()
		for _, rel := range gh.releases {
			if b, ok := rel.files[r.PathValue("name")]; ok && rel.version == r.PathValue("tag") {
				w.Write(b)
				return
			}
		}
		http.NotFound(w, r)
	})
	gh.srv = httptest.NewServer(mux)
	t.Cleanup(gh.srv.Close)
	return gh
}

func (gh *fakeGitHub) writeRelease(w http.ResponseWriter, rel *fakeRelease) {
	type asset struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	}
	body := struct {
		TagName string  `json:"tag_name"`
		HTMLURL string  `json:"html_url"`
		Assets  []asset `json:"assets"`
	}{TagName: rel.version, HTMLURL: gh.srv.URL + "/releases/" + rel.version}
	for name := range rel.files {
		body.Assets = append(body.Assets, asset{name, gh.srv.URL + "/download/" + rel.version + "/" + name})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(body)
}

func (gh *fakeGitHub) client() *Client {
	return &Client{BaseURL: gh.srv.URL, UserAgent: "darkory-test"}
}

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// buildFake builds testdata/fakedarkory reporting version and returns its path.
func buildFake(t *testing.T, version string) string {
	t.Helper()
	gobin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("needs the go command to build a fake release binary")
	}
	out := filepath.Join(t.TempDir(), "fakedarkory")
	if ext := exeExt(); ext != "" {
		out += ext
	}
	cmd := exec.Command(gobin, "build", "-o", out, "-ldflags", "-X main.version="+version, "./testdata/fakedarkory")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the fake binary: %v\n%s", err, b)
	}
	return out
}
