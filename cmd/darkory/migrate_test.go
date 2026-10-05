package main

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// `darkory migrate --dry-run` lists the pending migrations and changes nothing; `darkory migrate`
// applies them; both, and serve, refuse a database newer than the binary.
func TestMigrate(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			dsn := storetest.DSN(t, e)
			migrate := func(args ...string) (string, error) {
				var out bytes.Buffer
				err := run(append([]string{"migrate", "--db", dsn}, args...), &out, io.Discard)
				return out.String(), err
			}
			out, err := migrate("--dry-run")
			if err != nil || !strings.Contains(out, "2 pending migration(s), not applied:\n  0001_init\n  0002_member_deactivation\n") {
				t.Fatalf("dry run: %v\n%s", err, out)
			}
			st, err := store.Open(t.Context(), dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			if pending, err := st.Pending(t.Context()); err != nil || len(pending) != 2 {
				t.Fatalf("after a dry run, pending %v, %v", pending, err)
			}

			out, err = migrate()
			if err != nil || !strings.Contains(out, "Applied 0001_init\nApplied 0002_member_deactivation\n") {
				t.Fatalf("migrate: %v\n%s", err, out)
			}
			out, err = migrate()
			if err != nil || out != "No pending migrations.\n" {
				t.Fatalf("migrate again: %v\n%s", err, out)
			}

			rows, err := st.Query(t.Context(), `INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', 0)`)
			if err != nil {
				t.Fatal(err)
			}
			rows.Close()
			for _, args := range [][]string{nil, {"--dry-run"}} {
				if _, err := migrate(args...); !errors.Is(err, store.ErrDatabaseNewer) {
					t.Fatalf("migrate %v of a newer database: %v", args, err)
				}
			}
			for _, migrateAtStart := range []bool{true, false} {
				_, err := openStore(t.Context(), config.Store{DataDir: t.TempDir(), Database: dsn}, migrateAtStart, slog.New(slog.DiscardHandler))
				if !errors.Is(err, store.ErrDatabaseNewer) {
					t.Fatalf("serve (migrate at start %v) of a newer database: %v", migrateAtStart, err)
				}
			}
		})
	}
}

// migrate creates the data directory of a new SQLite Install, as serve does.
func TestMigrateCreatesTheDataDirectory(t *testing.T) {
	dir := t.TempDir() + "/new/data"
	var out bytes.Buffer
	if err := run([]string{"migrate", "--data", dir}, &out, io.Discard); err != nil || !strings.Contains(out.String(), "Applied 0001_init") {
		t.Fatalf("%v\n%s", err, out.String())
	}
}

// serve on Postgres refuses to start while migrations are pending, unless told to apply them.
func TestServeOnPostgresRefusesPendingMigrations(t *testing.T) {
	dsn := storetest.DSN(t, store.Postgres)
	cfg := config.Store{DataDir: t.TempDir(), Database: dsn}
	log := slog.New(slog.DiscardHandler)
	_, err := openStore(t.Context(), cfg, false, log)
	if err == nil || !strings.Contains(err.Error(), "0001_init") || !strings.Contains(err.Error(), "darkory migrate") {
		t.Fatalf("serve with pending migrations: %v", err)
	}
	st, err := openStore(t.Context(), cfg, true, log)
	if err != nil {
		t.Fatalf("serve --migrate: %v", err)
	}
	st.Close()
	st, err = openStore(t.Context(), cfg, false, log)
	if err != nil {
		t.Fatalf("serve once migrated: %v", err)
	}
	st.Close()
}

// serve decides from the engine whether to migrate at start.
func TestServeMigratesSQLiteAtStart(t *testing.T) {
	for _, c := range []struct {
		args []string
		db   string
		want bool
	}{
		{nil, "x.db", true},
		{nil, "postgres://db/dk", false},
		{[]string{"--migrate"}, "postgres://db/dk", true},
	} {
		cfg, err := config.LoadServe(append(c.args, "--db", c.db), func(string) string { return "" }, io.Discard)
		if err != nil {
			t.Fatal(err)
		}
		if got := migrateAtStart(cfg); got != c.want {
			t.Errorf("%v %s: migrate at start %v", c.args, c.db, got)
		}
	}
}
