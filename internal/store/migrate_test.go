package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"regexp"
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

// SQLite migrates with foreign keys off, and the connection it used enforces them again after.
func TestMigratingLeavesForeignKeysEnforced(t *testing.T) {
	ctx := t.Context()
	s := storetest.OpenUnmigrated(t, store.SQLite, store.WithMaxConns(1))
	if _, err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'nope', 'm', 'human', 0, 0)`)
		return err
	})
	if err == nil {
		t.Fatal("a Member of no Organisation was accepted after migrating")
	}
}

// The schema's checks and keys refuse what the record cannot hold, on both engines alike.
func TestTheSchemaHoldsItsChecks(t *testing.T) {
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			if _, err := s.Migrate(ctx); err != nil {
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
				`INSERT INTO members (id, org_id, name, kind, created_at, updated_at, agent) VALUES ('m', 'o', 'ada', 'human', 0, 0, NULL)`,
				`INSERT INTO sessions (id, org_id, member_id, chosen_id, kind, created_at, last_seen_at) VALUES ('s', 'o', 'm', 'ada-1', 'token', 0, 0)`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws', 'o', 'web', 'git', '/src/web', 'plain', 'main', 0)`,
				`INSERT INTO projects (id, org_id, key_prefix, name, default_workspace_id, created_at) VALUES ('p', 'o', 'WEB', 'Web', 'ws', 0)`,
				`INSERT INTO skills (id, org_id, name, kind, current_version, created_at) VALUES ('sk', 'o', 'engineer', 'generic', 1, 0)`,
				`INSERT INTO workflows (id, org_id, project_id, name, position, created_at) VALUES ('wf', 'o', 'p', 'Work', 1, 0)`,
				`INSERT INTO steps (id, org_id, project_id, workflow_id, name, skill_id, position, x, y, created_at) VALUES ('st', 'o', 'p', 'wf', 'Build', 'sk', 1, 0, 0, 0)`,
				`INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at) VALUES ('cn', 'o', 'p', 'st', NULL, 'pass', 1, 0)`,
				`INSERT INTO tasks (id, org_id, project_id, display_key, kind, title, state, step_id, owner_id, rank, waiting_since, created_at)
VALUES ('t', 'o', 'p', 'WEB-1', 'work', 'T', 'open', 'st', 'm', 1, 0, 0)`,
				`INSERT INTO tasks (id, org_id, project_id, parent_id, display_key, kind, title, state, step_id, owner_id, waiting_since, created_at)
VALUES ('sub', 'o', 'p', 't', 'WEB-2', 'acceptance', 'A', 'open', 'st', 'm', 0, 0)`,
				`INSERT INTO labels (id, org_id, project_id, name, color, created_at) VALUES ('l', 'o', NULL, 'client', '#00ff00', 0)`,
				`INSERT INTO task_labels (org_id, task_id, label_id) VALUES ('o', 't', 'l')`,
				`INSERT INTO task_workspaces (org_id, task_id, workspace_id, position) VALUES ('o', 't', 'ws', 1)`,
				`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, started_at, ended_at, how_ended) VALUES ('c', 'o', 't', 'm', 's', 0, 1, 'split')`,
				`INSERT INTO views (id, org_id, member_id, entity, project_id, name, filters, created_at, updated_at) VALUES ('v', 'o', 'm', 'tasks', 'p', 'Mine', '[]', 0, 0)`,
			} {
				if err := exec(q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			for _, q := range []string{
				`UPDATE claims SET how_ended = 'handed_over' WHERE id = 'c'`,
				`UPDATE tasks SET kind = 'feature' WHERE id = 't'`,
				`UPDATE tasks SET state = 'shipped' WHERE id = 't'`,
				`UPDATE tasks SET parent_id = 'nope' WHERE id = 'sub'`,
				`INSERT INTO steps (id, org_id, project_id, workflow_id, name, position, x, y, created_at) VALUES ('st2', 'o', 'p', 'wf', 'Build', 2, 0, 0, 0)`,
				`INSERT INTO steps (id, org_id, project_id, name, position, x, y, created_at) VALUES ('st3', 'o', 'p', 'Ship', 3, 0, 0, 0)`,
				`INSERT INTO steps (id, org_id, project_id, workflow_id, name, position, x, y, created_at) VALUES ('st4', 'o', 'p', 'nope', 'Ship', 3, 0, 0, 0)`,
				`INSERT INTO workflows (id, org_id, project_id, name, position, created_at) VALUES ('wf2', 'o', 'p', 'Work', 2, 0)`,
				`UPDATE tasks SET last_step_id = 'nope' WHERE id = 't'`,
				`INSERT INTO connectors (id, org_id, project_id, from_step_id, name, position, created_at) VALUES ('cn2', 'o', 'p', 'st', 'pass', 2, 0)`,
				`INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at) VALUES ('cn3', 'o', 'p', 'st', 'nope', 'back', 2, 0)`,
				`INSERT INTO task_labels (org_id, task_id, label_id) VALUES ('o', 't', 'nope')`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws2', 'o', 'web', 'git', '/src/x', 'plain', 'main', 0)`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws3', 'o', 'svn', 'svn', '/src/x', 'plain', 'main', 0)`,
				`INSERT INTO workspaces (id, org_id, name, kind, path, mode, default_branch, created_at) VALUES ('ws4', 'o', 'pr', 'git', '/src/x', 'merge_queue', 'main', 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, name, filters, created_at, updated_at) VALUES ('v2', 'o', 'm', 'features', 'x', '[]', 0, 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, project_id, name, filters, created_at, updated_at) VALUES ('v3', 'o', 'm', 'tasks', 'nope', 'x', '[]', 0, 0)`,
				`INSERT INTO views (id, org_id, member_id, entity, name, created_at, updated_at) VALUES ('v4', 'o', 'm', 'tasks', 'x', 0, 0)`,
				`UPDATE projects SET color = 12 WHERE id = 'p'`,
				`UPDATE projects SET color = -1 WHERE id = 'p'`,
			} {
				if err := exec(q); err == nil {
					t.Errorf("accepted: %s", q)
				}
			}
		})
	}
}

// Migration 0005 gives the Projects already in a database their colours in the order they were
// created, per Organisation, by the rule a new Project takes its colour by: the hue farthest from
// those already taken, the lowest on a tie (0 6 3 9 1 2 4 5 7 8 10 11, then again).
func TestMigration0005ColoursTheProjectsInCreationOrder(t *testing.T) {
	before := fstest.MapFS{}
	for _, name := range []string{"0001_init.sql", "0002_project_seen.sql", "0003_files.sql", "0004_sessions_by_member.sql"} {
		data, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: data}
	}
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			if _, err := s.MigrateFS(ctx, before, now); err != nil {
				t.Fatal(err)
			}
			// Two Organisations: fourteen Projects in one, created out of key order and two at the
			// same moment (the id breaks the tie), and two in the other.
			err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
				for _, o := range []string{"o1", "o2"} {
					if _, err := tx.Exec(ctx, `INSERT INTO organisations (id, name, created_at) VALUES ($1, $1, 0)`, o); err != nil {
						return err
					}
				}
				for i := range 14 {
					created := []int{5, 1, 3, 3, 9, 2, 11, 4, 12, 13, 6, 10, 7, 8}[i]
					id, key := fmt.Sprintf("p%02d", i), fmt.Sprintf("K%02d", i)
					if _, err := tx.Exec(ctx, `INSERT INTO projects (id, org_id, key_prefix, name, created_at) VALUES ($1, 'o1', $2, $2, $3)`, id, key, created); err != nil {
						return err
					}
				}
				for i, id := range []string{"q1", "q0"} {
					if _, err := tx.Exec(ctx, `INSERT INTO projects (id, org_id, key_prefix, name, created_at) VALUES ($1, 'o2', $1, $1, $2)`, id, i); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			got := map[string][]int{}
			rows, err := s.Query(ctx, `SELECT org_id, color FROM projects ORDER BY org_id, created_at, id`)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			for rows.Next() {
				var org string
				var color int
				if err := rows.Scan(&org, &color); err != nil {
					t.Fatal(err)
				}
				got[org] = append(got[org], color)
			}
			want := map[string][]int{"o1": {0, 6, 3, 9, 1, 2, 4, 5, 7, 8, 10, 11, 0, 6}, "o2": {0, 6}}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("colours %v, want %v", got, want)
			}
		})
	}
}

// Migration 0006 gives every Project one Workflow named Work holding all its Steps, and gives an
// ended Task the Step it ended at, read from the newest task.completed or task.dropped entry of
// its Activity, when that Step still exists.
func TestMigration0006NamesTheWorkflowAndKeepsTheLastStep(t *testing.T) {
	before := fstest.MapFS{}
	for _, name := range []string{"0001_init.sql", "0002_project_seen.sql", "0003_files.sql", "0004_sessions_by_member.sql", "0005_project_color.sql"} {
		data, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		before[name] = &fstest.MapFile{Data: data}
	}
	for _, e := range storetest.Engines() {
		t.Run(string(e), func(t *testing.T) {
			ctx := t.Context()
			s := storetest.OpenUnmigrated(t, e)
			if _, err := s.MigrateFS(ctx, before, now); err != nil {
				t.Fatal(err)
			}
			err := s.WriteNoSeq(ctx, func(tx store.Tx) error {
				for _, q := range []string{
					`INSERT INTO organisations (id, name, created_at) VALUES ('o', 'Acme', 0)`,
					`INSERT INTO members (id, org_id, name, kind, created_at, updated_at) VALUES ('m', 'o', 'ada', 'human', 0, 0)`,
					`INSERT INTO projects (id, org_id, key_prefix, name, created_at) VALUES ('p1', 'o', 'ONE', 'One', 10)`,
					`INSERT INTO projects (id, org_id, key_prefix, name, created_at) VALUES ('p2', 'o', 'TWO', 'Two', 20)`,
					`INSERT INTO steps (id, org_id, project_id, name, position, x, y, created_at) VALUES ('s1a', 'o', 'p1', 'Build', 1, 0, 0, 0)`,
					`INSERT INTO steps (id, org_id, project_id, name, position, x, y, created_at) VALUES ('s1b', 'o', 'p1', 'Review', 2, 0, 0, 0)`,
					`INSERT INTO steps (id, org_id, project_id, name, position, x, y, created_at) VALUES ('s2', 'o', 'p2', 'Build', 1, 0, 0, 0)`,
					// Open at a Step, with an older ending in its Activity: an open Task keeps none.
					`INSERT INTO tasks (id, org_id, project_id, display_key, kind, title, state, step_id, owner_id, rank, waiting_since, created_at)
VALUES ('open', 'o', 'p1', 'ONE-1', 'work', 'Open', 'open', 's1a', 'm', 1, 0, 0)`,
					// Done: its newest ending left s1b; an older one left s1a.
					`INSERT INTO tasks (id, org_id, project_id, display_key, kind, title, state, owner_id, rank, waiting_since, created_at, ended_at)
VALUES ('done', 'o', 'p1', 'ONE-2', 'work', 'Done', 'done', 'm', 2, 0, 0, 5)`,
					// Dropped from a Step that no longer exists.
					`INSERT INTO tasks (id, org_id, project_id, display_key, kind, title, state, owner_id, rank, waiting_since, created_at, ended_at)
VALUES ('ghost', 'o', 'p2', 'TWO-1', 'work', 'Ghost', 'dropped', 'm', 1, 0, 0, 5)`,
					`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES ('o', 1, 'm', 'task.dropped', 'open', '{"from":"s1b","since":1}', 1)`,
					`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES ('o', 2, 'm', 'task.completed', 'done', '{"from":"s1a","since":1}', 2)`,
					`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES ('o', 3, 'm', 'task.completed', 'done', '{"from":"s1b","since":1}', 3)`,
					`INSERT INTO activity (org_id, seq, actor_id, kind, subject_id, payload, at) VALUES ('o', 4, 'm', 'task.dropped', 'ghost', '{"from":"gone","since":1}', 4)`,
				} {
					if _, err := tx.Exec(ctx, q); err != nil {
						return fmt.Errorf("%s: %w", q, err)
					}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Migrate(ctx); err != nil {
				t.Fatal(err)
			}

			workflow := map[string]string{} // project → its Workflow
			rows, err := s.Query(ctx, `SELECT id, org_id, project_id, name, position FROM workflows ORDER BY project_id`)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var id, org, project, name string
				var position int
				if err := rows.Scan(&id, &org, &project, &name, &position); err != nil {
					t.Fatal(err)
				}
				if org != "o" || name != "Work" || position != 1 {
					t.Errorf("Project %s's Workflow is org %s, %q at %d; want o, Work at 1", project, org, name, position)
				}
				// A UUIDv7 whose time is its Project's created_at (10 and 20).
				if !regexp.MustCompile(`^0{8}-00(0a|14)-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
					t.Errorf("Project %s's Workflow id %q is not a UUIDv7 of the Project's created_at", project, id)
				}
				if workflow[project] != "" {
					t.Errorf("Project %s has two Workflows", project)
				}
				workflow[project] = id
			}
			rows.Close()
			if len(workflow) != 2 || workflow["p1"] == "" || workflow["p2"] == "" || workflow["p1"] == workflow["p2"] {
				t.Fatalf("Workflows %v, want one each for p1 and p2", workflow)
			}

			rows, err = s.Query(ctx, `SELECT id, project_id, workflow_id FROM steps ORDER BY id`)
			if err != nil {
				t.Fatal(err)
			}
			n := 0
			for rows.Next() {
				var id, project, wf string
				if err := rows.Scan(&id, &project, &wf); err != nil {
					t.Fatal(err)
				}
				if wf != workflow[project] {
					t.Errorf("Step %s is in Workflow %s, want %s", id, wf, workflow[project])
				}
				n++
			}
			rows.Close()
			if n != 3 {
				t.Fatalf("%d Steps after migrating, want 3", n)
			}

			last := map[string]string{}
			rows, err = s.Query(ctx, `SELECT id, last_step_id FROM tasks`)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var id string
				var step sql.NullString
				if err := rows.Scan(&id, &step); err != nil {
					t.Fatal(err)
				}
				last[id] = step.String
			}
			rows.Close()
			if want := map[string]string{"open": "", "done": "s1b", "ghost": ""}; fmt.Sprint(last) != fmt.Sprint(want) {
				t.Fatalf("last_step_id %v, want %v", last, want)
			}

			index := `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = $1`
			if e == store.Postgres {
				index = `SELECT COUNT(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`
			}
			for _, name := range []string{"steps_project_name", "steps_workflow", "workflows_project_name"} {
				var n int
				if err := s.QueryRow(ctx, index, name).Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n != 1 {
					t.Errorf("index %s: %d, want 1", name, n)
				}
			}
		})
	}
}
