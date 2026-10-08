package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	netmail "net/mail"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/server/gen"
)

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

// ShowLoginLink answers a login link opened in a browser with a page naming whom it signs in as,
// and a button that posts back to the same address to sign in. Opening the link changes nothing,
// so a page elsewhere that sends a browser here cannot sign it in as someone else, and a mail
// scanner that fetches the link does not use it up (security review L1).
func (s *Server) ShowLoginLink(w http.ResponseWriter, r *http.Request, code gen.LoginCode) {
	member, org, err := s.core.LoginLinkFor(r.Context(), code)
	var refusal *core.Error
	switch {
	case errors.As(err, &refusal) && refusal.Code == core.CodeNotFound:
		loginPage(w, http.StatusNotFound, loginPageData{})
	case err != nil:
		s.fail(w, r, err)
	default:
		loginPage(w, http.StatusOK, loginPageData{Member: member, Organisation: org, Minutes: int(core.LoginLinkTTL.Minutes())})
	}
}

// RedeemLoginLink signs a browser in from the sign-in page: it starts a browser Session, sets its
// cookie and sends the browser to the web app. Like a cookie write, it must come from the
// Install's own page. The Session of a cookie the browser already held is closed.
func (s *Server) RedeemLoginLink(w http.ResponseWriter, r *http.Request, code gen.LoginCode, _ gen.RedeemLoginLinkParams) {
	if !s.sameOrigin(r) {
		writeError(w, http.StatusForbidden, gen.ErrorCodeForbidden,
			"a login link signs in from this Install's own sign-in page: open the link in a browser")
		return
	}
	var old string
	if ck, err := r.Cookie(auth.CookieName); err == nil {
		old = ck.Value
	}
	bs, err := s.core.RedeemLoginLink(r.Context(), code, old)
	var refusal *core.Error
	if errors.As(err, &refusal) && refusal.Code == core.CodeNotFound && wantsHTML(r) {
		loginPage(w, http.StatusNotFound, loginPageData{})
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: bs.Cookie, Path: "/", MaxAge: int(s.browser.Lifetime / time.Second),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(s.baseURL(r), "https://"),
	})
	w.Header().Set("Location", "/")
	w.WriteHeader(http.StatusSeeOther)
}

