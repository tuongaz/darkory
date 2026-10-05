package store

import (
	"context"
	"io/fs"
)

// PendingFS lists what the given migration set would apply, instead of the embedded one.
func (s *Store) PendingFS(ctx context.Context, fsys fs.FS) ([]Migration, error) {
	return s.pending(ctx, fsys)
}
