// Package update finds newer Darkory releases and replaces an install-script binary with one,
// after checking the release's signature and checksum (ADR 0009). Local never updates itself:
// Homebrew and container users update with their own tools, and the update notice only says
// that a newer release exists.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Where releases are published, and the asset names .goreleaser.yaml gives them.
const (
	DefaultAPI     = "https://api.github.com"
	Repo           = "tuongaz/darkory"
	ChecksumsAsset = "checksums.txt"
	SignatureAsset = "checksums.txt.sig"
)

// ArchiveName is the release archive holding the binary for a platform, as the archive
// name_template in .goreleaser.yaml writes it: darkory_1.2.3_linux_amd64.tar.gz, or .zip on
// Windows.
func ArchiveName(version, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return "darkory_" + strings.TrimPrefix(version, "v") + "_" + goos + "_" + goarch + ext
}

// ErrNoRelease is returned when the release asked for does not exist.
var ErrNoRelease = errors.New("no such release")

// Release is a published release.
type Release struct {
	// Version is the release's tag, such as v1.2.3.
	Version string
	// URL is the release page.
	URL string
	// Assets maps each asset's name to its download URL.
	Assets map[string]string
}

// Client looks releases up through the GitHub releases API.
type Client struct {
	// BaseURL is the API's base URL; empty means DefaultAPI.
	BaseURL string
	// Repo is owner/name; empty means Repo.
	Repo string
	// HTTP makes the requests; nil means a client with a five-minute timeout.
	HTTP *http.Client
	// UserAgent is sent with every request.
	UserAgent string
}

var defaultHTTP = &http.Client{Timeout: 5 * time.Minute}

// Latest returns the newest release that is neither a draft nor a prerelease.
func (c *Client) Latest(ctx context.Context) (Release, error) {
	return c.lookup(ctx, "releases/latest")
}

// Release returns the release tagged version (v1.2.3, or 1.2.3).
func (c *Client) Release(ctx context.Context, version string) (Release, error) {
	return c.lookup(ctx, "releases/tags/"+url.PathEscape(canonical(version)))
}

func (c *Client) lookup(ctx context.Context, path string) (Release, error) {
	base := strings.TrimSuffix(or(c.BaseURL, DefaultAPI), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/repos/"+or(c.Repo, Repo)+"/"+path, nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := c.do(req)
	if err != nil {
		return Release{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Release{}, ErrNoRelease
	}
	if resp.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("looking up the release: %s", resp.Status)
	}
	var body struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return Release{}, fmt.Errorf("reading the release: %w", err)
	}
	if body.TagName == "" {
		return Release{}, errors.New("reading the release: no tag_name")
	}
	rel := Release{Version: body.TagName, URL: body.HTMLURL, Assets: make(map[string]string, len(body.Assets))}
	for _, a := range body.Assets {
		rel.Assets[a.Name] = a.URL
	}
	return rel, nil
}

// download fetches url, refusing a body longer than limit bytes.
func (c *Client) download(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading %s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", url, err)
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("downloading %s: larger than %d bytes", url, limit)
	}
	return b, nil
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	hc := c.HTTP
	if hc == nil {
		hc = defaultHTTP
	}
	return hc.Do(req)
}

func or[T comparable](v, fallback T) T {
	var zero T
	if v != zero {
		return v
	}
	return fallback
}
