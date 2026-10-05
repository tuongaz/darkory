package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
)

type callerKey struct{}

// public lists the operations that need no credential (plan invariant 8), by path.
func public(r *http.Request) bool {
	p := r.URL.Path
	return p == "/v1/health" || p == "/v1/sign-in/email" || strings.HasPrefix(p, "/v1/login-links/")
}

// authenticate makes every operation but the public ones need a credential: a bearer token with
// a Darkory-Session, or the browser cookie. A request with none is never a Member, whichever
// address it comes from (ADR 0008).
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if public(r) {
			next.ServeHTTP(w, r)
			return
		}
		var cr auth.Credentials
		if h := r.Header.Get("Authorization"); h != "" {
			scheme, token, _ := strings.Cut(h, " ")
			if !strings.EqualFold(scheme, "Bearer") || token == "" {
				writeError(w, http.StatusUnauthorized, gen.ErrorCodeUnauthenticated, "Authorization takes a bearer token")
				return
			}
			cr.Bearer = strings.TrimSpace(token)
			cr.Session = r.Header.Get(auth.SessionHeader)
		} else if ck, err := r.Cookie(auth.CookieName); err == nil {
			cr.Cookie = ck.Value
		}
		c, err := s.auth.Authenticate(r.Context(), cr)
		switch {
		case errors.Is(err, auth.ErrSessionRequired):
			msg := "a bearer request names its Session in the Darkory-Session header"
			if err != auth.ErrSessionRequired {
				msg = strings.TrimPrefix(err.Error(), auth.ErrSessionRequired.Error()+": ")
			}
			writeError(w, http.StatusUnauthorized, gen.ErrorCodeSessionRequired, msg)
			return
		case errors.Is(err, auth.ErrUnauthenticated):
			writeError(w, http.StatusUnauthorized, gen.ErrorCodeUnauthenticated, "this request carries no valid credential")
			return
		case err != nil:
			s.fail(w, r, err)
			return
		}
		if cr.Bearer == "" && !s.sameOrigin(r) {
			writeError(w, http.StatusForbidden, gen.ErrorCodeForbidden,
				"a write signed in by the browser cookie must come from this Install's own pages")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, c)))
	})
}

// sameOrigin reports whether a request signed in by the cookie may proceed: a safe method, or a
// write a page of this Install sent. A browser attaches the cookie to a form a page on another
// origin posts here, and SameSite=Lax does not stop one from a sibling port on the same host, so
// a write needs Sec-Fetch-Site, when sent, to say same-origin, and its Origin — or its Referer
// when the browser sent no Origin — to be this Install's. Bearer requests carry no ambient
// credential and skip this.
func (s *Server) sameOrigin(r *http.Request) bool {
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
	default:
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		ref, err := url.Parse(r.Header.Get("Referer"))
		if err != nil || ref.Scheme == "" || ref.Host == "" {
			return false
		}
		origin = ref.Scheme + "://" + ref.Host
	}
	got := normalOrigin(origin)
	if got == "" {
		return false
	}
	self := "http://" + r.Host
	if r.TLS != nil {
		self = "https://" + r.Host
	}
	return got == normalOrigin(self) || (s.publicURL != "" && got == normalOrigin(s.publicURL))
}

// normalOrigin reduces a URL to its scheme and host, lower-cased and without a default port; ""
// when it has none (as the Origin "null" has none).
func normalOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	scheme, host := strings.ToLower(u.Scheme), strings.ToLower(u.Host)
	if (scheme == "http" && strings.HasSuffix(host, ":80")) || (scheme == "https" && strings.HasSuffix(host, ":443")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return scheme + "://" + host
}

func caller(r *http.Request) *auth.Caller {
	return r.Context().Value(callerKey{}).(*auth.Caller)
}

// render turns an operation's result into its response body.
type render func(result any) (status int, body []byte, err error)

// as renders a result of type T, converted by conv, with status.
func as[T any](status int, conv func(T) any) render {
	return func(v any) (int, []byte, error) {
		b, err := json.Marshal(conv(v.(T)))
		return status, b, err
	}
}

