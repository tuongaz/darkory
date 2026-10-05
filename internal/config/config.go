// Package config reads the Install settings: where the server listens, where it keeps its data,
// and the address browsers reach it at. A flag wins over its environment variable, which wins
// over the default.
package config

import (
	"flag"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
)

// Defaults for a Local Install.
const (
	DefaultListen = "127.0.0.1:7357"
	DefaultData   = "."
	DefaultOrg    = "My Organisation"
	databaseFile  = "darkory.db"
)

// Store holds where the record is kept, which every command that opens it reads.
type Store struct {
	// DataDir holds the SQLite file and, later, Evidence on disk (DARKORY_DATA, --data).
	DataDir string
	// Database is a Postgres URL or a SQLite file path (DARKORY_DB, --db). It defaults to
	// darkory.db in DataDir.
	Database string
}

// Serve holds the settings of `darkory serve`.
type Serve struct {
	// Listen is the address to listen on (DARKORY_LISTEN, --listen).
	Listen string
	Store
	// PublicURL is the address browsers reach the Install at, used in login links
	// (DARKORY_PUBLIC_URL, --public-url). Empty: http:// and the listen address.
	PublicURL string
	// NoBrowser stops `serve` opening the startup login link in a browser (DARKORY_NO_BROWSER,
	// --no-browser).
	NoBrowser bool
	// NoLoginLink stops `serve` issuing and printing the startup login link at all, for a
	// container whose output goes to shipped logs (DARKORY_NO_LOGIN_LINK, --no-login-link).
	NoLoginLink bool
}

// Init holds the settings of `darkory init`.
type Init struct {
	Store
	// Listen and PublicURL build the printed login link, as for Serve.
	Listen    string
	PublicURL string
	// Org names the Organisation (--org); Name is the first Member's name (--name, default $USER).
	Org  string
	Name string
}

func storeFlags(fs *flag.FlagSet, getenv func(string) string, s *Store) {
	fs.StringVar(&s.DataDir, "data", or(getenv("DARKORY_DATA"), DefaultData), "directory for the SQLite file and Evidence (DARKORY_DATA)")
	fs.StringVar(&s.Database, "db", getenv("DARKORY_DB"), "Postgres URL or SQLite file path; default darkory.db in the data directory (DARKORY_DB)")
}

func (s *Store) finish() {
	if s.Database == "" {
		s.Database = filepath.Join(s.DataDir, databaseFile)
	}
}

func addressFlags(fs *flag.FlagSet, getenv func(string) string, listen, public *string) {
	fs.StringVar(listen, "listen", or(getenv("DARKORY_LISTEN"), DefaultListen), "address to listen on (DARKORY_LISTEN)")
	fs.StringVar(public, "public-url", getenv("DARKORY_PUBLIC_URL"), "address browsers reach the Install at, for login links; default http:// and the listen address (DARKORY_PUBLIC_URL)")
}

// LoadServe reads the settings of `darkory serve` from args and the environment.
func LoadServe(args []string, getenv func(string) string, usage io.Writer) (Serve, error) {
	var c Serve
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(usage)
	addressFlags(fs, getenv, &c.Listen, &c.PublicURL)
	storeFlags(fs, getenv, &c.Store)
	noBrowser, _ := strconv.ParseBool(getenv("DARKORY_NO_BROWSER"))
	fs.BoolVar(&c.NoBrowser, "no-browser", noBrowser, "do not open the startup login link in a browser (DARKORY_NO_BROWSER)")
	noLink, _ := strconv.ParseBool(getenv("DARKORY_NO_LOGIN_LINK"))
	fs.BoolVar(&c.NoLoginLink, "no-login-link", noLink, "do not issue or print a startup login link (DARKORY_NO_LOGIN_LINK)")
	if err := fs.Parse(args); err != nil {
		return Serve{}, err
	}
	if fs.NArg() > 0 {
		return Serve{}, fmt.Errorf("serve takes no arguments, got %q", fs.Args())
	}
	c.finish()
	return c, nil
}

// LoadInit reads the settings of `darkory init` from args and the environment.
func LoadInit(args []string, getenv func(string) string, usage io.Writer) (Init, error) {
	var c Init
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(usage)
	addressFlags(fs, getenv, &c.Listen, &c.PublicURL)
	storeFlags(fs, getenv, &c.Store)
	fs.StringVar(&c.Org, "org", DefaultOrg, "name of the Organisation")
	fs.StringVar(&c.Name, "name", or(getenv("USER"), "admin"), "name of the first Member, a human admin")
	if err := fs.Parse(args); err != nil {
		return Init{}, err
	}
	if fs.NArg() > 0 {
		return Init{}, fmt.Errorf("init takes no arguments, got %q", fs.Args())
	}
	c.finish()
	return c, nil
}

// BaseURL is where browsers reach an Install listening on listen, unless public names it.
func BaseURL(public, listen string) string {
	if public != "" {
		return public
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "http://" + listen
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func or(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}
