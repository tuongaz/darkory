package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// ErrConditionFailed reports that a guard in a batch found its condition false, so the batch
// wrote nothing. The caller reads why after the rollback (plan invariant 4).
var ErrConditionFailed = errors.New("store: a guarded condition failed")

// Row is one row a batch statement returned.
type Row interface {
	Scan(dest ...any) error
}

// Stmt is one statement of a batch write. Later statements cannot use what earlier ones return,
// since the whole batch is sent before any reply arrives; they reach earlier effects through
// subqueries instead, and take the values the caller chose (ids, now) as arguments.
type Stmt struct {
	SQL  string
	Args []any
	// Scan, when set, is called for each row the statement returns.
	Scan func(Row) error
	// Guard marks a statement that checks a condition the rest of the batch relies on. It must
	// return one row of one integer: 1 when the condition holds. Write it as
	// `SELECT 1 / COUNT(*) FROM … WHERE <condition>`: when nothing matches, Postgres raises
	// division by zero, which aborts the transaction in the same round trip, and SQLite answers
	// NULL, which the runner sees before sending the next statement. Either way the batch rolls
	// back and returns ErrConditionFailed.
	Guard bool
}

// WriteBatch runs stmts as one write transaction on the Organisation orgID, after taking the next
// number from its counter, as Write does (ADR 0011). Statements that record Activity read that
// number with `(SELECT seq FROM organisations WHERE id = …)`.
//
// On Postgres the whole transaction — the counter and stmts — is one pgx batch, sent in one round
// trip, so the counter is held for one round trip only (plan invariant 4). The batch runs as the
// implicit transaction Postgres gives every statement up to the pipeline's Sync: it commits at
// the Sync when every statement succeeded, and rolls back there when one failed, so a refused
// write also ends in that round trip instead of holding the counter for a ROLLBACK. On SQLite the
// same statements run one by one in an ordinary immediate transaction.
func (s *Store) WriteBatch(ctx context.Context, orgID string, stmts ...Stmt) error {
	all := make([]Stmt, 0, len(stmts)+2)
	all = append(all,
		Stmt{SQL: `UPDATE organisations SET seq = seq + 1 WHERE id = $1`, Args: []any{orgID}},
		Stmt{SQL: `SELECT 1 / COUNT(*) FROM organisations WHERE id = $1`, Args: []any{orgID}, Guard: true},
	)
	all = append(all, stmts...)
	err := s.runBatch(ctx, all)
	if errors.Is(err, ErrConditionFailed) && !s.organisationExists(ctx, orgID) {
		return fmt.Errorf("store: organisation %s: %w", orgID, ErrNotFound)
	}
	return err
}

// WriteBatchNoSeq runs stmts as one write transaction that takes no sequence number and records
// no Activity, in one round trip on Postgres. Only Heartbeats use it.
func (s *Store) WriteBatchNoSeq(ctx context.Context, stmts ...Stmt) error {
	return s.runBatch(ctx, stmts)
}

