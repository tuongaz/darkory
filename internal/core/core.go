// Package core holds Darkory's domain rules as operations over the store. Every write goes
// through store.Write or store.WriteBatch, records Activity numbered from the Organisation's
// counter, keeps an Idempotency-Key's response in the same transaction, and wakes waiters after
// it commits (docs/build/plan.md, invariants 1–7).
package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/wake"
)

// Service runs the domain operations.
type Service struct {
	store   *store.Store
	clock   clock.Clock
	wake    *wake.Notifier
	log     *slog.Logger
	browser auth.BrowserLimits
}

// New returns a Service over st, with auth.DefaultBrowserLimits.
func New(st *store.Store, c clock.Clock, w *wake.Notifier, log *slog.Logger) *Service {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Service{store: st, clock: c, wake: w, log: log, browser: auth.DefaultBrowserLimits}
}

// WithBrowserLimits sets how long browser Sessions last, as the Authenticator has them, and
// returns s.
func (s *Service) WithBrowserLimits(l auth.BrowserLimits) *Service {
	s.browser = l
	return s
}

// Store returns the store the Service runs on.
func (s *Service) Store() *store.Store { return s.store }

// Clock returns the Service's clock.
func (s *Service) Clock() clock.Clock { return s.clock }

// Wake returns the notifier the Service signals after each write.
func (s *Service) Wake() *wake.Notifier { return s.wake }

// Code is a stable reason for a refusal; the API sends it as the Error code.
type Code string

const (
	CodeInvalid              Code = "invalid"
	CodeUnauthenticated      Code = "unauthenticated"
	CodeSessionRequired      Code = "session_required"
	CodeForbidden            Code = "forbidden"
	CodeNotFound             Code = "not_found"
	CodeConflict             Code = "conflict"
	CodeAlreadyClaimed       Code = "already_claimed"
	CodeNotTakeable          Code = "not_takeable"
	CodeNotHolder            Code = "not_holder"
	CodeEnded                Code = "ended"
	CodeCycle                Code = "cycle"
	CodeTasksOpen            Code = "tasks_open"
	CodeProposalStale        Code = "proposal_stale"
	CodeStatusInUse          Code = "status_in_use"
	CodeUseComplete          Code = "use_complete"
	CodeUseDrop              Code = "use_drop"
	CodeTooLarge             Code = "too_large"
	CodeIdempotencyKeyReused Code = "idempotency_key_reused"
	CodeNotImplemented       Code = "not_implemented"
)

