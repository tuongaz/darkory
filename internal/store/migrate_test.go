package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/google/uuid"
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

// Migration 0003 gives every Organisation of a database written under 0002 the six default
// Statuses, and every Task a Status by rule: done → Done, dropped → Dropped, open with a live
// Claim → In progress, else Todo, a lapsed Claim included.
func TestMigration3GivesTasksAStatus(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			upTo2 := fstest.MapFS{}
			for _, name := range []string{"0001_init.sql", "0002_member_deactivation.sqlite.sql", "0002_member_deactivation.postgres.sql"} {
				b, err := os.ReadFile("migrations/" + name)
				if err != nil {
					t.Fatal(err)
				}
				upTo2[name] = file(string(b))
			}
			if res, err := s.MigrateFS(ctx, upTo2, now); err != nil || len(res.Applied) != 2 {
				t.Fatalf("migrating to 0002: %+v %v", res, err)
			}
			exec := func(q string, args ...any) error {
				return s.WriteNoSeq(ctx, func(tx store.Tx) error {
					_, err := tx.Exec(ctx, q, args...)
					return err
				})
			}
			must := func(q string, args ...any) {
				t.Helper()
				if err := exec(q, args...); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			future, past := time.Now().Add(time.Hour).UnixMilli(), time.Now().Add(-time.Hour).UnixMilli()
			for _, org := range []string{"o1", "o2"} {
				must(`INSERT INTO organisations (id, name, created_at) VALUES ($1, $1, 0)`, org)
				must(`INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ($1, $2, 'ada', 'human', 0, 0)`, org+"-m", org)
				must(`INSERT INTO teams (id, org_id, key_prefix, name, created_at) VALUES ($1, $2, 'WEB', 'Web', 0)`, org+"-tm", org)
				must(`INSERT INTO features (id, org_id, team_id, display_key, title, owner_id, state, rank, filed_by, created_at)
VALUES ($1, $2, $3, 'WEB-1', 'F', $4, 'open', 1, $4, 0)`, org+"-f", org, org+"-tm", org+"-m")
			}
			task := func(id, state string, holder *string, expires *int64) {
				must(`INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, state, filed_by, waiting_since, created_at,
claim_holder_id, claim_expires_at) VALUES ($1, 'o1', 'o1-f', $1, 'work', 'T', $2, 'o1-m', 0, 0, $3, $4)`, id, state, holder, expires)
			}
			ada := "o1-m"
			task("done", "done", nil, nil)
			task("dropped", "dropped", nil, nil)
			task("held", "open", &ada, &future)
			task("held-no-timeout", "open", &ada, nil)
			task("lapsed", "open", &ada, &past)
			task("waiting", "open", nil, nil)

			res, err := s.Migrate(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) == 0 || res.Applied[0] != 3 {
				t.Fatalf("applied %v, want 3 first", res.Applied)
			}

			for _, org := range []string{"o1", "o2"} {
				rows, err := s.Query(ctx, `SELECT id, name, kind, position FROM statuses WHERE org_id = $1 ORDER BY position`, org)
				if err != nil {
					t.Fatal(err)
				}
				var got []string
				for rows.Next() {
					var id, name, kind string
					var pos int64
					if err := rows.Scan(&id, &name, &kind, &pos); err != nil {
						t.Fatal(err)
					}
					if u, err := uuid.Parse(id); err != nil || u.Version() != 7 || u.Variant() != uuid.RFC4122 {
						t.Errorf("Status %s has id %q, not shaped as a UUIDv7 (%v)", name, id, err)
					}
					got = append(got, fmt.Sprintf("%d %s %s", pos, name, kind))
				}
				rows.Close()
				want := []string{"1 Backlog backlog", "2 Todo todo", "3 In progress in_progress", "4 In review in_progress", "5 Done done", "6 Dropped dropped"}
				if !slices.Equal(got, want) {
					t.Errorf("%s's Statuses %q, want %q", org, got, want)
				}
			}
			for task, want := range map[string]string{
				"done": "Done", "dropped": "Dropped", "held": "In progress", "held-no-timeout": "In progress",
				"lapsed": "Todo", "waiting": "Todo",
			} {
				var name string
				if err := s.QueryRow(ctx, `SELECT s.name FROM tasks t JOIN statuses s ON s.id = t.status_id AND s.org_id = t.org_id WHERE t.id = $1`, task).
					Scan(&name); err != nil || name != want {
					t.Errorf("Task %s is in %q (%v), want %q", task, name, err, want)
				}
			}
			// A Status name is unique within an Organisation, and its kind is one of the five.
			if err := exec(`INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES ('x', 'o1', 'Todo', 'todo', 9, 0)`); err == nil {
				t.Error("a second Todo was accepted")
			}
			if err := exec(`INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES ('x', 'o1', 'Later', 'someday', 9, 0)`); err == nil {
				t.Error("a kind outside the five was accepted")
			}
		})
	}
}

