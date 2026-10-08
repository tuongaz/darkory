// Package auth turns a request's credential into the Member and Session making it (ADR 0008):
// a `dk_` bearer token with the Session id the running copy chose, or the cookie of a browser
// Session started by a one-time login link. A request with no credential is never a Member.
//
// Secrets — tokens, login-link codes and cookies — are random, shown once, and stored only as
// their SHA-256.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/store"
)

// TokenPrefix starts every token secret.
const TokenPrefix = "dk_"

// CookieName is the browser Session's cookie.
const CookieName = "darkory_session"

// SessionHeader carries the Session id with a bearer token.
const SessionHeader = "Darkory-Session"

var (
	// ErrUnauthenticated: no credential, or one that is unknown, revoked or closed.
	ErrUnauthenticated = errors.New("auth: no valid credential")
	// ErrSessionRequired: a bearer token without a usable Darkory-Session.
	ErrSessionRequired = errors.New("auth: a bearer token needs a Darkory-Session")
)

// Caller is the Member making a request, and the Session they make it through.
type Caller struct {
	OrgID    string
	MemberID string
	Name     string
	Admin    bool
	// SessionID is the Session's row id; ChosenID is the id the running copy chose (for a
	// browser Session, the server chose it).
	SessionID string
	ChosenID  string
	// TokenID is the token presented; empty for a browser Session.
	TokenID string
	// DefaultTimeout is the token's default heartbeat timeout; zero when it has none.
	DefaultTimeout time.Duration
}

// NewSecret returns a random secret starting with prefix, and its hash.
func NewSecret(prefix string) (secret, hash string) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	secret = prefix + base64.RawURLEncoding.EncodeToString(b[:])
	return secret, Hash(secret)
}

// Hash is how a secret is stored: SHA-256, hex.
func Hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// SessionLimits bound how long a Session lasts on the server without being closed. A browser
// Session (security review M4) expires once unused for Idle, and at the latest Lifetime after it
// started. A token Session ends once no request has come through it for TokenIdle, unless a Claim
// bound to it is still live: the copy that chose its id has stopped, or crashed, without closing
// it.
type SessionLimits struct {
	Idle, Lifetime time.Duration
	TokenIdle      time.Duration
}

// DefaultTokenIdle is three times the Runner's Heartbeat timeout (5 minutes). Every Session the
// Runner uses makes a request at least every minute — a waiting `next` is at most 60 s, a
// Heartbeat every 30 s, an Activity stream's keep-alive every 15 s — so only a Session nothing
// uses any more stays quiet that long, and a Claim it could have held without Heartbeats would
// have lapsed three times over.
const DefaultTokenIdle = 15 * time.Minute

// DefaultSessionLimits are the limits unless the Install sets others.
var DefaultSessionLimits = SessionLimits{Idle: 30 * 24 * time.Hour, Lifetime: 90 * 24 * time.Hour, TokenIdle: DefaultTokenIdle}

// liveTokenSQL is the condition, over a token Session named by %[1]s, that it is still in use: it
// was seen within the idle limit, or a Claim bound to it is live.
const liveTokenSQL = `(%[1]s.last_seen_at > @token_idle_since OR EXISTS (SELECT 1 FROM tasks lt WHERE lt.claim_session_id = %[1]s.id AND lt.claim_expires_at > @now))`

// LiveSessionSQL is the one condition, over a Session aliased s, that it has not ended on its own:
// a browser Session has not expired, a token Session has not gone idle. It binds the names Args
// gives.
var LiveSessionSQL = `((s.kind = 'browser' AND s.last_seen_at > @idle_since AND s.created_at > @started_since) OR (s.kind = 'token' AND ` +
	fmt.Sprintf(liveTokenSQL, "s") + `))`

// IdleTokenSQL is the condition, over an open row of the sessions table named in full, that it is
// a token Session gone idle: what the sweep closes.
var IdleTokenSQL = `sessions.kind = 'token' AND NOT ` + fmt.Sprintf(liveTokenSQL, "sessions")

