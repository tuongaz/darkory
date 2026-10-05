// Package store opens the database, SQLite or Postgres, keeps its schema current, and runs every
// write through Write, so that the writes of one Organisation happen one at a time on both
// engines (ADR 0011).
//
// Query text uses $1, $2… placeholders on both engines; modernc.org/sqlite accepts them as
// numbered parameters, reused and in any order.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib" // also registers the "pgx" driver
	_ "modernc.org/sqlite"           // registers the "sqlite" driver
)

// Engine names a database engine.
type Engine string

const (
	SQLite   Engine = "sqlite"
	Postgres Engine = "postgres"
)

// ErrNotFound reports that a row the caller named does not exist.
var ErrNotFound = errors.New("store: not found")

// Reader runs queries that read. *Store reads outside any transaction; a Tx reads inside its own.
type Reader interface {
	Query(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRow(ctx context.Context, query string, args ...any) *sql.Row
}

// Tx is the transaction a Write or WriteNoSeq callback runs in. It cannot commit or roll back;
// the callback's return value decides.
type Tx interface {
	Reader
	Exec(ctx context.Context, query string, args ...any) (sql.Result, error)
	Engine() Engine
}

// Store is an open database.
type Store struct {
	db     *sql.DB
	engine Engine
	// path is the SQLite file; empty on Postgres.
	path string
}

// SQLite connection settings. Transactions begin IMMEDIATE so a write takes the lock up front
// and waits for it (busy_timeout) instead of failing with "database is locked" (ADR 0011).
const sqliteParams = "_txlock=immediate" +
	"&_pragma=busy_timeout(10000)" +
	"&_pragma=journal_mode(WAL)" +
	"&_pragma=foreign_keys(1)" +
	"&_pragma=synchronous(NORMAL)"

// Option changes how Open connects.
type Option func(*options)

type options struct {
	maxConns   int
	postgresFn func(*pgx.ConnConfig)
}

// WithMaxConns bounds the connection pool at n instead of the engine's default.
func WithMaxConns(n int) Option { return func(o *options) { o.maxConns = n } }

// WithPostgresConfig lets fn adjust the pgx connection settings before connecting, as the
// round-trip tests do to count what crosses the wire. It has no effect on SQLite.
func WithPostgresConfig(fn func(*pgx.ConnConfig)) Option {
	return func(o *options) { o.postgresFn = fn }
}

// Open opens the database dsn names, without migrating it; call Migrate next.
//
// A dsn starting postgres:// or postgresql:// is a Postgres connection URL. Anything else is the
// path of a SQLite file, optionally prefixed sqlite: or file:, which is created if missing.
func Open(ctx context.Context, dsn string, opts ...Option) (*Store, error) {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	var s *Store
	if EngineOf(dsn) == Postgres {
		cfg, err := pgx.ParseConfig(dsn)
		if err != nil {
			return nil, fmt.Errorf("store: open postgres: %w", redact(dsn, err))
		}
		if o.postgresFn != nil {
			o.postgresFn(cfg)
		}
		db := stdlib.OpenDB(*cfg)
		// Writes to one Organisation queue on its counter row while holding a connection, so the
		// pool is bounded rather than left to Postgres' connection limit.
		db.SetMaxOpenConns(or(o.maxConns, 20))
		db.SetMaxIdleConns(min(or(o.maxConns, 20), 10))
		db.SetConnMaxIdleTime(5 * time.Minute)
		s = &Store{db: db, engine: Postgres}
	} else {
		path := strings.TrimPrefix(strings.TrimPrefix(dsn, "sqlite:"), "file:")
		if path == "" || strings.ContainsAny(path, "?#") || strings.Contains(path, ":memory:") {
			return nil, fmt.Errorf("store: %q is not a SQLite file path", dsn)
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("store: sqlite path: %w", err)
		}
		db, err := sql.Open("sqlite", abs+"?"+sqliteParams)
		if err != nil {
			return nil, fmt.Errorf("store: open sqlite: %w", err)
		}
		// Bounded so that writers mostly queue in the pool rather than in SQLite's busy handler;
		// idle connections are kept so the pragmas above are not rerun on churn.
		db.SetMaxOpenConns(or(o.maxConns, 16))
		db.SetMaxIdleConns(or(o.maxConns, 16))
		s = &Store{db: db, engine: SQLite, path: abs}
	}
	if err := s.db.PingContext(ctx); err != nil {
		s.db.Close()
		return nil, fmt.Errorf("store: connect %s: %w", s.engine, redact(dsn, err))
	}
	return s, nil
}

func or(n, fallback int) int {
	if n > 0 {
		return n
	}
	return fallback
}

// EngineOf reports which engine Open would use for dsn.
func EngineOf(dsn string) Engine {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		return Postgres
	}
	return SQLite
}

