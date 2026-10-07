package store_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

func activityBatch(org, kind string) store.Stmt {
	return store.S(`INSERT INTO activity (org_id, seq, kind, subject_id, payload, at)
SELECT @org, o.seq, @kind, @subject, '{}', @at FROM organisations o WHERE o.id = @org`,
		map[string]any{"org": org, "kind": kind, "subject": store.NewID(), "at": time.Now().UnixMilli()})
}

func seqs(t *testing.T, s *store.Store, org string) []int64 {
	t.Helper()
	rows, err := s.Query(t.Context(), `SELECT seq FROM activity WHERE org_id = $1 ORDER BY seq`, org)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

// A Postgres batch is sent again only for the server's own transient endings: a serialization
// failure, a deadlock it broke, and 14.24's "new multixact has more than one updating member";
// a refused guard, a constraint and any other internal error are the caller's to read.
func TestTransientPostgresErrorsAreTheOnesSentAgain(t *testing.T) {
	pg := func(code, msg string) error {
		return fmt.Errorf("store: batch statement 0: %w", &pgconn.PgError{Code: code, Message: msg})
	}
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{pg("40001", "could not serialize access due to concurrent update"), true},
		{pg("40P01", "deadlock detected"), true},
		{pg("XX000", "new multixact has more than one updating member: 0 3[1 (nokeyupd), 2 (keysh), 3 (nokeyupd)]"), true},
		{pg("XX000", "could not open file"), false},
		{pg("22012", "division by zero"), false},
		{pg("23505", "duplicate key value violates unique constraint"), false},
		{store.ErrConditionFailed, false},
		{nil, false},
	} {
		if got := store.TransientPG(tc.err); got != tc.want {
			t.Errorf("TransientPG(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

// A batch takes the counter first; a failed guard rolls everything back, the counter included, so
// the next batch takes the same number.
func TestWriteBatchGuardRollsBack(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		org := storetest.Organisation(t, s)

		if err := s.WriteBatch(ctx, org, activityBatch(org, "test.first")); err != nil {
			t.Fatal(err)
		}
		err := s.WriteBatch(ctx, org,
			activityBatch(org, "test.refused"),
			store.Stmt{SQL: `SELECT 1 / COUNT(*) FROM activity WHERE kind = 'nothing'`, Guard: true},
			activityBatch(org, "test.never"),
		)
		if !errors.Is(err, store.ErrConditionFailed) {
			t.Fatalf("err = %v, want ErrConditionFailed", err)
		}
		var scanned []string
		err = s.WriteBatch(ctx, org,
			activityBatch(org, "test.second"),
			store.Stmt{SQL: `SELECT 1 / COUNT(*) FROM activity WHERE kind = 'test.second'`, Guard: true},
			store.Stmt{SQL: `SELECT kind FROM activity WHERE org_id = $1 ORDER BY seq`, Args: []any{org}, Scan: func(r store.Row) error {
				var k string
				if err := r.Scan(&k); err != nil {
					return err
				}
				scanned = append(scanned, k)
				return nil
			}},
		)
		if err != nil {
			t.Fatal(err)
		}
		if got := seqs(t, s, org); len(got) != 2 || got[0] != 1 || got[1] != 2 {
			t.Fatalf("seqs %v, want [1 2]", got)
		}
		if len(scanned) != 2 || scanned[1] != "test.second" {
			t.Fatalf("scanned %v", scanned)
		}
	})
}

func TestWriteBatchToAnUnknownOrganisation(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		err := s.WriteBatch(t.Context(), store.NewID(), activityBatch("x", "test.never"))
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

func TestUniqueViolationIsRecognisedOnBothEngines(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		org := storetest.Organisation(t, s)
		ins := store.Stmt{SQL: `INSERT INTO activity (org_id, seq, kind, subject_id, payload, at) VALUES ($1, 1, 'k', 's', '{}', 0)`, Args: []any{org}}
		if err := s.WriteBatchNoSeq(ctx, ins); err != nil {
			t.Fatal(err)
		}
		err := s.WriteBatchNoSeq(ctx, ins)
		if !store.IsUniqueViolation(err) {
			t.Fatalf("err = %v, want a unique violation", err)
		}
	})
}

// On Postgres a batch write is one round trip, counter to commit, once the connection has
// prepared its statements (plan invariant 4). A refused one rolls back in that same round trip.
func TestWriteBatchIsOneRoundTripOnPostgres(t *testing.T) {
	var w storetest.Wire
	s := storetest.OpenWith(t, store.Postgres, store.WithMaxConns(1), w.Option())
	ctx := t.Context()
	org := storetest.Organisation(t, s)

	write := func(kind string) error {
		return s.WriteBatch(ctx, org,
			activityBatch(org, kind),
			store.Stmt{SQL: `SELECT 1 / COUNT(*) FROM activity WHERE kind = $1`, Args: []any{kind}, Guard: true},
		)
	}
	if err := write("test.warm"); err != nil {
		t.Fatal(err)
	}
	before := w.Snapshot()
	if err := write("test.measured"); err != nil {
		t.Fatal(err)
	}
	got := w.Since(before)
	if got.RoundTrips != 1 || got.Batches != 1 || got.BatchRoundTrips != 1 || got.Queries != 0 {
		t.Fatalf("a batch write took %+v, want one batch in one round trip", got)
	}
	if batch := w.LastBatch(); !strings.HasPrefix(batch[0], "UPDATE organisations SET seq = seq + 1") {
		t.Fatalf("the batch does not take the counter first: %q", batch)
	}

	before = w.Snapshot()
	err := s.WriteBatch(ctx, org,
		activityBatch(org, "test.refused"),
		store.Stmt{SQL: `SELECT 1 / COUNT(*) FROM activity WHERE kind = $1`, Args: []any{"nothing"}, Guard: true},
	)
	if !errors.Is(err, store.ErrConditionFailed) {
		t.Fatalf("err = %v", err)
	}
	// The batch, then reading why (here: whether the Organisation exists) after the rollback.
	if got := w.Since(before); got.Batches != 1 || got.BatchRoundTrips != 1 {
		t.Fatalf("a refused batch took %+v, want one batch in one round trip", got)
	}

	// A single statement without the counter, as a Heartbeat is, needs no BEGIN.
	ins := store.Stmt{SQL: `UPDATE organisations SET name = name WHERE id = $1`, Args: []any{org}}
	if err := s.WriteBatchNoSeq(ctx, ins); err != nil {
		t.Fatal(err)
	}
	before = w.Snapshot()
	if err := s.WriteBatchNoSeq(ctx, ins); err != nil {
		t.Fatal(err)
	}
	if got := w.Since(before); got.RoundTrips != 1 {
		t.Fatalf("a one-statement write took %+v, want one round trip", got)
	}
	if got := seqs(t, s, org); len(got) != 2 {
		t.Fatalf("seqs %v", got)
	}
}