// migrateTo applies the migrations in migrations/ numbered up to last, from their files.
func migrateTo(t *testing.T, s *store.Store, last int) {
	t.Helper()
	set := fstest.MapFS{}
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		var n int
		if _, err := fmt.Sscanf(e.Name(), "%04d_", &n); err != nil || n > last {
			continue
		}
		b, err := os.ReadFile("migrations/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		set[e.Name()] = file(string(b))
	}
	if res, err := s.MigrateFS(t.Context(), set, now); err != nil || len(res.Applied) != last {
		t.Fatalf("migrating to %04d: %+v %v", last, res, err)
	}
}

// Migration 0004 adds Workspaces and the agent settings to a database written under 0003: what
// is there keeps its rows, Teams and Features take the defaults (no default Workspace, nothing
// shipped when done, no quick Feature), Members have no agent settings, and the new tables take
// rows under their checks.
func TestMigration4AddsWorkspacesAndAgents(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			migrateTo(t, s, 3)
			exec := func(q string, args ...any) error {
				return s.WriteNoSeq(ctx, func(tx store.Tx) error {
					_, err := tx.Exec(ctx, q, args...)
					return err
				})
			}
			must := func(q string, args ...any) {
				t.Helper()
				if err := exec(q, args...); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			must(`INSERT INTO organisations (id, name, created_at) VALUES ('o', 'Acme', 0)`)
			must(`INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'o', 'ada', 'human', 0, 0)`)
			must(`INSERT INTO teams (id, org_id, key_prefix, name, created_at) VALUES ('tm', 'o', 'WEB', 'Web', 0)`)
			must(`INSERT INTO features (id, org_id, team_id, display_key, title, owner_id, state, rank, filed_by, created_at) VALUES ('f', 'o', 'tm', 'WEB-1', 'F', 'm', 'open', 1, 'm', 0)`)
			must(`INSERT INTO statuses (id, org_id, name, kind, position, created_at) VALUES ('st', 'o', 'Todo', 'todo', 1, 0)`)
			must(`INSERT INTO tasks (id, org_id, feature_id, display_key, kind, title, state, filed_by, waiting_since, created_at, status_id)
VALUES ('t', 'o', 'f', 'WEB-2', 'work', 'T', 'open', 'm', 0, 0, 'st')`)

			res, err := s.Migrate(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) == 0 || res.Applied[0] != 4 {
				t.Fatalf("applied %v, want 4 first", res.Applied)
			}

			var teamDefault sql.NullString
			var teamShip, quick, featureShip bool
			var agent sql.NullString
			if err := s.QueryRow(ctx, `SELECT default_workspace_id, ship_when_done FROM teams WHERE id = 'tm'`).Scan(&teamDefault, &teamShip); err != nil ||
				teamDefault.Valid || teamShip {
				t.Errorf("the Team after the migration: %v %v %v", teamDefault, teamShip, err)
			}
			if err := s.QueryRow(ctx, `SELECT quick, ship_when_done FROM features WHERE id = 'f'`).Scan(&quick, &featureShip); err != nil || quick || featureShip {
				t.Errorf("the Feature after the migration: quick %v, ship_when_done %v, %v", quick, featureShip, err)
			}
			if err := s.QueryRow(ctx, `SELECT agent FROM members WHERE id = 'm'`).Scan(&agent); err != nil || agent.Valid {
				t.Errorf("the Member after the migration: agent %v, %v", agent, err)
			}

			must(`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws', 'o', 'web', 'git', '/src/web', 'plain', 'main', 0)`)
			must(`INSERT INTO task_workspaces (org_id, task_id, workspace_id, position) VALUES ('o', 't', 'ws', 1)`)
			must(`UPDATE teams SET default_workspace_id = 'ws', ship_when_done = TRUE WHERE id = 'tm'`)
			must(`UPDATE features SET quick = TRUE, ship_when_done = TRUE WHERE id = 'f'`)
			must(`UPDATE members SET agent = '{"command":"claude"}' WHERE id = 'm'`)
			for _, q := range []string{
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws2', 'o', 'web', 'git', '/src/x', 'plain', 'main', 0)`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws3', 'o', 'svn', 'svn', '/src/x', 'plain', 'main', 0)`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws4', 'o', 'pr', 'git', '/src/x', 'merge_queue', 'main', 0)`,
				`INSERT INTO task_workspaces (org_id, task_id, workspace_id, position) VALUES ('o', 't', 'ws', 2)`,
			} {
				if err := exec(q); err == nil {
					t.Errorf("accepted: %s", q)
				}
			}
		})
	}
}