// Args binds LiveSessionSQL and IdleTokenSQL at now.
func (l SessionLimits) Args(now time.Time) map[string]any {
	return map[string]any{"idle_since": now.Add(-l.Idle).UnixMilli(), "started_since": now.Add(-l.Lifetime).UnixMilli(),
		"token_idle_since": now.Add(-l.TokenIdle).UnixMilli(), "now": now.UnixMilli()}
}

// ExpiresAt is when a browser Session that started and was last seen at these times expires.
func (l SessionLimits) ExpiresAt(started, lastSeen time.Time) time.Time {
	idle, end := lastSeen.Add(l.Idle), started.Add(l.Lifetime)
	if idle.Before(end) {
		return idle
	}
	return end
}

// Authenticator finds the Caller of a request.
type Authenticator struct {
	store  *store.Store
	clock  clock.Clock
	limits SessionLimits
}

// New returns an Authenticator over st, with DefaultSessionLimits.
func New(st *store.Store, c clock.Clock) *Authenticator {
	return &Authenticator{store: st, clock: c, limits: DefaultSessionLimits}
}

// WithSessionLimits sets how long Sessions last without being closed, and returns a.
func (a *Authenticator) WithSessionLimits(l SessionLimits) *Authenticator {
	a.limits = l
	return a
}

// Credentials are what a request presented.
type Credentials struct {
	// Bearer is the token from `Authorization: Bearer …`; empty when absent.
	Bearer string
	// Session is the Darkory-Session header.
	Session string
	// Cookie is the darkory_session cookie's value.
	Cookie string
}

// TouchEvery limits how often last-seen and last-used times are written.
const TouchEvery = time.Minute

// MaxSessionIDLength bounds a chosen Session id.
const MaxSessionIDLength = 200

// Authenticate returns the Caller the credentials name. A bearer token wins over a cookie. The
// Session of a token is created the first time its id is seen.
func (a *Authenticator) Authenticate(ctx context.Context, cr Credentials) (*Caller, error) {
	switch {
	case cr.Bearer != "":
		return a.bearer(ctx, cr)
	case cr.Cookie != "":
		return a.cookie(ctx, cr.Cookie)
	}
	return nil, ErrUnauthenticated
}

func (a *Authenticator) bearer(ctx context.Context, cr Credentials) (*Caller, error) {
	if !strings.HasPrefix(cr.Bearer, TokenPrefix) {
		return nil, ErrUnauthenticated
	}
	var c Caller
	var timeout, lastUsed sql.NullInt64
	err := a.store.QueryRow(ctx, `SELECT t.id, t.org_id, t.member_id, t.default_heartbeat_timeout_ms, t.last_used_at, m.name, m.admin
FROM tokens t JOIN members m ON m.id = t.member_id
WHERE t.secret_hash = $1 AND t.revoked_at IS NULL AND m.deactivated_at IS NULL`, Hash(cr.Bearer)).
		Scan(&c.TokenID, &c.OrgID, &c.MemberID, &timeout, &lastUsed, &c.Name, &c.Admin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, fmt.Errorf("auth: token: %w", err)
	}
	if timeout.Valid {
		c.DefaultTimeout = time.Duration(timeout.Int64) * time.Millisecond
	}
	if cr.Session == "" {
		return nil, ErrSessionRequired
	}
	if !validSessionID(cr.Session) {
		// Present but unusable: say why, rather than that the header is missing.
		return nil, fmt.Errorf("%w: a Session id is 1 to %d printable characters with no spaces", ErrSessionRequired, MaxSessionIDLength)
	}
	c.ChosenID = cr.Session
	now := a.clock.Now()
	if !lastUsed.Valid || now.Sub(time.UnixMilli(lastUsed.Int64)) >= TouchEvery {
		if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL:  `UPDATE tokens SET last_used_at = $1 WHERE org_id = $2 AND id = $3`,
			Args: []any{now.UnixMilli(), c.OrgID, c.TokenID},
		}); err != nil {
			return nil, fmt.Errorf("auth: touch token: %w", err)
		}
	}
	if err := a.session(ctx, &c, now); err != nil {
		return nil, err
	}
	return &c, nil
}

