package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"
	"time"
)

// Migrations are one numbered set for both engines (ADR 0009). A migration is NNNN_name.sql when
// one text serves both engines, or NNNN_name.sqlite.sql and NNNN_name.postgres.sql under one
// number when it cannot. Numbers start at 0001 and leave no gaps.
//
//go:embed migrations/*.sql
var embedded embed.FS

// ErrDatabaseNewer reports that the database has a migration this binary does not know: a newer
// release wrote it. The binary refuses to run against it.
var ErrDatabaseNewer = errors.New("store: the database is newer than this binary")

// MigrateResult says what Migrate did.
type MigrateResult struct {
	// Applied lists the migration numbers applied, in order.
	Applied []int
	// Backup is the copy of the SQLite file taken before applying them; empty when none was
	// needed (Postgres, a new database, or nothing to apply).
	Backup string
}

type migration struct {
	version int
	name    string
	text    string
}

var migrationName = regexp.MustCompile(`^(\d{4})_([a-z0-9_]+?)(?:\.(sqlite|postgres))?\.sql$`)

// pgMigrateLock is the Postgres advisory lock key held while migrating, so two processes never
// migrate at once. It spells "darkory".
const pgMigrateLock = 0x6461726b6f7279

// Migrate brings the schema up to date with the migrations embedded in the binary. On SQLite it
// first copies the database file when there is anything to apply to an existing schema. It
// refuses with ErrDatabaseNewer when the database has a migration the binary does not know.
func (s *Store) Migrate(ctx context.Context) (MigrateResult, error) {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		return MigrateResult{}, err
	}
	return s.migrate(ctx, sub, time.Now())
}

func (s *Store) migrate(ctx context.Context, fsys fs.FS, now time.Time) (MigrateResult, error) {
	var res MigrateResult
	known, err := loadMigrations(fsys, s.engine)
	if err != nil {
		return res, err
	}

	// One connection throughout, so the Postgres advisory lock is held for the whole run.
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return res, fmt.Errorf("store: migrate: %w", err)
	}
	defer conn.Close()
	if s.engine == Postgres {
		if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, int64(pgMigrateLock)); err != nil {
			return res, fmt.Errorf("store: migrate: lock: %w", err)
		}
		defer conn.ExecContext(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, int64(pgMigrateLock))
	}

	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
    version    BIGINT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at BIGINT NOT NULL
)`); err != nil {
		return res, fmt.Errorf("store: migrate: %w", err)
	}
	applied, err := appliedVersions(ctx, conn)
	if err != nil {
		return res, err
	}
	if len(applied) > 0 && applied[len(applied)-1] > len(known) {
		return res, fmt.Errorf("%w: it has migration %04d, and this binary knows up to %04d",
			ErrDatabaseNewer, applied[len(applied)-1], len(known))
	}
	done := make(map[int]bool, len(applied))
	for _, v := range applied {
		done[v] = true
	}
	var pending []migration
	for _, m := range known {
		if !done[m.version] {
			pending = append(pending, m)
		}
	}
	if len(pending) == 0 {
		return res, nil
	}

	if s.engine == SQLite && len(applied) > 0 {
		res.Backup = fmt.Sprintf("%s.pre-%04d.%s.bak", s.path, pending[0].version, now.UTC().Format("20060102T150405.000Z"))
		if _, err := conn.ExecContext(ctx, `VACUUM INTO $1`, res.Backup); err != nil {
			return res, fmt.Errorf("store: migrate: back up %s: %w", s.path, err)
		}
	}

	for _, m := range pending {
		if err := applyMigration(ctx, conn, m, now); err != nil {
			return res, err
		}
		res.Applied = append(res.Applied, m.version)
	}
	return res, nil
}

func applyMigration(ctx context.Context, conn *sql.Conn, m migration, now time.Time) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: migration %04d: %w", m.version, err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, m.text); err != nil {
		return fmt.Errorf("store: migration %04d_%s: %w", m.version, m.name, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)`,
		m.version, m.name, now.UnixMilli()); err != nil {
		return fmt.Errorf("store: migration %04d: record: %w", m.version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: migration %04d: commit: %w", m.version, err)
	}
	return nil
}

func appliedVersions(ctx context.Context, conn *sql.Conn) ([]int, error) {
	rows, err := conn.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("store: read migrations: %w", err)
	}
	defer rows.Close()
	var vs []int
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		vs = append(vs, v)
	}
	return vs, rows.Err()
}

// loadMigrations reads the migration set from fsys and returns engine's text for each number,
// in order. It rejects a set that breaks the naming rules, so a mistake fails every test rather
// than one engine in production.
func loadMigrations(fsys fs.FS, engine Engine) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("store: read migrations: %w", err)
	}
	type files struct {
		name                     string
		shared, sqlite, postgres string // file names
	}
	byVersion := map[int]*files{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		parts := migrationName.FindStringSubmatch(e.Name())
		if parts == nil {
			return nil, fmt.Errorf("store: migration file %q: want NNNN_name.sql or NNNN_name.{sqlite,postgres}.sql", e.Name())
		}
		v, _ := strconv.Atoi(parts[1])
		f := byVersion[v]
		if f == nil {
			f = &files{name: parts[2]}
			byVersion[v] = f
		}
		if f.name != parts[2] {
			return nil, fmt.Errorf("store: migration %04d has two names, %q and %q", v, f.name, parts[2])
		}
		switch parts[3] {
		case "":
			f.shared = e.Name()
		case "sqlite":
			f.sqlite = e.Name()
		case "postgres":
			f.postgres = e.Name()
		}
	}

	versions := make([]int, 0, len(byVersion))
	for v := range byVersion {
		versions = append(versions, v)
	}
	sort.Ints(versions)
	out := make([]migration, 0, len(versions))
	for i, v := range versions {
		if v != i+1 {
			return nil, fmt.Errorf("store: migration %04d is missing", i+1)
		}
		f := byVersion[v]
		var file string
		switch {
		case f.shared != "" && (f.sqlite != "" || f.postgres != ""):
			return nil, fmt.Errorf("store: migration %04d has both a shared file and engine variants", v)
		case f.shared != "":
			file = f.shared
		case f.sqlite == "" || f.postgres == "":
			return nil, fmt.Errorf("store: migration %04d needs both a .sqlite.sql and a .postgres.sql variant", v)
		case engine == SQLite:
			file = f.sqlite
		default:
			file = f.postgres
		}
		text, err := fs.ReadFile(fsys, file)
		if err != nil {
			return nil, fmt.Errorf("store: read migration %s: %w", file, err)
		}
		out = append(out, migration{version: v, name: f.name, text: string(text)})
	}
	return out, nil
}
