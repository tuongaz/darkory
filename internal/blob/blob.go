// Package blob stores Evidence files outside the database ([ADR 0004]).
// The disk store is the default; an Install can be set to use
// S3-compatible storage instead ([ADR 0002]).
//
// [ADR 0004]: ../../docs/adr/0004-sqlite-local-postgres-cloud.md
// [ADR 0002]: ../../docs/adr/0002-one-authority-per-organisation.md
package blob

import (
	"context"
	"errors"
	"io"
)

// ErrNotFound is returned by Get and Delete when no object has the key.
var ErrNotFound = errors.New("blob: not found")

// Store keeps Evidence content by key. Keys are chosen by the caller,
// are unique per Install, and contain only [a-z0-9/-].
type Store interface {
	// Put stores size bytes read from r under key. A Put that fails leaves
	// no object behind.
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	// Get opens the object stored under key. The caller closes it.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete removes the object stored under key.
	Delete(ctx context.Context, key string) error
}
