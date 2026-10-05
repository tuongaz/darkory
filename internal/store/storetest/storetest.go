// Package storetest gives tests a fresh database on every engine, so each store and core test
// runs on SQLite, and on Postgres when DARKORY_TEST_POSTGRES_URL is set (docs/build/testing.md).
package storetest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/store"
)

// PostgresURLEnv names the variable holding a Postgres URL whose role may create databases.
const PostgresURLEnv = "DARKORY_TEST_POSTGRES_URL"

// Engines lists the engines tests run on: SQLite always, Postgres when PostgresURLEnv is set.
func Engines() []store.Engine {
	if os.Getenv(PostgresURLEnv) == "" {
		return []store.Engine{store.SQLite}
	}
	return []store.Engine{store.SQLite, store.Postgres}
}

// Each runs fn as a subtest named after each engine in Engines, with a fresh migrated database.
func Each(t *testing.T, fn func(t *testing.T, s *store.Store)) {
	t.Helper()
	for _, e := range Engines() {
		t.Run(string(e), func(t *testing.T) {
			fn(t, Open(t, e))
		})
	}
}

// Open returns a fresh, migrated database on engine, closed and removed when the test ends.
func Open(t testing.TB, engine store.Engine) *store.Store {
	t.Helper()
	s := OpenUnmigrated(t, engine)
	if _, err := s.Migrate(t.Context()); err != nil {
		t.Fatalf("migrate %s: %v", engine, err)
	}
	return s
}

// OpenUnmigrated returns a fresh, empty database on engine, closed and removed when the test ends.
func OpenUnmigrated(t testing.TB, engine store.Engine) *store.Store {
	t.Helper()
	s, err := store.Open(t.Context(), DSN(t, engine))
	if err != nil {
		t.Fatalf("open %s: %v", engine, err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// DSN creates a fresh, empty database on engine and returns its DSN. SQLite gets a file in the
// test's temporary directory; Postgres gets a new database, dropped when the test ends.
func DSN(t testing.TB, engine store.Engine) string {
	t.Helper()
	switch engine {
	case store.SQLite:
		return filepath.Join(t.TempDir(), "darkory.db")
	case store.Postgres:
		return postgresDatabase(t)
	}
	t.Fatalf("unknown engine %q", engine)
	return ""
}

// Organisation creates an Organisation for the test and returns its id.
func Organisation(t testing.TB, s *store.Store) string {
	t.Helper()
	id, err := s.CreateOrganisation(t.Context(), "Test Organisation", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func postgresDatabase(t testing.TB) string {
	t.Helper()
	admin := os.Getenv(PostgresURLEnv)
	if admin == "" {
		t.Skipf("%s is not set", PostgresURLEnv)
	}
	u, err := url.Parse(admin)
	if err != nil {
		t.Fatalf("%s: %v", PostgresURLEnv, err)
	}
	var b [8]byte
	rand.Read(b[:])
	name := "dk_test_" + hex.EncodeToString(b[:])

	db, err := sql.Open("pgx", admin)
	if err != nil {
		t.Fatalf("connect %s: %v", PostgresURLEnv, err)
	}
	defer db.Close()
	// template0, so parallel creates never wait on a session in template1.
	if _, err := db.ExecContext(t.Context(), `CREATE DATABASE "`+name+`" TEMPLATE template0`); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		db, err := sql.Open("pgx", admin)
		if err != nil {
			t.Errorf("connect %s: %v", PostgresURLEnv, err)
			return
		}
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := db.ExecContext(ctx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop database %s: %v", name, err)
		}
	})
	u.Path = "/" + name
	return u.String()
}
