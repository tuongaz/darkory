package update

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckAsksAtMostOnceADay(t *testing.T) {
	_, priv := newKey(t)
	gh := serveReleases(t, newFakeRelease(t, priv, "v1.3.0", "linux", "amd64", []byte("x")))
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	c := &Checker{
		Client:    gh.client(),
		Current:   "v1.2.0",
		CacheFile: filepath.Join(t.TempDir(), "darkory", "update-check.json"),
		Now:       func() time.Time { return now },
	}

	st, err := c.Check(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Available() || st.Latest != "v1.3.0" || st.URL == "" {
		t.Fatalf("Check = %+v, want v1.3.0 available", st)
	}
	now = now.Add(23 * time.Hour)
	if st, err := c.Check(t.Context()); err != nil || !st.Available() {
		t.Fatalf("Check from the cache = %+v, %v", st, err)
	}
	if n := gh.lookups.Load(); n != 1 {
		t.Fatalf("%d lookups within a day, want 1", n)
	}

	// A new Checker, as the next command would make, reads the same cache.
	again := *c
	if _, err := again.Check(t.Context()); err != nil || gh.lookups.Load() != 1 {
		t.Fatalf("a second Checker looked up again: %d lookups, %v", gh.lookups.Load(), err)
	}

	now = now.Add(2 * time.Hour)
	if _, err := c.Check(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := gh.lookups.Load(); n != 2 {
		t.Errorf("%d lookups after a day, want 2", n)
	}
}

func TestCheckRemembersAFailedAsk(t *testing.T) {
	_, priv := newKey(t)
	gh := serveReleases(t, newFakeRelease(t, priv, "v1.3.0", "linux", "amd64", []byte("x")))
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	cache := filepath.Join(t.TempDir(), "update-check.json")
	c := &Checker{Client: gh.client(), Current: "v1.2.0", CacheFile: cache, Now: func() time.Time { return now }}
	if _, err := c.Check(t.Context()); err != nil {
		t.Fatal(err)
	}

	// A day later the API is down: the check fails, keeps the answer it had, and is not
	// retried for another day.
	now = now.Add(25 * time.Hour)
	down := &Checker{Client: &Client{BaseURL: unavailable(t)}, Current: "v1.2.0", CacheFile: cache, Now: c.Now}
	st, err := down.Check(t.Context())
	if err == nil {
		t.Fatal("Check against a failing API returned no error")
	}
	if st.Latest != "v1.3.0" || !st.Available() {
		t.Errorf("Check after a failure = %+v, want the previous answer", st)
	}
	now = now.Add(time.Hour)
	if st, err := down.Check(t.Context()); err != nil || st.Latest != "v1.3.0" {
		t.Errorf("Check an hour after a failure = %+v, %v, want the cached answer and no ask", st, err)
	}
}

func unavailable(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// TestCheckGivesUpAtTheTimeout checks Check against an API that never answers.
func TestCheckGivesUpAtTheTimeout(t *testing.T) {
	if CheckTimeout > time.Second {
		t.Errorf("CheckTimeout is %v; a notice may delay a command by about a second at most", CheckTimeout)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	c := &Checker{Client: &Client{BaseURL: srv.URL}, Current: "v1.2.0", CacheFile: filepath.Join(t.TempDir(), "c.json"), Timeout: 200 * time.Millisecond}
	start := time.Now()
	_, err := c.Check(t.Context())
	took := time.Since(start)
	if err == nil {
		t.Fatal("Check against a silent API returned no error")
	}
	if took < c.Timeout || took > 5*c.Timeout {
		t.Errorf("Check took %v with a %v timeout", took, c.Timeout)
	}
}

func TestCheckSkipsDevBuilds(t *testing.T) {
	_, priv := newKey(t)
	gh := serveReleases(t, newFakeRelease(t, priv, "v1.3.0", "linux", "amd64", []byte("x")))
	for _, v := range []string{"dev", "v1.2.0-3-gabc1234", "v1.2.0-dirty", "1.2.1-SNAPSHOT-abc1234"} {
		c := &Checker{Client: gh.client(), Current: v}
		st, err := c.Check(t.Context())
		if err != nil || st.Available() {
			t.Errorf("Check for %s = %+v, %v, want nothing available", v, st, err)
		}
	}
	if n := gh.lookups.Load(); n != 0 {
		t.Errorf("dev builds made %d lookups", n)
	}
}

func TestCheckWithoutACacheAsksEveryTime(t *testing.T) {
	_, priv := newKey(t)
	gh := serveReleases(t, newFakeRelease(t, priv, "v1.2.0", "linux", "amd64", []byte("x")))
	c := &Checker{Client: gh.client(), Current: "v1.2.0"}
	for range 2 {
		st, err := c.Check(t.Context())
		if err != nil || st.Available() {
			t.Fatalf("Check = %+v, %v, want up to date", st, err)
		}
	}
	if n := gh.lookups.Load(); n != 2 {
		t.Errorf("%d lookups, want 2", n)
	}
}

func TestDisabled(t *testing.T) {
	for v, want := range map[string]bool{"": false, "0": false, "false": false, "1": true, "true": true, "yes": true} {
		if got := Disabled(func(string) string { return v }); got != want {
			t.Errorf("Disabled with DARKORY_NO_UPDATE_CHECK=%q = %v, want %v", v, got, want)
		}
	}
}

func TestNoticeNamesTheRightCommand(t *testing.T) {
	st := Status{Current: "v1.2.0", Latest: "v1.3.0"}
	for kind, want := range map[Install]string{
		Standalone: "darkory update",
		Homebrew:   "brew upgrade darkory",
		Container:  "docker pull ghcr.io/tuongaz/darkory:latest",
	} {
		if n := Notice(st, kind); !strings.Contains(n, want) || !strings.Contains(n, "v1.3.0") {
			t.Errorf("Notice for %v = %q, want it to name v1.3.0 and %q", kind, n, want)
		}
	}
}
