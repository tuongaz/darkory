// Package config reads the Install settings: where the server listens and where it keeps its
// data. A flag wins over its environment variable, which wins over the default.
package config

import (
	"flag"
	"fmt"
	"io"
	"path/filepath"
)

// Defaults for a Local Install.
const (
	DefaultListen = "127.0.0.1:7357"
	DefaultData   = "."
	databaseFile  = "darkory.db"
)

// Serve holds the settings of `darkory serve`.
type Serve struct {
	// Listen is the address to listen on (DARKORY_LISTEN, --listen).
	Listen string
	// DataDir holds the SQLite file and, later, Evidence on disk (DARKORY_DATA, --data).
	DataDir string
	// Database is a Postgres URL or a SQLite file path (DARKORY_DB, --db). It defaults to
	// darkory.db in DataDir.
	Database string
}

// LoadServe reads the settings of `darkory serve` from args and the environment.
func LoadServe(args []string, getenv func(string) string, usage io.Writer) (Serve, error) {
	var c Serve
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(usage)
	fs.StringVar(&c.Listen, "listen", or(getenv("DARKORY_LISTEN"), DefaultListen), "address to listen on (DARKORY_LISTEN)")
	fs.StringVar(&c.DataDir, "data", or(getenv("DARKORY_DATA"), DefaultData), "directory for the SQLite file and Evidence (DARKORY_DATA)")
	fs.StringVar(&c.Database, "db", getenv("DARKORY_DB"), "Postgres URL or SQLite file path; default darkory.db in the data directory (DARKORY_DB)")
	if err := fs.Parse(args); err != nil {
		return Serve{}, err
	}
	if fs.NArg() > 0 {
		return Serve{}, fmt.Errorf("serve takes no arguments, got %q", fs.Args())
	}
	if c.Database == "" {
		c.Database = filepath.Join(c.DataDir, databaseFile)
	}
	return c, nil
}

func or(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}
