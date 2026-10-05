package core

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/store"
)

const tokenCols = `id, member_id, name, prefix, default_heartbeat_timeout_ms, created_at, last_used_at, revoked_at`

func scanToken(row interface{ Scan(...any) error }) (Token, error) {
	var t Token
	var timeout, lastUsed, revoked sql.NullInt64
	var created int64
	err := row.Scan(&t.ID, &t.MemberID, &t.Name, &t.Prefix, &timeout, &created, &lastUsed, &revoked)
	if timeout.Valid {
		t.DefaultTimeout = time.Duration(timeout.Int64) * time.Millisecond
	}
	t.CreatedAt, t.LastUsedAt, t.RevokedAt = fromMS(created), nullTime(lastUsed), nullTime(revoked)
	return t, err
}

// IssueToken issues a named token for a Member (admin). Its secret is in the reply only.
func (s *Service) IssueToken(ctx context.Context, c *auth.Caller, memberRef, name string, defaultTimeout time.Duration, idem Idem) (IssuedToken, error) {
	if err := mustAdmin(c); err != nil {
		return IssuedToken{}, err
	}
	if strings.TrimSpace(name) == "" || len(name) > 100 {
		return IssuedToken{}, refuse(CodeInvalid, "a token name is 1 to 100 characters")
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		if err := mustBeActive(t, member); err != nil {
			return nil, err
		}
		return issueToken(t, member, name, defaultTimeout)
	})
	if err != nil {
		return IssuedToken{}, err
	}
	return res.(IssuedToken), nil
}

