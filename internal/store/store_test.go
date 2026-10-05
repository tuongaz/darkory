package store_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

var errRefused = errors.New("refused on purpose")

func insertActivity(ctx context.Context, tx store.Tx, orgID string, seq int64, kind string) error {
	_, err := tx.Exec(ctx, `INSERT INTO activity (org_id, seq, kind, subject_id, payload, at) VALUES ($1, $2, $3, $4, '{}', $5)`,
		orgID, seq, kind, store.NewID(), time.Now().UnixMilli())
	return err
}

// Concurrent writes to one Organisation get gapless sequence numbers in commit order, with no
// "database is locked" on SQLite, and a write that rolls back gives its number back.
func TestWriteNumbersActivityInCommitOrder(t *testing.T) {
	const writers, perWriter = 50, 8
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		org := storetest.Organisation(t, s)

		var mu sync.Mutex
		var errs []error
		committed := 0
		var wg sync.WaitGroup
		for w := range writers {
			wg.Go(func() {
				for i := range perWriter {
					refuse := (w+i)%5 == 0
					err := s.Write(ctx, org, func(tx store.Tx, seq int64) error {
						// Holding the counter means every earlier number has committed, so the
						// highest visible sequence is exactly the one before ours.
						var last int64
						if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM activity WHERE org_id = $1`, org).Scan(&last); err != nil {
							return err
						}
						if last != seq-1 {
							return fmt.Errorf("took %d while %d was the last committed", seq, last)
						}
						if err := insertActivity(ctx, tx, org, seq, "test.write"); err != nil {
							return err
						}
						if refuse {
							return errRefused
						}
						return nil
					})
					mu.Lock()
					switch {
					case err == nil:
						committed++
					case !errors.Is(err, errRefused):
						errs = append(errs, err)
					}
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		for _, err := range errs {
			t.Error(err)
		}

		var seqs []int64
		rows, err := s.Query(ctx, `SELECT seq FROM activity WHERE org_id = $1 ORDER BY seq`, org)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var v int64
			if err := rows.Scan(&v); err != nil {
				t.Fatal(err)
			}
			seqs = append(seqs, v)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		if len(seqs) != committed {
			t.Fatalf("%d Activity rows for %d committed writes", len(seqs), committed)
		}
		for i, v := range seqs {
			if v != int64(i+1) {
				t.Fatalf("sequence has a gap: position %d holds %d", i+1, v)
			}
		}
		var counter int64
		if err := s.QueryRow(ctx, `SELECT seq FROM organisations WHERE id = $1`, org).Scan(&counter); err != nil {
			t.Fatal(err)
		}
		if counter != int64(committed) {
			t.Fatalf("counter is %d after %d committed writes", counter, committed)
		}
		if committed == 0 || committed == writers*perWriter {
			t.Fatalf("expected some writes refused and some committed, got %d committed", committed)
		}
	})
}

func TestWriteRollsBackWhenTheCallbackPanics(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		org := storetest.Organisation(t, s)

		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("panic did not propagate")
				}
			}()
			_ = s.Write(ctx, org, func(tx store.Tx, seq int64) error {
				if err := insertActivity(ctx, tx, org, seq, "test.panic"); err != nil {
					return err
				}
				panic("boom")
			})
		}()

		// The lock was released and the number given back.
		var got int64
		err := s.Write(ctx, org, func(tx store.Tx, seq int64) error {
			got = seq
			return insertActivity(ctx, tx, org, seq, "test.after")
		})
		if err != nil {
			t.Fatal(err)
		}
		if got != 1 {
			t.Fatalf("seq after a panicked write = %d, want 1", got)
		}
	})
}

func TestWriteToAnUnknownOrganisation(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		called := false
		err := s.Write(t.Context(), store.NewID(), func(store.Tx, int64) error {
			called = true
			return nil
		})
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
		if called {
			t.Fatal("callback ran for an unknown Organisation")
		}
	})
}

func TestWriteNoSeqTakesNoNumber(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		org := storetest.Organisation(t, s)
		err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE organisations SET name = $1 WHERE id = $2`, "Renamed", org)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		var name string
		var seq int64
		if err := s.QueryRow(ctx, `SELECT name, seq FROM organisations WHERE id = $1`, org).Scan(&name, &seq); err != nil {
			t.Fatal(err)
		}
		if name != "Renamed" || seq != 0 {
			t.Fatalf("name %q seq %d, want Renamed and 0", name, seq)
		}
	})
}

// One query text runs on both engines: $N placeholders may repeat and come in any order.
func TestPlaceholdersAreShared(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		var got string
		err := s.QueryRow(t.Context(), `SELECT CAST($2 AS TEXT) || CAST($1 AS TEXT) || CAST($2 AS TEXT)`, "a", "b").Scan(&got)
		if err != nil {
			t.Fatal(err)
		}
		if got != "bab" {
			t.Fatalf("got %q, want bab", got)
		}
	})
}

func TestNewIDsSortByCreation(t *testing.T) {
	ids := make([]string, 100)
	for i := range ids {
		ids[i] = store.NewID()
	}
	if !slices.IsSorted(ids) {
		t.Fatal("ids do not sort in creation order")
	}
	if strings.Count(ids[0], "-") != 4 || ids[0][14] != '7' {
		t.Fatalf("%q is not a UUIDv7", ids[0])
	}
}
