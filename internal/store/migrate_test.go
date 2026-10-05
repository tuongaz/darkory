package store_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

var now = time.Date(2026, 10, 6, 9, 30, 0, 0, time.UTC)

func file(text string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(text)} }

// Version 1 is shared and has two statements; version 2 has a variant per engine.
var (
	setV1 = fstest.MapFS{
		"0001_first.sql": file(`CREATE TABLE things (id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE more_things (id TEXT NOT NULL PRIMARY KEY);`),
	}
	setV2 = fstest.MapFS{
		"0001_first.sql":           setV1["0001_first.sql"],
		"0002_second.sqlite.sql":   file(`CREATE TABLE engine (name TEXT NOT NULL); INSERT INTO engine VALUES ('sqlite');`),
		"0002_second.postgres.sql": file(`CREATE TABLE engine (name TEXT NOT NULL); INSERT INTO engine VALUES ('postgres');`),
	}
)

func TestMigrateAppliesTheEmbeddedSetOnce(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			s := storetest.OpenUnmigrated(t, e)
			res, err := s.Migrate(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) == 0 || res.Applied[0] != 1 {
				t.Fatalf("applied %v, want to start at 1", res.Applied)
			}
			if res.Backup != "" {
				t.Fatalf("backed up a new database to %s", res.Backup)
			}
			res, err = s.Migrate(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) != 0 || res.Backup != "" {
				t.Fatalf("second run did %+v, want nothing", res)
			}
		})
	}
}

func TestMigrateRunsTheVariantForItsEngine(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			s := storetest.OpenUnmigrated(t, e)
			res, err := s.MigrateFS(t.Context(), setV2, now)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) != 2 {
				t.Fatalf("applied %v, want [1 2]", res.Applied)
			}
			var name string
			if err := s.QueryRow(t.Context(), `SELECT name FROM engine`).Scan(&name); err != nil {
				t.Fatal(err)
			}
			if name != string(e) {
				t.Fatalf("ran the %s variant on %s", name, e)
			}
			// Both statements of the shared migration ran.
			if _, err := s.Query(t.Context(), `SELECT id FROM more_things`); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMigrateBacksUpTheSQLiteFileFirst(t *testing.T) {
	ctx := t.Context()
	s := storetest.OpenUnmigrated(t, store.SQLite)
	if _, err := s.MigrateFS(ctx, setV1, now); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MigrateFS(ctx, setV2, now); err != nil {
		t.Fatal(err)
	}
	// Nothing pending: no backup.
	res, err := s.MigrateFS(ctx, setV2, now)
	if err != nil || res.Backup != "" {
		t.Fatalf("res %+v err %v, want no backup", res, err)
	}

	s = storetest.OpenUnmigrated(t, store.SQLite)
	if _, err := s.MigrateFS(ctx, setV1, now); err != nil {
		t.Fatal(err)
	}
	res, err = s.MigrateFS(ctx, setV2, now)
	if err != nil {
		t.Fatal(err)
	}
	want := s.Path() + ".pre-0002.20261006T093000.000Z.bak"
	if res.Backup != want {
		t.Fatalf("backup %q, want %q", res.Backup, want)
	}
	// The backup is the database as it was before version 2.
	bak, err := sql.Open("sqlite", res.Backup)
	if err != nil {
		t.Fatal(err)
	}
	defer bak.Close()
	var top int
	if err := bak.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&top); err != nil {
		t.Fatal(err)
	}
	if top != 1 {
		t.Fatalf("backup holds migration %d, want 1", top)
	}
	if _, err := os.Stat(res.Backup); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateTakesNoBackupOnPostgres(t *testing.T) {
	s := storetest.OpenUnmigrated(t, store.Postgres)
	if _, err := s.MigrateFS(t.Context(), setV1, now); err != nil {
		t.Fatal(err)
	}
	res, err := s.MigrateFS(t.Context(), setV2, now)
	if err != nil {
		t.Fatal(err)
	}
	if res.Backup != "" {
		t.Fatalf("backup %q on Postgres", res.Backup)
	}
}

func TestMigrateRefusesANewerDatabase(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			if _, err := s.MigrateFS(ctx, setV2, now); err != nil {
				t.Fatal(err)
			}
			_, err := s.MigrateFS(ctx, setV1, now)
			if !errors.Is(err, store.ErrDatabaseNewer) {
				t.Fatalf("err = %v, want ErrDatabaseNewer", err)
			}
			if !strings.Contains(err.Error(), "0002") {
				t.Fatalf("error %q does not name the newer migration", err)
			}
		})
	}
}

