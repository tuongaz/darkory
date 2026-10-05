package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server/gen"
)

// cookieAge is how long a browser keeps its Session cookie.
const cookieAge = 30 * 24 * time.Hour

// shownOnce is what a retry of a write that issued a secret gets back: the secret is never kept,
// so the first response cannot be repeated (decisions.md).
func shownOnce(what string) render {
	return func(any) (int, []byte, error) {
		b, err := json.Marshal(gen.Error{Code: gen.ErrorCodeConflict,
			Message: what + " was issued by the first request with this Idempotency-Key; its secret is shown only once"})
		return http.StatusConflict, b, err
	}
}

// baseURL is where browsers reach the Install: the configured public URL, or the address this
// request came to.
func (s *Server) baseURL(r *http.Request) string {
	if s.publicURL != "" {
		return strings.TrimRight(s.publicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// LoginURL is the URL of a login link with code, under base.
func LoginURL(base, code string) string {
	return strings.TrimRight(base, "/") + "/v1/login-links/" + code
}

func (s *Server) IssueLoginLink(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.IssueLoginLinkParams) {
	base := s.baseURL(r)
	out := as(http.StatusCreated, func(l core.LoginLink) any {
		return gen.LoginLink{URL: LoginURL(base, l.Code), ExpiresAt: l.ExpiresAt}
	})
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, shownOnce("The login link"))
	if !ok {
		return
	}
	l, err := s.core.IssueLoginLink(r.Context(), c, member, idem)
	s.respond(w, r, out, l, err)
}

// RedeemLoginLink signs a browser in: it starts a browser Session, sets its cookie and sends the
// browser to the web app.
func (s *Server) RedeemLoginLink(w http.ResponseWriter, r *http.Request, code gen.LoginCode) {
	bs, err := s.core.RedeemLoginLink(r.Context(), code)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: bs.Cookie, Path: "/", MaxAge: int(cookieAge / time.Second),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(s.baseURL(r), "https://"),
	})
	w.Header().Set("Location", "/")
	w.WriteHeader(http.StatusSeeOther)
}

func (s *Server) Logout(w http.ResponseWriter, r *http.Request, params gen.LogoutParams) {
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, noContent)
	if !ok {
		return
	}
	if err := s.core.Logout(r.Context(), c, idem); err != nil {
		s.fail(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) CloseSession(w http.ResponseWriter, r *http.Request, session gen.SessionID, params gen.CloseSessionParams) {
	out := as(http.StatusOK, func(cs core.ClosedSession) any {
		return gen.ClosedSession{Session: sessionOut(cs.Session), ClaimsEnded: cs.ClaimsEnded}
	})
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	cs, err := s.core.CloseSession(r.Context(), c, session, params.Member, idem)
	s.respond(w, r, out, cs, err)
}

func (s *Server) IssueToken(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.IssueTokenParams) {
	var body gen.IssueTokenBody
	out := as(http.StatusCreated, func(t core.IssuedToken) any {
		return gen.IssuedToken{Token: tokenOut(t.Token), Secret: t.Secret}
	})
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, &body, shownOnce("The token"))
	if !ok {
		return
	}
	var timeout time.Duration
	if body.DefaultHeartbeatTimeoutSeconds != nil {
		n := *body.DefaultHeartbeatTimeoutSeconds
		if n < 1 || n > 86400 {
			invalid(w, "default_heartbeat_timeout_seconds is 1 to 86400")
			return
		}
		timeout = time.Duration(n) * time.Second
	}
	t, err := s.core.IssueToken(r.Context(), c, member, body.Name, timeout, idem)
	s.respond(w, r, out, t, err)
}

func (s *Server) ListTokens(w http.ResponseWriter, r *http.Request, member gen.MemberRef) {
	ts, err := s.core.ListTokens(r.Context(), caller(r), member)
	s.respond(w, r, as(http.StatusOK, func(ts []core.Token) any { return gen.TokenList{Items: each(ts, tokenOut)} }), ts, err)
}

func (s *Server) RevokeToken(w http.ResponseWriter, r *http.Request, token gen.TokenID, params gen.RevokeTokenParams) {
	out := as(http.StatusOK, func(t core.Token) any { return tokenOut(t) })
	c, idem, ok := s.begin(w, r, params.IdempotencyKey, nil, out)
	if !ok {
		return
	}
	t, err := s.core.RevokeToken(r.Context(), c, token, idem)
	s.respond(w, r, out, t, err)
}
