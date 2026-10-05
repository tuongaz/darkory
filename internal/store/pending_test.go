package store_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Pending lists what Migrate would apply without applying or creating anything, and refuses a
// newer database as Migrate does.
func TestPendingListsWithoutApplying(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			s := storetest.OpenUnmigrated(t, e)
			ctx := t.Context()
			names := func(ms []store.Migration) []string {
				var out []string
				for _, m := range ms {
					out = append(out, m.String())
				}
				return out
			}

			p, err := s.PendingFS(ctx, setV2)
			if err != nil {
				t.Fatal(err)
			}
			if got := names(p); !slices.Equal(got, []string{"0001_first", "0002_second"}) {
				t.Fatalf("pending %v on a new database", got)
			}
			if _, err := s.Query(ctx, `SELECT version FROM schema_migrations`); err == nil {
				t.Fatal("Pending created schema_migrations")
			}

			if _, err := s.MigrateFS(ctx, setV1, now); err != nil {
				t.Fatal(err)
			}
			if p, err = s.PendingFS(ctx, setV2); err != nil || !slices.Equal(names(p), []string{"0002_second"}) {
				t.Fatalf("pending %v, %v after the first", names(p), err)
			}
			if _, err := s.MigrateFS(ctx, setV2, now); err != nil {
				t.Fatal(err)
			}
			if p, err = s.PendingFS(ctx, setV2); err != nil || len(p) != 0 {
				t.Fatalf("pending %v, %v when up to date", names(p), err)
			}
			if _, err := s.PendingFS(ctx, setV1); !errors.Is(err, store.ErrDatabaseNewer) {
				t.Fatalf("an older set against a newer database: %v", err)
			}
		})
	}
}
