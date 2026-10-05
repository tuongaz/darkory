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

// Authenticator finds the Caller of a request.
type Authenticator struct {
	store *store.Store
	clock clock.Clock
}

// New returns an Authenticator over st.
func New(st *store.Store, c clock.Clock) *Authenticator {
	return &Authenticator{store: st, clock: c}
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

// touchEvery limits how often last-seen and last-used times are written.
const touchEvery = time.Minute

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
WHERE t.secret_hash = $1 AND t.revoked_at IS NULL`, Hash(cr.Bearer)).
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
	if !validSessionID(cr.Session) {
		return nil, ErrSessionRequired
	}
	c.ChosenID = cr.Session
	now := a.clock.Now()
	if !lastUsed.Valid || now.Sub(time.UnixMilli(lastUsed.Int64)) >= touchEvery {
		if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL:  `UPDATE tokens SET last_used_at = $1 WHERE id = $2`,
			Args: []any{now.UnixMilli(), c.TokenID},
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
func (a *Authenticator) session(ctx context.Context, c *Caller, now time.Time) error {
	for range 2 {
		var tokenID sql.NullString
		var lastSeen int64
		err := a.store.QueryRow(ctx, `SELECT id, token_id, last_seen_at FROM sessions
WHERE org_id = $1 AND member_id = $2 AND chosen_id = $3 AND closed_at IS NULL`, c.OrgID, c.MemberID, c.ChosenID).
			Scan(&c.SessionID, &tokenID, &lastSeen)
		switch {
		case err == nil:
			if tokenID.String != c.TokenID {
				// Revoking a token ends the Claims of its Sessions, so one Session never mixes tokens.
				return fmt.Errorf("%w: Session %q is open with another token; choose another id", ErrSessionRequired, c.ChosenID)
			}
			if now.Sub(time.UnixMilli(lastSeen)) >= touchEvery {
				return a.store.WriteBatchNoSeq(ctx, store.Stmt{
					SQL:  `UPDATE sessions SET last_seen_at = $1 WHERE id = $2`,
					Args: []any{now.UnixMilli(), c.SessionID},
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

func (a *Authenticator) cookie(ctx context.Context, cookie string) (*Caller, error) {
	var c Caller
	var lastSeen int64
	err := a.store.QueryRow(ctx, `SELECT s.id, s.chosen_id, s.org_id, s.member_id, s.last_seen_at, m.name, m.admin
FROM sessions s JOIN members m ON m.id = s.member_id
WHERE s.cookie_hash = $1 AND s.kind = 'browser' AND s.closed_at IS NULL`, Hash(cookie)).
		Scan(&c.SessionID, &c.ChosenID, &c.OrgID, &c.MemberID, &lastSeen, &c.Name, &c.Admin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, fmt.Errorf("auth: cookie: %w", err)
	}
	if now := a.clock.Now(); now.Sub(time.UnixMilli(lastSeen)) >= touchEvery {
		if err := a.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL:  `UPDATE sessions SET last_seen_at = $1 WHERE id = $2`,
			Args: []any{now.UnixMilli(), c.SessionID},
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
