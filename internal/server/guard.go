package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/server/gen"
)

// Security headers on every response (security review M3). No page of the Install may be framed,
// so a page elsewhere cannot lay a decoy over its buttons; nothing is sniffed; and the address of
// a page, which may hold a login code, never goes to another origin. Referrer-Policy is
// same-origin rather than no-referrer: under no-referrer a browser sends `Origin: null` on its
// own same-origin writes, which the cookie-write check refuses (decisions.md).
const (
	// appCSP lets the web app load only its own scripts, styles and data; it has no inline script
	// or style.
	appCSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
		"font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	// apiCSP is for /v1, which answers JSON and nothing a browser should render.
	apiCSP = "default-src 'none'; frame-ancestors 'none'"
)

// DefaultBodyReadTimeout bounds how long a request body may take to arrive, unless
// Options.BodyReadTimeout says otherwise (security review M2).
const DefaultBodyReadTimeout = 30 * time.Second

// evidenceMinRate is the slowest an Evidence upload may arrive, in bytes a second, on top of the
// body read timeout: 100 MiB has about 27 minutes.
const evidenceMinRate = 64 << 10

// maxIdempotencyKey bounds an Idempotency-Key, as api/openapi.yaml says.
const maxIdempotencyKey = 255

// guard wraps every route: it sets the security headers, bounds how long a request body may take
// to arrive, and refuses a malformed Idempotency-Key before any operation sees it.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
			h.Set("Content-Security-Policy", apiCSP)
		} else {
			h.Set("Content-Security-Policy", appCSP)
		}
		if r.ContentLength != 0 {
			s.bodyDeadline(w, s.bodyTimeout)
		}
		if k := r.Header.Values("Idempotency-Key"); len(k) > 0 && (len(k) > 1 || !validIdempotencyKey(k[0])) {
			invalid(w, "Idempotency-Key is 1 to 255 printable ASCII characters, without spaces")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bodyDeadline gives the request's body until d from now to arrive. net/http lifts the deadline
// itself once the body has been read to its end, before it starts the read it keeps on the
// connection while the handler runs, so a long request with a small body (a waiting `next`) is
// not cut off; TestLongRequestsOutliveTheBodyTimeout holds it to that. A request with no body
// sets none, which keeps the Activity stream open. A body left unread — a request refused before
// its handler reads it — is drained by net/http under the deadline, so it cannot hold the
// connection either.
func (s *Server) bodyDeadline(w http.ResponseWriter, d time.Duration) {
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(d))
}

// readFailed answers a request whose body could not be read: over its limit, or too slow.
func readFailed(w http.ResponseWriter, err error, limit string) {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, "the request body is over "+limit)
		return
	}
	invalid(w, "the request body did not arrive in time")
}

func validIdempotencyKey(k string) bool {
	if k == "" || len(k) > maxIdempotencyKey {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < 0x21 || k[i] > 0x7e {
			return false
		}
	}
	return true
}
