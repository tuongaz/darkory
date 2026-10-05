package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	netmail "net/mail"
	"net/netip"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/mail"
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

// Email sign-in limits, per server process (decisions.md): each address may ask three times, then
// once every five minutes; each client address ten times, then once a minute. Sends in flight are
// bounded too; a request over any limit is answered like any other and sends nothing.
const (
	signInPerAddress      = 3
	signInPerAddressEvery = 5 * time.Minute
	signInPerClient       = 10
	signInPerClientEvery  = time.Minute
	signInInFlight        = 16
	signInSendTimeout     = time.Minute
)

// emailSignIn sends login links to Members who ask by email (ADR 0008).
type emailSignIn struct {
	mail mail.Sender
	// base is the public URL the links are built on; never the Host a request names.
	base      string
	proxyHops int
	byAddress *auth.Limiter
	byClient  *auth.Limiter
	inFlight  chan struct{}
}

func newEmailSignIn(o Options) *emailSignIn {
	if o.Mail == nil {
		return nil
	}
	if o.PublicURL == "" {
		// A link built on the request's Host would go wherever the requester says.
		o.Log.Error("email sign-in is off: emailed login links need the public URL (DARKORY_PUBLIC_URL)")
		return nil
	}
	return &emailSignIn{
		mail:      o.Mail,
		base:      strings.TrimRight(o.PublicURL, "/"),
		proxyHops: o.ProxyHops,
		byAddress: auth.NewLimiter(signInPerAddress, signInPerAddressEvery, o.Clock),
		byClient:  auth.NewLimiter(signInPerClient, signInPerClientEvery, o.Clock),
		inFlight:  make(chan struct{}, signInInFlight),
	}
}

// SignInModes lists how humans sign in to this Install, for the health reply: always the printed
// link, and the emailed link when email is set up.
func (s *Server) SignInModes() []string { return config.SignInModes(s.signIn != nil) }

// RequestEmailSignIn emails a login link when the address belongs to a Member. It answers 202
// whatever happens next — no Member, no email set up, a rate limit — and before any of it, so
// neither the reply nor its timing says which addresses belong to Members. Its Idempotency-Key is
// accepted and not stored: there is no Member to keep it under, and a repeat is rate limited.
func (s *Server) RequestEmailSignIn(w http.ResponseWriter, r *http.Request, _ gen.RequestEmailSignInParams) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, gen.ErrorCodeTooLarge, "the request body is over 4 KiB")
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		invalid(w, "send the body as Content-Type: application/json")
		return
	}
	var body gen.EmailSignInBody
	if err := json.Unmarshal(raw, &body); err != nil {
		invalid(w, "the body is not valid JSON for this operation: "+err.Error())
		return
	}
	addr, err := netmail.ParseAddress(string(body.Email))
	if err != nil || addr.Name != "" || addr.Address != strings.TrimSpace(string(body.Email)) || len(addr.Address) > 254 {
		invalid(w, "email is not an email address")
		return
	}
	if s.signIn != nil {
		s.signIn.request(s, r, addr.Address)
	}
	w.WriteHeader(http.StatusAccepted)
}

// request checks the limits and, within them, issues and sends the links in the background.
func (e *emailSignIn) request(s *Server, r *http.Request, address string) {
	client := clientAddress(r, e.proxyHops)
	// The client's limit comes first, so one client cycling through addresses is stopped before
	// it can fill the address limiter.
	if !e.byClient.Allow(client) {
		s.log.Warn("email sign-in: over the limit for a client address; sending nothing", "client", client)
		return
	}
	if !e.byAddress.Allow(strings.ToLower(address)) {
		s.log.Warn("email sign-in: over the limit for an address; sending nothing", "client", client)
		return
	}
	select {
	case e.inFlight <- struct{}{}:
	default:
		s.log.Warn("email sign-in: too many emails being sent; sending nothing", "client", client)
		return
	}
	go func() {
		defer func() { <-e.inFlight }()
		ctx, cancel := context.WithTimeout(context.Background(), signInSendTimeout)
		defer cancel()
		e.send(ctx, s, address)
	}()
}

func (e *emailSignIn) send(ctx context.Context, s *Server, address string) {
	links, err := s.core.EmailLoginLinks(ctx, address)
	if err != nil {
		s.log.Error("email sign-in: issuing login links", "err", err)
	}
	for _, l := range links {
		minutes := int(core.LoginLinkTTL.Minutes())
		m := mail.Message{
			To:      *l.Member.Email,
			Subject: "Sign in to Darkory",
			Text: fmt.Sprintf(`Someone asked to sign in to Darkory as %s, in %s, with this email address.

Open this link within %d minutes to sign in. It works once:

%s

If you did not ask, ignore this email: nobody can sign in without the link.
`, l.Member.Name, l.Organisation, minutes, LoginURL(e.base, l.Link.Code)),
		}
		if err := e.mail.Send(ctx, m); err != nil {
			s.log.Error("email sign-in: sending a login link", "member", l.Member.ID, "err", err)
			continue
		}
		s.log.Info("email sign-in: sent a login link", "member", l.Member.ID)
	}
}

// clientAddress is the address a request came from, for rate limits: the connection's, or, behind
// hops proxies that each append to X-Forwarded-For, the entry that many from its end. An IPv6
// address counts by its /64, which one client usually holds whole.
func clientAddress(r *http.Request, hops int) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if hops > 0 {
		var chain []string
		for _, h := range r.Header.Values("X-Forwarded-For") {
			for _, a := range strings.Split(h, ",") {
				if a = strings.TrimSpace(a); a != "" {
					chain = append(chain, a)
				}
			}
		}
		switch {
		case len(chain) >= hops:
			host = chain[len(chain)-hops]
		case len(chain) > 0:
			host = chain[0]
		}
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	if ip = ip.Unmap(); ip.Is6() {
		p, _ := ip.Prefix(64)
		return p.String()
	}
	return ip.String()
}
