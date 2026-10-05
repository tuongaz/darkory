package blob_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/blob"
)

func newDisk(t *testing.T) (*blob.Disk, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "evidence")
	d, err := blob.NewDisk(dir)
	if err != nil {
		t.Fatal(err)
	}
	return d, dir
}

// files lists every file under dir, temporary ones included.
func files(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(p string, e os.DirEntry, err error) error {
		if err == nil && !e.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDiskPutGetDelete(t *testing.T) {
	d, dir := newDisk(t)
	ctx := t.Context()
	body := []byte("a test report\n")
	if err := d.Put(ctx, "org-1/ev-1", bytes.NewReader(body), int64(len(body)), "text/plain"); err != nil {
		t.Fatal(err)
	}
	if got := files(t, dir); len(got) != 1 || got[0] != "org-1/ev-1" {
		t.Fatalf("files %v", got)
	}
	rc, err := d.Get(ctx, "org-1/ev-1")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(got, body) {
		t.Fatalf("got %q", got)
	}
	if err := d.Delete(ctx, "org-1/ev-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Get(ctx, "org-1/ev-1"); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
	if err := d.Delete(ctx, "org-1/ev-1"); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
}

// No key can name a path outside the store, and nothing is written for one that tries.
func TestDiskRefusesPathTraversal(t *testing.T) {
	d, dir := newDisk(t)
	ctx := t.Context()
	outside := filepath.Join(filepath.Dir(dir), "escaped")
	for _, key := range []string{
		"../escaped", "a/../../escaped", "/etc/passwd", "..", ".", "", "a//b", "a/", "/a", ".hidden",
		"a/./b", `a\..\..\escaped`, "A/b", "a b", "a/b%2f..", "a\x00b", strings.Repeat("a", 513),
	} {
		if err := d.Put(ctx, key, strings.NewReader("x"), 1, "text/plain"); !errors.Is(err, blob.ErrInvalidKey) {
			t.Errorf("Put(%q) = %v, want ErrInvalidKey", key, err)
		}
		if _, err := d.Get(ctx, key); !errors.Is(err, blob.ErrInvalidKey) {
			t.Errorf("Get(%q) = %v, want ErrInvalidKey", key, err)
		}
		if err := d.Delete(ctx, key); !errors.Is(err, blob.ErrInvalidKey) {
			t.Errorf("Delete(%q) = %v, want ErrInvalidKey", key, err)
		}
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("a file was written outside the store: %v", err)
	}
	if got := files(t, dir); len(got) != 0 {
		t.Fatalf("files %v", got)
	}
}

// A Put whose content is shorter or longer than its size, or whose context ends, fails and leaves
// no file, temporary or final.
func TestDiskFailedPutLeavesNothing(t *testing.T) {
	d, dir := newDisk(t)
	ctx := t.Context()
	if err := d.Put(ctx, "org/short", strings.NewReader("abc"), 10, ""); err == nil {
		t.Fatal("a short body was stored")
	}
	if err := d.Put(ctx, "org/long", strings.NewReader("abcdef"), 3, ""); err == nil {
		t.Fatal("a body longer than its size was stored")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := d.Put(cancelled, "org/cancelled", strings.NewReader("abc"), 3, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled put: %v", err)
	}
	if err := d.Put(ctx, "org/unknown", strings.NewReader("abc"), -1, ""); err == nil {
		t.Fatal("a body of unknown size was stored")
	}
	if got := files(t, dir); len(got) != 0 {
		t.Fatalf("files left behind: %v", got)
	}
}
