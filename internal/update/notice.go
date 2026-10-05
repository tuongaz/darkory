package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/tuongaz/darkory/internal/version"
)

// Defaults for the update notice.
const (
	CheckInterval = 24 * time.Hour
	CheckTimeout  = time.Second
)

// NewClient returns a Client for the published releases, or for the API at DARKORY_UPDATE_URL
// when that is set (a mirror, or a local test server). Signatures are checked against the
// compiled-in key whichever API answers.
func NewClient(getenv func(string) string) *Client {
	return &Client{BaseURL: getenv("DARKORY_UPDATE_URL"), UserAgent: "darkory/" + version.Version}
}

// Disabled reports whether DARKORY_NO_UPDATE_CHECK turns the update notice off.
func Disabled(getenv func(string) string) bool {
	switch getenv("DARKORY_NO_UPDATE_CHECK") {
	case "", "0", "false":
		return false
	}
	return true
}

// DefaultCacheFile is where the last check is remembered, or "" when the user has no cache
// directory.
func DefaultCacheFile() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "darkory", "update-check.json")
}

// Checker finds whether a newer release exists. It asks at most once per Interval, remembering
// the answer in CacheFile, and waits at most Timeout for an answer. Dev builds never ask.
type Checker struct {
	Client *Client
	// Current is the running version.
	Current string
	// CacheFile remembers the last check; empty means no memory, so every Check asks.
	CacheFile string
	// Interval is how long an answer is trusted; zero means CheckInterval.
	Interval time.Duration
	// Timeout bounds how long Check waits for an answer; zero means CheckTimeout.
	Timeout time.Duration
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

// NewChecker returns the Checker the CLI and the server use: the published releases, the
// user's cache directory, a day between checks and a second's wait.
func NewChecker(current string) *Checker {
	return &Checker{Client: NewClient(os.Getenv), Current: current, CacheFile: DefaultCacheFile()}
}

// Status is what a check found.
type Status struct {
	// Current is the running version.
	Current string
	// Latest is the newest release known, or "" when no check has succeeded.
	Latest string
	// URL is Latest's release page.
	URL string
	// CheckedAt is when Latest was last asked for.
	CheckedAt time.Time
}

// Available reports whether a release newer than the running one exists.
func (s Status) Available() bool {
	return s.Latest != "" && !IsDevBuild(s.Current) && Newer(s.Latest, s.Current)
}

type cacheEntry struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest,omitempty"`
	URL       string    `json:"url,omitempty"`
}

// Check returns the newest release known, asking for it when the remembered answer is older
// than Interval. A failed ask is remembered too, so an offline machine asks once per Interval;
// the Status then carries the previous answer along with the error.
func (c *Checker) Check(ctx context.Context) (Status, error) {
	if IsDevBuild(c.Current) {
		return Status{Current: c.Current}, nil
	}
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	prev := c.read()
	if !prev.CheckedAt.IsZero() && !prev.CheckedAt.After(now) && now.Sub(prev.CheckedAt) < or(c.Interval, CheckInterval) {
		return Status{Current: c.Current, Latest: prev.Latest, URL: prev.URL, CheckedAt: prev.CheckedAt}, nil
	}
	rel, err := c.latest(ctx)
	next := cacheEntry{CheckedAt: now, Latest: prev.Latest, URL: prev.URL}
	if err == nil {
		next.Latest, next.URL = rel.Version, rel.URL
	}
	c.write(next)
	return Status{Current: c.Current, Latest: next.Latest, URL: next.URL, CheckedAt: now}, err
}

// latest asks for the latest release, returning when Timeout passes even if the request has
// not given up yet.
func (c *Checker) latest(ctx context.Context) (Release, error) {
	ctx, cancel := context.WithTimeout(ctx, or(c.Timeout, CheckTimeout))
	defer cancel()
	type result struct {
		rel Release
		err error
	}
	done := make(chan result, 1)
	go func() {
		rel, err := c.Client.Latest(ctx)
		done <- result{rel, err}
	}()
	select {
	case r := <-done:
		return r.rel, r.err
	case <-ctx.Done():
		return Release{}, fmt.Errorf("checking for a newer release: %w", ctx.Err())
	}
}

func (c *Checker) read() cacheEntry {
	var e cacheEntry
	if c.CacheFile == "" {
		return e
	}
	b, err := os.ReadFile(c.CacheFile)
	if err != nil || json.Unmarshal(b, &e) != nil {
		return cacheEntry{}
	}
	return e
}

// write replaces the cache file in one rename, so that concurrent commands never read half of
// it. A cache that cannot be written only means asking again next time.
func (c *Checker) write(e cacheEntry) {
	if c.CacheFile == "" {
		return
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	dir := filepath.Dir(c.CacheFile)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	f, err := os.CreateTemp(dir, ".update-check-*")
	if err != nil {
		return
	}
	_, err = f.Write(b)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), c.CacheFile)
	}
	if err != nil {
		os.Remove(f.Name())
	}
}

// Notice is the one line telling a user of an install of kind that s.Latest is available.
func Notice(s Status, kind Install) string {
	return fmt.Sprintf("darkory %s is available (this is %s); update with: %s", s.Latest, s.Current, kind.UpdateCommand())
}

// PrintNotice prints Notice to w when a newer release exists, asking at most once a day and
// waiting about a second at most. It prints nothing for a dev build, when noCheck is set (the
// --no-update-check flag) or when DARKORY_NO_UPDATE_CHECK is set. CLI commands call it once
// their own output is done.
func PrintNotice(ctx context.Context, w io.Writer, noCheck bool) {
	if noCheck || Disabled(os.Getenv) || IsDevBuild(version.Version) {
		return
	}
	st, _ := NewChecker(version.Version).Check(ctx)
	if !st.Available() {
		return
	}
	exe, err := Executable()
	if err != nil {
		return
	}
	fmt.Fprintln(w, Notice(st, DetectInstall(exe, os.Getenv, FileExists)))
}
