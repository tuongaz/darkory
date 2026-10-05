package store

import (
	"context"
	"io/fs"
	"time"
)

// MigrateFS migrates with the given migration set instead of the embedded one.
func (s *Store) MigrateFS(ctx context.Context, fsys fs.FS, now time.Time) (MigrateResult, error) {
	return s.migrate(ctx, fsys, now)
}

// LoadMigrations exposes the set loader to tests.
func LoadMigrations(fsys fs.FS, engine Engine) (versions []int, err error) {
	ms, err := loadMigrations(fsys, engine)
	for _, m := range ms {
		versions = append(versions, m.version)
	}
	return versions, err
}