// noContent renders the empty reply of a write that returns nothing.
func noContent(any) (int, []byte, error) { return http.StatusNoContent, nil, nil }

// maxBody bounds a JSON request body.
const maxBody = 1 << 20

// begin starts a write: it reads and decodes the body into body (when the request has one), and
// sets up the Idempotency-Key — a retry is answered here with the first response. The request is
// identified by its method, path and body.
func (s *Server) begin(w http.ResponseWriter, r *http.Request, key *string, body any, out render) (*auth.Caller, core.Idem, bool) {
	c := caller(r)
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, "the request body is over 1 MiB")
		return nil, core.Idem{}, false
	}
	if body != nil && len(strings.TrimSpace(string(raw))) > 0 {
		// Only JSON: a form a browser can post across origins without asking cannot be one.
		if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
			writeError(w, http.StatusBadRequest, gen.ErrorCodeInvalid, "send the body as Content-Type: application/json")
			return nil, core.Idem{}, false
		}
		if err := json.Unmarshal(raw, body); err != nil {
			writeError(w, http.StatusBadRequest, gen.ErrorCodeInvalid, "the body is not valid JSON for this operation: "+err.Error())
			return nil, core.Idem{}, false
		}
	}
	idem := core.Idem{Render: out}
	if key != nil {
		sum := sha256.Sum256([]byte(r.Method + " " + r.URL.RequestURI() + "\n" + string(raw)))
		idem.Key, idem.Hash = *key, hex.EncodeToString(sum[:])
		if err := s.core.Lookup(r.Context(), c, idem); err != nil {
			s.fail(w, r, err)
			return nil, core.Idem{}, false
		}
	}
	return c, idem, true
}

// respond answers a write or read with its result, or with why it failed.
func (s *Server) respond(w http.ResponseWriter, r *http.Request, out render, result any, err error) {
	if err != nil {
		s.fail(w, r, err)
		return
	}
	status, body, err := out(result)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeRaw(w, status, body)
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	if status == http.StatusNoContent || len(body) == 0 {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
	if body[len(body)-1] != '\n' {
		_, _ = w.Write([]byte("\n"))
	}
}

// statusOf is the HTTP status each Error code takes (decisions.md).
var statusOf = map[core.Code]int{
	core.CodeInvalid:              http.StatusBadRequest,
	core.CodeUnauthenticated:      http.StatusUnauthorized,
	core.CodeSessionRequired:      http.StatusUnauthorized,
	core.CodeForbidden:            http.StatusForbidden,
	core.CodeNotFound:             http.StatusNotFound,
	core.CodeConflict:             http.StatusConflict,
	core.CodeAlreadyClaimed:       http.StatusConflict,
	core.CodeNotTakeable:          http.StatusConflict,
	core.CodeNotHolder:            http.StatusConflict,
	core.CodeEnded:                http.StatusConflict,
	core.CodeCycle:                http.StatusConflict,
	core.CodeTasksOpen:            http.StatusConflict,
	core.CodeProposalStale:        http.StatusConflict,
	core.CodeTooLarge:             http.StatusRequestEntityTooLarge,
	core.CodeIdempotencyKeyReused: http.StatusUnprocessableEntity,
	core.CodeNotImplemented:       http.StatusNotImplemented,
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var replay *core.Replay
	var refusal *core.Error
	switch {
	case errors.As(err, &replay):
		writeRaw(w, replay.Status, replay.Body)
	case errors.As(err, &refusal):
		status, ok := statusOf[refusal.Code]
		if !ok {
			status = http.StatusConflict
		}
		writeError(w, status, gen.ErrorCode(refusal.Code), refusal.Message)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, gen.ErrorCodeNotFound, err.Error())
	case errors.Is(err, context.Canceled):
		// The client went away; nobody reads the reply.
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, gen.ErrorCodeInternal, "the server could not complete the request")
	}
}

// invalid answers a request the server refuses before doing anything.
func invalid(w http.ResponseWriter, message string) {
	writeError(w, http.StatusBadRequest, gen.ErrorCodeInvalid, message)
}
