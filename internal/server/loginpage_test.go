package server

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// The sign-in page is the web app's sign-in card (mock F-D8b): light only, whatever the system's
// theme, the Darkory wordmark over one card, one primary button. Its one style is the one the CSP
// allows by hash, and it loads no font: the CSP allows none.
func TestLoginPageIsTheLightSignInCard(t *testing.T) {
	for _, tc := range []struct {
		name   string
		data   loginPageData
		status int
		want   []string
	}{
		{"a link", loginPageData{Member: "tuongaz", Organisation: "Acme Software", Minutes: 15}, http.StatusOK, []string{
			`<h1>Sign in to Darkory</h1>`,
			`signs this browser in as <strong>tuongaz</strong>, in Acme Software.`,
			`<form method="post"><button type="submit">Sign in as tuongaz</button></form>`,
			`for 15 minutes from when it was made`,
		}},
		{"a used link", loginPageData{}, http.StatusNotFound, []string{`<h1>This login link does not work</h1>`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			loginPage(rec, tc.status, tc.data)
			page := rec.Body.String()
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d", rec.Code, tc.status)
			}
			for _, want := range append([]string{
				`<meta name="color-scheme" content="light">`,
				`<div class="brand">Darkory</div>`,
				`<div class="card">`,
			}, tc.want...) {
				if !strings.Contains(page, want) {
					t.Errorf("the page lacks %q:\n%s", want, page)
				}
			}
			if strings.Contains(page, "light dark") || strings.Contains(page, "prefers-color-scheme") {
				t.Errorf("the page follows a dark system theme:\n%s", page)
			}

			style := regexp.MustCompile(`(?s)<style>(.*?)</style>`).FindAllStringSubmatch(page, -1)
			if len(style) != 1 {
				t.Fatalf("want one style element, got %d", len(style))
			}
			sum := sha256.Sum256([]byte(style[0][1]))
			if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'") {
				t.Errorf("the CSP %q does not allow the page's style", csp)
			}
			for _, want := range []string{"color-scheme:light", "background:oklch(.985 0 0)", "max-width:552px", "height:32px", "13px/1.45 Inter,"} {
				if !strings.Contains(style[0][1], want) {
					t.Errorf("the style lacks %q", want)
				}
			}
			if strings.Contains(style[0][1], "@font-face") || strings.Contains(style[0][1], "url(") {
				t.Errorf("the style loads something the CSP refuses: %s", style[0][1])
			}
		})
	}
}