func TestMigrateRefusesANewerDatabaseFromTheEmbeddedSet(t *testing.T) {
	storetest.Each(t, func(t *testing.T, s *store.Store) {
		ctx := t.Context()
		err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', 0)`)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Migrate(ctx); !errors.Is(err, store.ErrDatabaseNewer) {
			t.Fatalf("err = %v, want ErrDatabaseNewer", err)
		}
	})
}

func TestMigrationSetRules(t *testing.T) {
	ok := "CREATE TABLE t (id TEXT);"
	cases := map[string]fstest.MapFS{
		"missing variant": {"0001_a.sqlite.sql": file(ok)},
		"shared and variant": {
			"0001_a.sql": file(ok), "0001_a.sqlite.sql": file(ok), "0001_a.postgres.sql": file(ok),
		},
		"gap":       {"0001_a.sql": file(ok), "0003_c.sql": file(ok)},
		"two names": {"0001_a.sqlite.sql": file(ok), "0001_b.postgres.sql": file(ok)},
		"bad name":  {"1_a.sql": file(ok)},
		"no zero":   {"0000_a.sql": file(ok)},
	}
	for name, set := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := store.LoadMigrations(set, store.SQLite); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	got, err := store.LoadMigrations(setV2, store.Postgres)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %v, %v", got, err)
	}
}

// Two processes migrating one Postgres database at once apply each migration once.
func TestMigrateIsSerialisedOnPostgres(t *testing.T) {
	ctx := t.Context()
	dsn := storetest.DSN(t, store.Postgres)
	results := make(chan error, 4)
	for range 4 {
		go func() {
			s, err := store.Open(ctx, dsn)
			if err != nil {
				results <- err
				return
			}
			defer s.Close()
			_, err = s.Migrate(ctx)
			results <- err
		}()
	}
	for range 4 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	s, err := store.Open(context.WithoutCancel(ctx), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err := s.QueryRow(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = 1`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("migration 1 recorded %d times", n)
	}
}

// Migration 0002 widens claims.how_ended, which SQLite does by rebuilding the table: a Claim
// written under 0001 survives it, and the new value is accepted afterwards.
func TestMigration2KeepsClaims(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			first := fstest.MapFS{}
			for _, name := range []string{"0001_init.sql"} {
				b, err := os.ReadFile("migrations/" + name)
				if err != nil {
					t.Fatal(err)
				}
				first[name] = file(string(b))
			}
			if _, err := s.MigrateFS(ctx, first, now); err != nil {
				t.Fatal(err)
			}
			exec := func(q string) error {
				return s.WriteNoSeq(ctx, func(tx store.Tx) error {
					_, err := tx.Exec(ctx, q)
					return err
				})
			}
			for _, q := range []string{
				`INSERT INTO organisations (id, name, created_at) VALUES ('o', 'Acme', 0)`,
				`INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'o', 'ada', 'human', 0, 0)`,
				`INSERT INTO sessions (id, org_id, member_id, chosen_id, kind, created_at, last_seen_at) VALUES ('s', 'o', 'm', 'ada-1', 'token', 0, 0)`,
				`INSERT INTO teams (id, org_id, key_prefix, name, created_at) VALUES ('tm', 'o', 'WEB', 'Web', 0)`,
				`INSERT INTO features (id, org_id, team_id, display_key, title, owner_id, state, rank, filed_by, created_at) VALUES ('f', 'o', 'tm', 'WEB-1', 'F', 'm', 'open', 1, 'm', 0)`,
				`INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, state, filed_by, waiting_since, created_at) VALUES ('t', 'o', 'f', 'WEB-2', 'work', 'T', 'open', 'm', 0, 0)`,
				`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, timeout_ms, started_at, ended_at, how_ended, ended_by) VALUES ('c', 'o', 't', 'm', 's', 60000, 1, 2, 'session_closed', 'm')`,
			} {
				if err := exec(q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			if _, err := s.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			var how string
			var timeout, ended int64
			if err := s.QueryRow(ctx, `SELECT how_ended, timeout_ms, ended_at FROM claims WHERE id = 'c'`).Scan(&how, &timeout, &ended); err != nil ||
				how != "session_closed" || timeout != 60000 || ended != 2 {
				t.Fatalf("the Claim after the migration: %s %d %d %v", how, timeout, ended, err)
			}
			if err := exec(`UPDATE claims SET how_ended = 'member_deactivated' WHERE id = 'c'`); err != nil {
				t.Fatal(err)
			}
			if err := exec(`UPDATE claims SET how_ended = 'unheard_of' WHERE id = 'c'`); err == nil {
				t.Fatal("the check on how_ended is gone")
			}
		})
	}
}