// wantsHTML reports whether the request came from a browser page rather than a program.
func wantsHTML(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

func (s *Server) ListSessions(w http.ResponseWriter, r *http.Request, member gen.MemberRef, params gen.ListSessionsParams) {
	var limit int
	var cursor string
	if params.Limit != nil {
		limit = *params.Limit
	}
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	var state string
	if params.State != nil {
		state = string(*params.State)
	}
	p, err := s.core.ListSessions(r.Context(), caller(r), member, state, limit, cursor)
	s.respond(w, r, as(http.StatusOK, func(p core.SessionPage) any {
		return gen.SessionList{Items: each(p.Items, sessionOut), NextCursor: pageCursor(p.NextCursor), Open: p.Open, Ended: p.Ended}
	}), p, err)
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

// Email sign-in limits, per server process (decisions.md), checked in this order: each client
// address ten times, then once a minute, before the 202; then, in the background and only for an
// address that belongs to a Member, each Member three times, then once every five minutes; then
// at most MailPerHour emails an hour for all of them together. An address no Member has spends
// nothing but its client's token and one read. Lookups in flight are bounded too. A request over
// any limit is answered like any other and sends nothing, and each limit's warning is logged at
// most once a minute.
const (
	signInPerMember      = 3
	signInPerMemberEvery = 5 * time.Minute
	signInPerClient      = 10
	signInPerClientEvery = time.Minute
	signInInFlight       = 16
	signInSendTimeout    = time.Minute
	// DefaultMailPerHour is the cap on emails sent when Options.MailPerHour is zero.
	DefaultMailPerHour = 300
	warnEvery          = time.Minute
)

// emailSignIn sends login links to Members who ask by email (ADR 0008).
type emailSignIn struct {
	mail mail.Sender
	// base is the public URL the links are built on; never the Host a request names.
	base      string
	proxyHops int
	byClient  *auth.Limiter
	// byMember is keyed by Member id, so its keys are bounded by the Members there are.
	byMember *auth.Limiter
	// sent is one bucket for every email this process sends, so a flood spread over many
	// Members and clients cannot spend the SMTP account's reputation.
	sent     *auth.Limiter
	perHour  int
	inFlight chan struct{}
	clock    clock.Clock

	mu     sync.Mutex
	warned map[string]time.Time
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
	perHour := o.MailPerHour
	if perHour <= 0 {
		perHour = DefaultMailPerHour
	}
	return &emailSignIn{
		mail:      o.Mail,
		base:      strings.TrimRight(o.PublicURL, "/"),
		proxyHops: o.ProxyHops,
		byClient:  auth.NewLimiter(signInPerClient, signInPerClientEvery, o.Clock),
		byMember:  auth.NewLimiter(signInPerMember, signInPerMemberEvery, o.Clock),
		sent:      auth.NewLimiter(perHour, time.Hour/time.Duration(perHour), o.Clock),
		perHour:   perHour,
		inFlight:  make(chan struct{}, signInInFlight),
		clock:     o.Clock,
		warned:    map[string]time.Time{},
	}
}

// warn logs msg unless it was logged within the last minute, so a flood cannot flood the log.
func (e *emailSignIn) warn(s *Server, msg string, args ...any) {
	now := e.clock.Now()
	e.mu.Lock()
	last, ok := e.warned[msg]
	if ok && now.Sub(last) < warnEvery {
		e.mu.Unlock()
		return
	}
	e.warned[msg] = now
	e.mu.Unlock()
	s.log.Warn(msg, args...)
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
		readFailed(w, err, "4 KiB")
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

// request checks the client's limit and, within it, looks the address up and sends in the
// background, so nothing the reply or its timing shows depends on whether a Member has it.
func (e *emailSignIn) request(s *Server, r *http.Request, address string) {
	client := clientAddress(r, e.proxyHops)
	if !e.byClient.Allow(client) {
		e.warn(s, "email sign-in: a client address is over its limit; sending it nothing", "client", client)
		return
	}
	select {
	case e.inFlight <- struct{}{}:
	default:
		e.warn(s, "email sign-in: too many emails being sent; sending nothing", "client", client)
		return
	}
	go func() {
		defer func() { <-e.inFlight }()
		ctx, cancel := context.WithTimeout(context.Background(), signInSendTimeout)
		defer cancel()
		e.send(ctx, s, address)
	}()
}

// send emails a login link to each Member who has address, within each Member's limit and the
// cap on emails sent. An address no Member has creates no limiter key and takes no token, so a
// flood of made-up addresses cannot reset a Member's bucket or spend the cap.
func (e *emailSignIn) send(ctx context.Context, s *Server, address string) {
	found, err := s.core.MembersByEmail(ctx, address)
	if err != nil {
		s.log.Error("email sign-in: finding Members by email", "err", err)
		return
	}
	for _, f := range found {
		if !e.byMember.Allow(f.MemberID) {
			e.warn(s, "email sign-in: a Member is over their limit; sending them nothing", "member", f.MemberID)
			continue
		}
		// Taken before the link is issued, so a capped request writes nothing either.
		if !e.sent.Allow("") {
			e.warn(s, "email sign-in: this server has sent its cap of emails for the hour; sending nothing until it refills. "+
				"Printed links still work (DARKORY_SMTP_MAX_PER_HOUR)", "per_hour", e.perHour)
			return
		}
		l, err := s.core.IssueEmailLink(ctx, f)
		var refusal *core.Error
		if errors.As(err, &refusal) && refusal.Code == core.CodeConflict {
			s.log.Info("email sign-in: the Member was deactivated; sending nothing", "member", f.MemberID)
			continue
		}
		if err != nil {
			s.log.Error("email sign-in: issuing a login link", "member", f.MemberID, "err", err)
			continue
		}
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
// hops proxies that each append to X-Forwarded-For, the entry that many from its end. A chain
// shorter than hops did not come through every proxy, so its entries are the client's own words
// and the connection's address counts instead (security review L9). An IPv6 address counts by its
// /64, which one client usually holds whole.
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
		if len(chain) >= hops {
			host = chain[len(chain)-hops]
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
