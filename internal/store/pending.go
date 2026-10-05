package store

import (
	"context"
	"fmt"
	"io/fs"
)

// Migration names one numbered migration.
type Migration struct {
	Version int
	Name    string
}

func (m Migration) String() string { return fmt.Sprintf("%04d_%s", m.Version, m.Name) }

// Pending lists the migrations the database lacks, in order, without applying any or creating
// anything. Like Migrate, it refuses with ErrDatabaseNewer when the database has a migration the
// binary does not know. `darkory migrate --dry-run` prints it, and `serve` on Postgres refuses to
// start while it is not empty (ADR 0009: Cloud migrates as its own step before a rollout).
func (s *Store) Pending(ctx context.Context) ([]Migration, error) {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		return nil, err
	}
	return s.pending(ctx, sub)
}

func (s *Store) pending(ctx context.Context, fsys fs.FS) ([]Migration, error) {
	known, err := loadMigrations(fsys, s.engine)
	if err != nil {
		return nil, err
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("store: pending migrations: %w", err)
	}
	defer conn.Close()

	exists := `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`
	if s.engine == Postgres {
		exists = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`
	}
	var n int
	if err := conn.QueryRowContext(ctx, exists).Scan(&n); err != nil {
		return nil, fmt.Errorf("store: pending migrations: %w", err)
	}
	var applied []int
	if n > 0 {
		if applied, err = appliedVersions(ctx, conn); err != nil {
			return nil, err
		}
	}
	if len(applied) > 0 && applied[len(applied)-1] > len(known) {
		return nil, fmt.Errorf("%w: it has migration %04d, and this binary knows up to %04d",
			ErrDatabaseNewer, applied[len(applied)-1], len(known))
	}
	done := make(map[int]bool, len(applied))
	for _, v := range applied {
		done[v] = true
	}
	var out []Migration
	for _, m := range known {
		if !done[m.version] {
			out = append(out, Migration{Version: m.version, Name: m.name})
		}
	}
	return out, nil
}