func issueToken(t *tx, memberID, name string, defaultTimeout time.Duration) (IssuedToken, error) {
	var n int
	if err := t.QueryRow(t.ctx, `SELECT COUNT(*) FROM tokens WHERE org_id = $1 AND member_id = $2 AND name = $3 AND revoked_at IS NULL`,
		t.caller.OrgID, memberID, name).Scan(&n); err != nil {
		return IssuedToken{}, err
	}
	if n > 0 {
		return IssuedToken{}, refuse(CodeConflict, "the Member already has a live token named %q", name)
	}
	secret, hash := auth.NewSecret(auth.TokenPrefix)
	id := newID()
	var timeout *int64
	if defaultTimeout > 0 {
		timeout = ptr(defaultTimeout.Milliseconds())
	}
	if _, err := t.Exec(t.ctx, `INSERT INTO tokens (id, org_id, member_id, name, secret_hash, prefix, default_heartbeat_timeout_ms, created_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, id, t.caller.OrgID, memberID, name, hash, secret[:len(auth.TokenPrefix)+6], timeout, t.caller.MemberID, ms(t.now)); err != nil {
		return IssuedToken{}, err
	}
	if err := t.recordByCaller("token.issued", id, map[string]any{"member_id": memberID, "name": name}); err != nil {
		return IssuedToken{}, err
	}
	tok, err := scanToken(t.QueryRow(t.ctx, `SELECT `+tokenCols+` FROM tokens WHERE org_id = $1 AND id = $2`, t.caller.OrgID, id))
	return IssuedToken{Token: tok, Secret: secret}, err
}

// ListTokens lists a Member's tokens, newest first. A Member sees their own; an admin anyone's.
func (s *Service) ListTokens(ctx context.Context, c *auth.Caller, memberRef string) ([]Token, error) {
	member, err := resolveMember(ctx, s.store, c.OrgID, memberRef)
	if err != nil {
		return nil, err
	}
	if member != c.MemberID && !c.Admin {
		return nil, refuse(CodeForbidden, "only an admin may list another Member's tokens")
	}
	return collect(ctx, s.store, scanToken, `SELECT `+tokenCols+` FROM tokens WHERE org_id = $1 AND member_id = $2
ORDER BY created_at DESC, id DESC`, c.OrgID, member)
}

// RevokeToken revokes a token, closes its Sessions and ends the Claims bound to them at once. A
// Member may revoke their own; an admin anyone's.
func (s *Service) RevokeToken(ctx context.Context, c *auth.Caller, tokenID string, idem Idem) (Token, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		tok, err := scanToken(t.QueryRow(ctx, `SELECT `+tokenCols+` FROM tokens WHERE org_id = $1 AND id = $2`, c.OrgID, tokenID))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, refuse(CodeNotFound, "no token %s", tokenID)
		}
		if err != nil {
			return nil, err
		}
		if tok.MemberID != c.MemberID && !c.Admin {
			return nil, refuse(CodeForbidden, "only an admin may revoke another Member's token")
		}
		if tok.RevokedAt != nil {
			return tok, nil
		}
		if _, err := t.Exec(ctx, `UPDATE tokens SET revoked_at = $1 WHERE org_id = $2 AND id = $3`, ms(t.now), c.OrgID, tokenID); err != nil {
			return nil, err
		}
		if err := t.recordByCaller("token.revoked", tokenID, map[string]any{"member_id": tok.MemberID}); err != nil {
			return nil, err
		}
		sessions, err := openSessions(t, `token_id = $2`, tokenID)
		if err != nil {
			return nil, err
		}
		for _, sess := range sessions {
			if _, err := closeSession(t, sess, "token_revoked", &c.MemberID); err != nil {
				return nil, err
			}
		}
		return scanToken(t.QueryRow(ctx, `SELECT `+tokenCols+` FROM tokens WHERE org_id = $1 AND id = $2`, c.OrgID, tokenID))
	})
	if err != nil {
		return Token{}, err
	}
	return res.(Token), nil
}

func openSessions(t *tx, where string, arg any) ([]string, error) {
	return collect(t.ctx, t, func(row interface{ Scan(...any) error }) (string, error) {
		var id string
		return id, row.Scan(&id)
	}, `SELECT id FROM sessions WHERE org_id = $1 AND closed_at IS NULL AND `+where+` ORDER BY id`, t.caller.OrgID, arg)
}

// closeSession closes a Session and ends the Claims bound to it — those made with a heartbeat
// timeout — recording each in Activity with by as the actor (nil when Darkory acts). It returns
// how many Claims it ended.
func closeSession(t *tx, sessionID, how string, by *string) (int, error) {
	if _, err := t.Exec(t.ctx, `UPDATE sessions SET closed_at = $1 WHERE org_id = $2 AND id = $3 AND closed_at IS NULL`,
		ms(t.now), t.caller.OrgID, sessionID); err != nil {
		return 0, err
	}
	ended, err := endClaims(t, `c.session_id = $2 AND c.timeout_ms IS NOT NULL AND t.claim_expires_at IS NOT NULL`, sessionID, how, by)
	if err != nil {
		return 0, err
	}
	if err := t.record(by, "session.closed", sessionID, map[string]any{"how": how, "claims_ended": ended}); err != nil {
		return 0, err
	}
	return ended, nil
}

// endClaims ends the live Claims picked by where (over the Task t and its Claim c, binding $2 to
// arg) as how, by by, clearing each Task's Claim and recording task.claim_ended. A Claim whose
// expiry had already passed ended at its expiry: it is recorded as lapsed, with no actor. It
// returns how many Claims it ended that had not lapsed.
func endClaims(t *tx, where string, arg any, how string, by *string) (int, error) {
	type bound struct {
		task, claim, holder string
		expires             sql.NullInt64
	}
	claims, err := collect(t.ctx, t, func(row interface{ Scan(...any) error }) (bound, error) {
		var b bound
		return b, row.Scan(&b.task, &b.claim, &b.holder, &b.expires)
	}, `SELECT t.id, c.id, c.holder_id, t.claim_expires_at FROM tasks t JOIN claims c ON c.id = t.claim_id
WHERE t.org_id = $1 AND c.ended_at IS NULL AND `+where+`
ORDER BY t.id`, t.caller.OrgID, arg)
	if err != nil {
		return 0, err
	}
	ended := 0
	for _, b := range claims {
		endedAt, endedHow, actor := ms(t.now), how, by
		if b.expires.Valid && b.expires.Int64 <= ms(t.now) {
			endedAt, endedHow, actor = b.expires.Int64, "lapsed", nil
		}
		if _, err := t.Exec(t.ctx, `UPDATE claims SET ended_at = $1, how_ended = $2, ended_by = $3 WHERE org_id = $4 AND id = $5`,
			endedAt, endedHow, actor, t.caller.OrgID, b.claim); err != nil {
			return 0, err
		}
		if _, err := t.Exec(t.ctx, clearClaimSQL+` WHERE org_id = $1 AND id = $2 AND claim_id = $3`, t.caller.OrgID, b.task, b.claim); err != nil {
			return 0, err
		}
		kind := "task.claim_ended"
		if endedHow == "lapsed" {
			kind = "task.lapsed"
		} else {
			ended++
		}
		if err := t.record(actor, kind, b.task, map[string]any{"claim_id": b.claim, "holder_id": b.holder, "how_ended": endedHow}); err != nil {
			return 0, err
		}
	}
	return ended, nil
}

// CallerValid reports whether the caller's Session is still open and unexpired, its token
// unrevoked and its Member active. A request is authenticated when it arrives; one that lasts —
// the Activity stream, a waiting `next` — asks this before it acts, so a revocation, a close or a
// deactivation stops it at once.
func (s *Service) CallerValid(ctx context.Context, c *auth.Caller) (bool, error) {
	args := s.browser.Args(s.clock.Now())
	args["org"], args["session"], args["member"] = c.OrgID, c.SessionID, c.MemberID
	q, qa := store.Bind(`SELECT COUNT(*) FROM sessions s JOIN members m ON m.id = s.member_id LEFT JOIN tokens tk ON tk.id = s.token_id
WHERE s.org_id = @org AND s.id = @session AND s.member_id = @member AND s.closed_at IS NULL
AND (s.token_id IS NULL OR tk.revoked_at IS NULL) AND m.deactivated_at IS NULL AND `+auth.LiveSessionSQL, args)
	var n int
	err := s.store.QueryRow(ctx, q, qa...).Scan(&n)
	return n > 0, err
}

func (s *Service) mustBeValid(ctx context.Context, c *auth.Caller) error {
	ok, err := s.CallerValid(ctx, c)
	if err != nil {
		return err
	}
	if !ok {
		return refuse(CodeUnauthenticated, "this request's Session was closed or its token revoked")
	}
	return nil
}

// clearClaimSQL leaves a Task with no current Claim.
const clearClaimSQL = `UPDATE tasks SET claim_id = NULL, claim_holder_id = NULL, claim_session_id = NULL,
claim_skill_id = NULL, claim_timeout_ms = NULL, claim_expires_at = NULL`

const sessionCols = `s.chosen_id, s.member_id, s.kind, s.token_id, s.created_at, s.last_seen_at, s.closed_at`

func scanSession(row interface{ Scan(...any) error }) (Session, error) {
	var s Session
	var token sql.NullString
	var created, seen int64
	var closed sql.NullInt64
	err := row.Scan(&s.ID, &s.MemberID, &s.Kind, &token, &created, &seen, &closed)
	s.TokenID, s.StartedAt, s.LastSeenAt, s.ClosedAt = nullString(token), fromMS(created), fromMS(seen), nullTime(closed)
	return s, err
}

// expiry fills in when an open browser Session expires unless used.
func (s *Service) expiry(sess *Session) {
	if sess.Kind == "browser" && sess.ClosedAt == nil {
		sess.ExpiresAt = ptr(s.browser.ExpiresAt(sess.StartedAt, sess.LastSeenAt).UTC())
	}
}

// ListSessions lists a Member's open Sessions that have not expired, most recently seen first. A
// Member sees their own; an admin anyone's.
func (s *Service) ListSessions(ctx context.Context, c *auth.Caller, memberRef string, limit int, cursor string) (Page[Session], error) {
	member, err := resolveMember(ctx, s.store, c.OrgID, memberRef)
	if err != nil {
		return Page[Session]{}, err
	}
	if member != c.MemberID && !c.Admin {
		return Page[Session]{}, refuse(CodeForbidden, "only an admin may list another Member's Sessions")
	}
	offset, err := decodeCursor(cursor)
	if err != nil {
		return Page[Session]{}, err
	}
	n := limitOf(limit)
	args := s.browser.Args(s.clock.Now())
	args["org"], args["member"], args["limit"], args["offset"] = c.OrgID, member, n+1, offset
	q, qa := store.Bind(`SELECT `+sessionCols+` FROM sessions s
WHERE s.org_id = @org AND s.member_id = @member AND s.closed_at IS NULL AND `+auth.LiveSessionSQL+`
ORDER BY s.last_seen_at DESC, s.id LIMIT @limit OFFSET @offset`, args)
	items, err := collect(ctx, s.store, scanSession, q, qa...)
	if err != nil {
		return Page[Session]{}, err
	}
	for i := range items {
		s.expiry(&items[i])
	}
	return page(items, offset, n), nil
}

func getSession(ctx context.Context, r store.Reader, orgID, id string) (Session, error) {
	s, err := scanSession(r.QueryRow(ctx, `SELECT `+sessionCols+` FROM sessions s WHERE s.org_id = $1 AND s.id = $2`, orgID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, refuse(CodeNotFound, "no Session %s", id)
	}
	return s, err
}

// CloseSession closes one of the caller's open Sessions, named by the id it chose, and ends the
// Claims bound to it. An admin may close another Member's Session by naming memberRef.
func (s *Service) CloseSession(ctx context.Context, c *auth.Caller, chosenID string, memberRef *string, idem Idem) (ClosedSession, error) {
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		member := c.MemberID
		if memberRef != nil {
			id, err := resolveMember(ctx, t, c.OrgID, *memberRef)
			if err != nil {
				return nil, err
			}
			member = id
		}
		if member != c.MemberID && !c.Admin {
			return nil, refuse(CodeForbidden, "only an admin may close another Member's Session")
		}
		var id string
		err := t.QueryRow(ctx, `SELECT id FROM sessions WHERE org_id = $1 AND member_id = $2 AND chosen_id = $3 AND closed_at IS NULL`,
			c.OrgID, member, chosenID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, refuse(CodeNotFound, "no open Session %q", chosenID)
		}
		if err != nil {
			return nil, err
		}
		n, err := closeSession(t, id, "session_closed", &c.MemberID)
		if err != nil {
			return nil, err
		}
		sess, err := getSession(ctx, t, c.OrgID, id)
		return ClosedSession{Session: sess, ClaimsEnded: n}, err
	})
	if err != nil {
		return ClosedSession{}, err
	}
	return res.(ClosedSession), nil
}

// Logout closes the Session the caller calls through, ending the Claims bound to it.
func (s *Service) Logout(ctx context.Context, c *auth.Caller, idem Idem) error {
	_, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		_, err := closeSession(t, c.SessionID, "session_closed", &c.MemberID)
		return nil, err
	})
	return err
}

// IssueLoginLink issues a one-time login link for a Member (admin).
func (s *Service) IssueLoginLink(ctx context.Context, c *auth.Caller, memberRef string, idem Idem) (LoginLink, error) {
	if err := mustAdmin(c); err != nil {
		return LoginLink{}, err
	}
	res, err := s.write(ctx, c, idem, func(t *tx) (any, error) {
		member, err := resolveMember(ctx, t, c.OrgID, memberRef)
		if err != nil {
			return nil, err
		}
		if err := mustBeActive(t, member); err != nil {
			return nil, err
		}
		return issueLoginLink(t, member, &c.MemberID)
	})
	if err != nil {
		return LoginLink{}, err
	}
	return res.(LoginLink), nil
}

func issueLoginLink(t *tx, memberID string, by *string) (LoginLink, error) {
	code, hash := auth.NewSecret("")
	id := newID()
	expires := t.now.Add(LoginLinkTTL)
	if _, err := t.Exec(t.ctx, `INSERT INTO login_links (id, org_id, member_id, code_hash, created_by, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)`, id, t.caller.OrgID, memberID, hash, by, ms(t.now), ms(expires)); err != nil {
		return LoginLink{}, err
	}
	if err := t.record(by, "login_link.issued", id, map[string]any{"member_id": memberID}); err != nil {
		return LoginLink{}, err
	}
	return LoginLink{Code: code, ExpiresAt: expires}, nil
}

// BrowserSession is the cookie a redeemed login link sets.
type BrowserSession struct {
	Cookie   string
	MemberID string
}

// LoginLinkFor names whom a login link signs in, without using it: the Member's name and their
// Organisation's. An unknown, used or expired link, or one for a deactivated Member, is not_found.
func (s *Service) LoginLinkFor(ctx context.Context, code string) (member, organisation string, err error) {
	err = s.store.QueryRow(ctx, `SELECT m.name, o.name FROM login_links l JOIN members m ON m.id = l.member_id JOIN organisations o ON o.id = l.org_id
WHERE l.code_hash = $1 AND l.used_at IS NULL AND l.expires_at > $2 AND m.deactivated_at IS NULL`, auth.Hash(code), ms(s.clock.Now())).
		Scan(&member, &organisation)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", refuse(CodeNotFound, "this login link is unknown, used or expired")
	}
	return member, organisation, err
}

// RedeemLoginLink uses a login link once: it starts a browser Session for the link's Member and
// returns the cookie that maps to it. An unknown, used or expired link, or one for a deactivated
// Member, is not_found. The Session of the cookie the browser held before, if any, is closed: the
// browser no longer has it.
func (s *Service) RedeemLoginLink(ctx context.Context, code, oldCookie string) (BrowserSession, error) {
	var linkID, orgID, memberID string
	err := s.store.QueryRow(ctx, `SELECT l.id, l.org_id, l.member_id FROM login_links l JOIN members m ON m.id = l.member_id
WHERE l.code_hash = $1 AND m.deactivated_at IS NULL`, auth.Hash(code)).
		Scan(&linkID, &orgID, &memberID)
	if errors.Is(err, sql.ErrNoRows) {
		return BrowserSession{}, refuse(CodeNotFound, "this login link is unknown, used or expired")
	}
	if err != nil {
		return BrowserSession{}, err
	}
	cookie, hash := auth.NewSecret("")
	c := &auth.Caller{OrgID: orgID, MemberID: memberID}
	_, err = s.write(ctx, c, Idem{}, func(t *tx) (any, error) {
		res, err := t.Exec(ctx, `UPDATE login_links SET used_at = $1 WHERE org_id = $2 AND id = $3 AND used_at IS NULL AND expires_at > $1`,
			ms(t.now), orgID, linkID)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil, refuse(CodeNotFound, "this login link is unknown, used or expired")
		}
		sessionID := newID()
		if _, err := t.Exec(ctx, `INSERT INTO sessions (id, org_id, member_id, chosen_id, kind, cookie_hash, created_at, last_seen_at)
VALUES ($1, $2, $3, $4, 'browser', $5, $6, $6)`, sessionID, orgID, memberID, "browser-"+sessionID, hash, ms(t.now)); err != nil {
			return nil, err
		}
		return nil, t.recordByCaller("login_link.redeemed", linkID, map[string]any{"member_id": memberID})
	})
	if err != nil {
		return BrowserSession{}, err
	}
	if oldCookie != "" {
		if err := s.closeCookieSession(ctx, oldCookie); err != nil {
			s.log.Error("closing the browser Session a sign-in replaced", "err", err)
		}
	}
	return BrowserSession{Cookie: cookie, MemberID: memberID}, nil
}

// closeCookieSession closes the open browser Session a cookie maps to, if any, with no actor.
func (s *Service) closeCookieSession(ctx context.Context, cookie string) error {
	var id, orgID, memberID string
	err := s.store.QueryRow(ctx, `SELECT id, org_id, member_id FROM sessions WHERE cookie_hash = $1 AND kind = 'browser' AND closed_at IS NULL`,
		auth.Hash(cookie)).Scan(&id, &orgID, &memberID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = s.write(ctx, &auth.Caller{OrgID: orgID, MemberID: memberID}, Idem{}, func(t *tx) (any, error) {
		_, err := closeSession(t, id, "session_closed", nil)
		return nil, err
	})
	return err
}