// Error is a refusal the caller can act on.
type Error struct {
	Code    Code
	Message string
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func refuse(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Replay is returned instead of performing a write whose Idempotency-Key was already used for
// the same request: it carries the first response.
type Replay struct {
	Status int
	Body   []byte
}

func (r *Replay) Error() string { return fmt.Sprintf("idempotent replay of a %d response", r.Status) }

// Idem is a write's Idempotency-Key. A zero Idem means the request sent none.
type Idem struct {
	Key string
	// Hash identifies the request (method, path and body), so a key reused for another request
	// is refused.
	Hash string
	// Render turns the write's result into the response stored under the key, in the same
	// transaction as the write.
	Render func(result any) (status int, body []byte, err error)
	// RenderRefusal turns a refusal kept under the key into its response.
	RenderRefusal func(refusal *Error) (status int, body []byte, err error)
}

// IdempotencyTTL is how long a response is kept under its key.
const IdempotencyTTL = 24 * time.Hour

// Lookup returns the stored response for idem as a *Replay, a refusal when the key was used for
// another request, or nil when the key is unused.
func (s *Service) Lookup(ctx context.Context, c *auth.Caller, idem Idem) error {
	if idem.Key == "" {
		return nil
	}
	return lookupIdem(ctx, s.store, c, idem, s.clock.Now())
}

func lookupIdem(ctx context.Context, r store.Reader, c *auth.Caller, idem Idem, now time.Time) error {
	var hash string
	var status int
	var body string
	err := r.QueryRow(ctx, `SELECT request_hash, status, response FROM idempotency_keys
WHERE org_id = $1 AND member_id = $2 AND idempotency_key = $3 AND created_at > $4`,
		c.OrgID, c.MemberID, idem.Key, now.Add(-IdempotencyTTL).UnixMilli()).Scan(&hash, &status, &body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("core: idempotency key: %w", err)
	}
	if hash != idem.Hash {
		return refuse(CodeIdempotencyKeyReused, "Idempotency-Key %q was used for a different request", idem.Key)
	}
	return &Replay{Status: status, Body: []byte(body)}
}

// PurgeIdempotencyKeys deletes responses kept longer than IdempotencyTTL. It is housekeeping, not
// a change to the record, so it takes no sequence number and records no Activity.
func (s *Service) PurgeIdempotencyKeys(ctx context.Context) error {
	orgs, err := s.organisations(ctx)
	if err != nil {
		return err
	}
	cutoff := s.clock.Now().Add(-IdempotencyTTL).UnixMilli()
	for _, org := range orgs {
		if err := s.store.WriteBatchNoSeq(ctx, store.Stmt{
			SQL:  `DELETE FROM idempotency_keys WHERE org_id = $1 AND created_at <= $2`,
			Args: []any{org, cutoff},
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) organisations(ctx context.Context) ([]string, error) {
	return collect(ctx, s.store, func(row interface{ Scan(...any) error }) (string, error) {
		var id string
		return id, row.Scan(&id)
	}, `SELECT id FROM organisations ORDER BY id`)
}

// idemStmts keeps result under idem's key, in a batch write. An expired row under the same key
// is removed first. A concurrent request under the same key makes the insert fail, which rolls
// the batch back; the caller then finds the winner's response with Lookup.
func idemStmts(c *auth.Caller, idem Idem, result any, now time.Time) ([]store.Stmt, error) {
	if idem.Key == "" {
		return nil, nil
	}
	status, body, err := idem.Render(result)
	if err != nil {
		return nil, err
	}
	args := map[string]any{
		"org": c.OrgID, "member": c.MemberID, "key": idem.Key, "hash": idem.Hash,
		"status": int64(status), "body": string(body), "now": now.UnixMilli(),
		"cutoff": now.Add(-IdempotencyTTL).UnixMilli(),
	}
	return []store.Stmt{
		store.S(`DELETE FROM idempotency_keys WHERE org_id = @org AND member_id = @member AND idempotency_key = @key AND created_at <= @cutoff`, args),
		store.S(`INSERT INTO idempotency_keys (org_id, member_id, idempotency_key, request_hash, status, response, created_at)
VALUES (@org, @member, @key, @hash, @status, @body, @now)`, args),
	}, nil
}

// afterRefusal works out what a refused batch write should answer: the stored response when the
// write was refused because a concurrent request with the same key won.
func (s *Service) afterRefusal(ctx context.Context, c *auth.Caller, idem Idem, err error) error {
	if idem.Key == "" {
		return err
	}
	if lerr := s.Lookup(ctx, c, idem); lerr != nil {
		return lerr
	}
	return err
}

// errUnchanged rolls back a write that found nothing to change, so it takes no sequence number.
var errUnchanged = errors.New("core: nothing changed")

// tx is what a write callback works with.
type tx struct {
	store.Tx
	ctx    context.Context
	caller *auth.Caller
	now    time.Time
	seq    int64
	used   bool
}

// record appends an Activity entry. The first takes the write's sequence number; each further
// one takes the next from the counter, which the write already holds.
func (t *tx) record(actor *string, kind, subject string, payload map[string]any) error {
	seq := t.seq
	if t.used {
		var err error
		if seq, err = store.NextSeq(t.ctx, t.Tx, t.caller.OrgID); err != nil {
			return err
		}
	}
	t.used = true
	if payload == nil {
		payload = map[string]any{}
	}
	p, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = t.Exec(t.ctx, `INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		t.caller.OrgID, seq, actor, kind, subject, string(p), t.now.UnixMilli())
	return err
}

// recordByCaller appends an Activity entry with the caller as actor.
func (t *tx) recordByCaller(kind, subject string, payload map[string]any) error {
	return t.record(&t.caller.MemberID, kind, subject, payload)
}

// write runs fn as one write on the caller's Organisation (store.Write), keeping fn's result
// under idem in the same transaction and waking waiters after the commit. A write that records
// no Activity changed nothing and is rolled back, so Activity numbers stay gapless.
func (s *Service) write(ctx context.Context, c *auth.Caller, idem Idem, fn func(t *tx) (any, error)) (any, error) {
	var result any
	unchanged := false
	err := s.store.Write(ctx, c.OrgID, func(stx store.Tx, seq int64) error {
		t := &tx{Tx: stx, ctx: ctx, caller: c, now: s.clock.Now(), seq: seq}
		if idem.Key != "" {
			if err := lookupIdem(ctx, stx, c, idem, t.now); err != nil {
				return err
			}
		}
		res, err := fn(t)
		if err != nil {
			return err
		}
		result = res
		if !t.used {
			unchanged = true
			return errUnchanged
		}
		stmts, err := idemStmts(c, idem, res, t.now)
		if err != nil {
			return err
		}
		for _, st := range stmts {
			if _, err := stx.Exec(ctx, st.SQL, st.Args...); err != nil {
				return err
			}
		}
		return nil
	})
	if unchanged && errors.Is(err, errUnchanged) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	s.wake.Signal(c.OrgID)
	return result, nil
}

// writeBatch runs stmts as one batch write (one round trip on Postgres) and wakes waiters after
// it commits.
func (s *Service) writeBatch(ctx context.Context, orgID string, stmts []store.Stmt) error {
	if err := s.store.WriteBatch(ctx, orgID, stmts...); err != nil {
		return err
	}
	s.wake.Signal(orgID)
	return nil
}

// activityStmt appends an Activity entry inside a batch write, numbered from the counter as it
// stands at that point of the batch.
func activityStmt(orgID string, actor *string, kind, subject string, payload map[string]any, now time.Time) store.Stmt {
	if payload == nil {
		payload = map[string]any{}
	}
	p, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return store.S(`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at)
SELECT @org, o.seq, CAST(@actor AS TEXT), @kind, @subject, @payload, CAST(@now AS BIGINT) FROM organisations o WHERE o.id = @org`,
		map[string]any{"org": orgID, "actor": actor, "kind": kind, "subject": subject, "payload": string(p), "now": now.UnixMilli()})
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func fromMS(v int64) time.Time { return time.UnixMilli(v).UTC() }

func nullTime(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := fromMS(v.Int64)
	return &t
}

func nullString(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func ptr[T any](v T) *T { return &v }

// mustAdmin refuses a caller without the admin mark.
func mustAdmin(c *auth.Caller) error {
	if !c.Admin {
		return refuse(CodeForbidden, "only an admin may do this")
	}
	return nil
}