// Migration 0005 adds Views to a database written under 0004: what is there keeps its rows, and
// the new table takes a View of either list, with or without a Team, under its checks.
func TestMigration5AddsViews(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			migrateTo(t, s, 4)
			exec := func(q string, args ...any) error {
				return s.WriteNoSeq(ctx, func(tx store.Tx) error {
					_, err := tx.Exec(ctx, q, args...)
					return err
				})
			}
			must := func(q string, args ...any) {
				t.Helper()
				if err := exec(q, args...); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			must(`INSERT INTO organisations (id, name, created_at) VALUES ('o', 'Acme', 0)`)
			must(`INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'o', 'ada', 'human', 0, 0)`)
			must(`INSERT INTO teams (id, org_id, key_prefix, name, created_at) VALUES ('tm', 'o', 'WEB', 'Web', 0)`)

			res, err := s.Migrate(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Applied) == 0 || res.Applied[0] != 5 {
				t.Fatalf("applied %v, want 5 first", res.Applied)
			}
			var teams int
			if err := s.QueryRow(ctx, `SELECT COUNT(*) FROM teams WHERE id = 'tm'`).Scan(&teams); err != nil || teams != 1 {
				t.Fatalf("the Team after the migration: %d %v", teams, err)
			}

			must(`INSERT INTO views (id, org_id, member_id, entity, team_id, name, filters, sort, display, created_at, updated_at)
VALUES ('v1', 'o', 'm', 'tasks', 'tm', 'Mine', '["holder:is:none"]', 'rank', '{"layout":"board"}', 0, 0)`)
			must(`INSERT INTO views (id, org_id, member_id, entity, name, filters, created_at, updated_at)
VALUES ('v2', 'o', 'm', 'features', 'Mine', '[]', 0, 0)`)
			for _, q := range []string{
				`INSERT INTO views (id, org_id, member_id, entity, name, filters, created_at, updated_at) VALUES ('v3', 'o', 'm', 'members', 'x', '[]', 0, 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, name, created_at, updated_at) VALUES ('v4', 'o', 'm', 'tasks', 'x', 0, 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, team_id, name, filters, created_at, updated_at) VALUES ('v5', 'o', 'm', 'tasks', 'nope', 'x', '[]', 0, 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, name, filters, created_at, updated_at) VALUES ('v6', 'o', 'nobody', 'tasks', 'x', '[]', 0, 0)`,
			} {
				if err := exec(q); err == nil {
					t.Errorf("accepted: %s", q)
				}
			}
		})
	}
}