func (s *Store) organisationExists(ctx context.Context, orgID string) bool {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM organisations WHERE id = $1`, orgID).Scan(&n)
	return err == nil && n > 0
}

func (s *Store) runBatch(ctx context.Context, stmts []Stmt) error {
	if s.engine == Postgres {
		return s.runPostgresBatch(ctx, stmts)
	}
	return s.inTx(ctx, func(tx *txn) error {
		for i, st := range stmts {
			if err := runOne(ctx, tx, st); err != nil {
				if errors.Is(err, ErrConditionFailed) {
					return err
				}
				return fmt.Errorf("store: batch statement %d: %w", i, err)
			}
		}
		return nil
	})
}

func runOne(ctx context.Context, tx *txn, st Stmt) error {
	if st.Scan == nil && !st.Guard {
		_, err := tx.Exec(ctx, st.SQL, st.Args...)
		return err
	}
	rows, err := tx.Query(ctx, st.SQL, st.Args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	if err := scanRows(rows, st); err != nil {
		return err
	}
	return rows.Close()
}

type rowIter interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanRows(rows rowIter, st Stmt) error {
	held := false
	for rows.Next() {
		if st.Guard {
			var v sql.NullInt64
			if err := rows.Scan(&v); err != nil {
				return err
			}
			held = v.Valid && v.Int64 == 1
			continue
		}
		if err := st.Scan(rows); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		if isDivisionByZero(err) && st.Guard {
			return ErrConditionFailed
		}
		return err
	}
	if st.Guard && !held {
		return ErrConditionFailed
	}
	return nil
}

// runPostgresBatch sends the statements as one pgx batch on one connection of the pool, reached
// through database/sql's Raw so the store keeps a single pool and a single Tx type.
func (s *Store) runPostgresBatch(ctx context.Context, stmts []Stmt) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("store: batch: %w", err)
	}
	defer conn.Close()
	return conn.Raw(func(driverConn any) error {
		pc := driverConn.(*stdlib.Conn).Conn()
		b := &pgx.Batch{}
		for _, st := range stmts {
			b.Queue(st.SQL, st.Args...)
		}
		runErr := readBatch(pc.SendBatch(ctx, b), stmts)
		// The implicit transaction always ends at the Sync. Should the connection still be inside
		// one, as after a broken connection, end it so it never goes back to the pool mid-way.
		if pc.PgConn().TxStatus() != 'I' && !pc.IsClosed() {
			if _, err := pc.Exec(context.WithoutCancel(ctx), "ROLLBACK"); err != nil && runErr == nil {
				runErr = err
			}
		}
		return runErr
	})
}

func readBatch(br pgx.BatchResults, stmts []Stmt) (err error) {
	defer func() {
		if cerr := br.Close(); cerr != nil && err == nil {
			err = fmt.Errorf("store: batch: %w", cerr)
		}
	}()
	for i, st := range stmts {
		if st.Scan == nil && !st.Guard {
			if _, err := br.Exec(); err != nil {
				return fmt.Errorf("store: batch statement %d: %w", i, err)
			}
			continue
		}
		rows, err := br.Query()
		if err != nil {
			if st.Guard && isDivisionByZero(err) {
				return ErrConditionFailed
			}
			return fmt.Errorf("store: batch statement %d: %w", i, err)
		}
		err = scanRows(rows, st)
		rows.Close()
		if err != nil {
			if errors.Is(err, ErrConditionFailed) {
				return err
			}
			return fmt.Errorf("store: batch statement %d: %w", i, err)
		}
	}
	return nil
}

func isDivisionByZero(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22012"
}

// IsUniqueViolation reports whether err is a unique or primary key violation, on either engine.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	var sqErr *sqlite.Error
	if errors.As(err, &sqErr) {
		code := sqErr.Code()
		return code == sqlite3.SQLITE_CONSTRAINT_UNIQUE || code == sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY
	}
	return false
}

// NextSeq takes another number from the Organisation's counter inside a Write, for a write that
// records more than one Activity entry. The counter is already held, so it never waits.
func NextSeq(ctx context.Context, tx Tx, orgID string) (int64, error) {
	var seq int64
	err := tx.QueryRow(ctx, `UPDATE organisations SET seq = seq + 1 WHERE id = $1 RETURNING seq`, orgID).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("store: take sequence: %w", err)
	}
	return seq, nil
}

var namedParam = regexp.MustCompile(`@([a-z][a-z0-9_]*)`)

// Bind rewrites the @name placeholders in query to $1, $2… in order of first use, and returns
// the arguments to match. A name used twice gets one number. It panics on a name missing from
// args, which is a mistake in the query, not in the request.
func Bind(query string, args map[string]any) (string, []any) {
	index := map[string]int{}
	var out []any
	q := namedParam.ReplaceAllStringFunc(query, func(m string) string {
		name := m[1:]
		if i, ok := index[name]; ok {
			return fmt.Sprintf("$%d", i)
		}
		v, ok := args[name]
		if !ok {
			panic(fmt.Sprintf("store.Bind: no argument for @%s in %q", name, query))
		}
		out = append(out, v)
		index[name] = len(out)
		return fmt.Sprintf("$%d", len(out))
	})
	return q, out
}

// S binds query with args into a Stmt.
func S(query string, args map[string]any) Stmt {
	q, a := Bind(query, args)
	return Stmt{SQL: q, Args: a}
}