// session finds the open Session of the Member with the chosen id, or starts it. Starting a
// Session records no Activity: it is presence, not a change to the work record, like a Heartbeat.
// An open Session that has gone idle has ended, though the sweep may not have closed it yet: it is
// closed here, as the sweep would, and the request starts a new one with the same id.
func (a *Authenticator) session(ctx context.Context, c *Caller, now time.Time) error {
	args := a.limits.Args(now)
	args["org"], args["member"], args["chosen"] = c.OrgID, c.MemberID, c.ChosenID
	q, qa := store.Bind(`SELECT s.id, s.token_id, s.last_seen_at, CASE WHEN `+LiveSessionSQL+` THEN 1 ELSE 0 END FROM sessions s
WHERE s.org_id = @org AND s.member_id = @member AND s.chosen_id = @chosen AND s.closed_at IS NULL`, args)
	for range 3 {
		var tokenID sql.NullString
		var lastSeen int64
		var live int
		err := a.store.QueryRow(ctx, q, qa...).Scan(&c.SessionID, &tokenID, &lastSeen, &live)
		switch {
		case err == nil && live == 0:
			if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
				SQL:  `UPDATE sessions SET closed_at = $1 WHERE org_id = $2 AND id = $3 AND closed_at IS NULL`,
				Args: []any{now.UnixMilli(), c.OrgID, c.SessionID},
			}); err != nil {
				return fmt.Errorf("auth: close idle session: %w", err)
			}
			c.SessionID = ""
			continue
		case err == nil:
			if tokenID.String != c.TokenID {
				// Revoking a token ends the Claims of its Sessions, so one Session never mixes tokens.
				return fmt.Errorf("%w: Session %q is open with another token; choose another id", ErrSessionRequired, c.ChosenID)
			}
			if now.Sub(time.UnixMilli(lastSeen)) >= TouchEvery {
				return a.store.WriteBatchNoSeq(ctx, store.Stmt{
					SQL:  `UPDATE sessions SET last_seen_at = $1 WHERE org_id = $2 AND id = $3`,
					Args: []any{now.UnixMilli(), c.OrgID, c.SessionID},
				})
			}
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return fmt.Errorf("auth: session: %w", err)
		}
		// Two first requests of one Session may race; the loser finds the winner's row.
		if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL: `INSERT INTO sessions (id, org_id, member_id, chosen_id, kind, token_id, created_at, last_seen_at)
VALUES ($1, $2, $3, $4, 'token', $5, $6, $6) ON CONFLICT DO NOTHING`,
			Args: []any{store.NewID(), c.OrgID, c.MemberID, c.ChosenID, c.TokenID, now.UnixMilli()},
		}); err != nil {
			return fmt.Errorf("auth: start session: %w", err)
		}
	}
	return fmt.Errorf("auth: session %q could not be started", c.ChosenID)
}

// cookie finds the browser Session a cookie maps to, while it is open, has not expired, and its
// Member is active.
func (a *Authenticator) cookie(ctx context.Context, cookie string) (*Caller, error) {
	var c Caller
	var lastSeen int64
	now := a.clock.Now()
	args := a.limits.Args(now)
	args["hash"] = Hash(cookie)
	q, qa := store.Bind(`SELECT s.id, s.chosen_id, s.org_id, s.member_id, s.last_seen_at, m.name, m.admin
FROM sessions s JOIN members m ON m.id = s.member_id
WHERE s.cookie_hash = @hash AND s.kind = 'browser' AND s.closed_at IS NULL AND m.deactivated_at IS NULL AND `+LiveSessionSQL, args)
	err := a.store.QueryRow(ctx, q, qa...).Scan(&c.SessionID, &c.ChosenID, &c.OrgID, &c.MemberID, &lastSeen, &c.Name, &c.Admin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, fmt.Errorf("auth: cookie: %w", err)
	}
	if now.Sub(time.UnixMilli(lastSeen)) >= TouchEvery {
		if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL:  `UPDATE sessions SET last_seen_at = $1 WHERE org_id = $2 AND id = $3`,
			Args: []any{now.UnixMilli(), c.OrgID, c.SessionID},
		}); err != nil {
			return nil, fmt.Errorf("auth: touch session: %w", err)
		}
	}
	return &c, nil
}

func validSessionID(id string) bool {
	if id == "" || len(id) > MaxSessionIDLength {
		return false
	}
	for _, r := range id {
		if !unicode.IsPrint(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
