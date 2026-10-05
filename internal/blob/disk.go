package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrInvalidKey reports a key with characters outside [a-z0-9/-] or an empty part, which could
// otherwise name a path outside the store.
var ErrInvalidKey = errors.New("blob: invalid key")

// validKey is one or more parts of [a-z0-9-], joined by single slashes: no dots, so no part can
// be "..", and no leading slash.
var validKey = regexp.MustCompile(`^[a-z0-9-]+(/[a-z0-9-]+)*$`)

// Disk keeps Evidence files under a directory on the local disk, the default Evidence store.
// Each file is written to a temporary file beside its final place and renamed there once
// complete, so a reader never sees half a file and a failed Put leaves nothing behind.
type Disk struct {
	root string
}

var _ Store = (*Disk)(nil)

// NewDisk returns a Disk store keeping files under dir, which it creates when missing.
func NewDisk(dir string) (*Disk, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, fmt.Errorf("blob: %w", err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("blob: %w", err)
	}
	return &Disk{root: abs}, nil
}

// path is where key lives, refusing any key that is not one the store hands out.
func (d *Disk) path(key string) (string, error) {
	if len(key) > 512 || !validKey.MatchString(key) {
		return "", fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	p := filepath.Join(d.root, filepath.FromSlash(key))
	// The pattern already rules out climbing out; this holds even if it changes.
	if !strings.HasPrefix(p, d.root+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	return p, nil
}

// Put stores exactly size bytes read from r under key. A reader that ends early or has more to
// give fails the Put.
func (d *Disk) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) (err error) {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if size < 0 {
		return fmt.Errorf("blob: put %s: the size must be known", key)
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	f, err := os.CreateTemp(dir, ".put-*")
	if err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	src := &ctxReader{ctx: ctx, r: r}
	if _, err := io.CopyN(f, src, size); err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("blob: put %s: the content ended before %d bytes", key, size)
		}
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	var one [1]byte
	if n, rerr := src.Read(one[:]); n > 0 {
		return fmt.Errorf("blob: put %s: the content is longer than %d bytes", key, size)
	} else if rerr != nil && !errors.Is(rerr, io.EOF) {
		return fmt.Errorf("blob: put %s: %w", key, rerr)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	if err := os.Rename(f.Name(), p); err != nil {
		return fmt.Errorf("blob: put %s: %w", key, err)
	}
	return nil
}

// Get opens the file stored under key.
func (d *Disk) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	p, err := d.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return nil, fmt.Errorf("blob: get %s: %w", key, err)
	}
	return f, nil
}

// Delete removes the file stored under key.
func (d *Disk) Delete(ctx context.Context, key string) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return fmt.Errorf("blob: delete %s: %w", key, err)
	}
	return nil
}

// ctxReader stops reading once ctx ends, so an abandoned upload stops writing.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