// redact keeps a Postgres password out of an error that may quote the URL.
func redact(dsn string, err error) error {
	u, perr := url.Parse(dsn)
	if perr != nil || u.User == nil {
		return err
	}
	if pw, ok := u.User.Password(); ok && pw != "" {
		return errors.New(strings.ReplaceAll(err.Error(), pw, "xxxxx"))
	}
	return err
}

// Engine reports which engine the Store runs on.
func (s *Store) Engine() Engine { return s.engine }

// Path is the SQLite file the Store opened; empty on Postgres.
func (s *Store) Path() string { return s.path }

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Query reads outside any transaction.
func (s *Store) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return s.db.QueryContext(ctx, query, args...)
}

// QueryRow reads one row outside any transaction.
func (s *Store) QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return s.db.QueryRowContext(ctx, query, args...)
}

// Write runs fn in one write transaction on the Organisation orgID. Its first statement takes
// the next number from the Organisation's counter, which makes the Organisation's writes run
// one at a time on both engines; fn receives that number as the Activity sequence for the entry
// it writes (ADR 0011). When fn returns an error, or panics, everything rolls back, the counter
// included, so sequence numbers have no gaps.
//
// Every write goes through Write, except Heartbeats (WriteNoSeq) and creating the Organisation
// itself (CreateOrganisation).
func (s *Store) Write(ctx context.Context, orgID string, fn func(tx Tx, seq int64) error) error {
	return s.inTx(ctx, func(tx *txn) error {
		var seq int64
		err := tx.QueryRow(ctx, `UPDATE organisations SET seq = seq + 1 WHERE id = $1 RETURNING seq`, orgID).Scan(&seq)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: organisation %s: %w", orgID, ErrNotFound)
		}
		if err != nil {
			return fmt.Errorf("store: take sequence: %w", err)
		}
		return fn(tx, seq)
	})
}

// WriteNoSeq runs fn in one write transaction that takes no sequence number and does not queue
// behind the Organisation's other writes on Postgres. Only Heartbeats use it: they write no
// Activity.
func (s *Store) WriteNoSeq(ctx context.Context, fn func(tx Tx) error) error {
	return s.inTx(ctx, func(tx *txn) error { return fn(tx) })
}

// CreateOrganisation writes a new Organisation and returns its id. It is the one write outside
// Write, because the row it creates is the counter Write takes. It records no Activity.
func (s *Store) CreateOrganisation(ctx context.Context, name string, now time.Time) (string, error) {
	id := NewID()
	err := s.inTx(ctx, func(tx *txn) error {
		_, err := tx.Exec(ctx, `INSERT INTO organisations (id, name, seq, created_at) VALUES ($1, $2, 0, $3)`,
			id, name, now.UnixMilli())
		return err
	})
	if err != nil {
		return "", fmt.Errorf("store: create organisation: %w", err)
	}
	return id, nil
}

func (s *Store) inTx(ctx context.Context, fn func(tx *txn) error) error {
	sqlTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	done := false
	defer func() {
		// Also runs when fn panics, so a SQLite write lock is never left held.
		if !done {
			_ = sqlTx.Rollback()
		}
	}()
	if err := fn(&txn{tx: sqlTx, engine: s.engine}); err != nil {
		return err
	}
	done = true
	if err := sqlTx.Commit(); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}

type txn struct {
	tx     *sql.Tx
	engine Engine
}

func (t *txn) Exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.tx.ExecContext(ctx, query, args...)
}

func (t *txn) Query(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return t.tx.QueryContext(ctx, query, args...)
}

func (t *txn) QueryRow(ctx context.Context, query string, args ...any) *sql.Row {
	return t.tx.QueryRowContext(ctx, query, args...)
}

func (t *txn) Engine() Engine { return t.engine }

// NewID returns a new UUIDv7 as text. Ids sort by creation time on both engines.
func NewID() string {
	return uuid.Must(uuid.NewV7()).String()
}
