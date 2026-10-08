// Package config reads the Install settings: where the server listens, where it keeps its data
// and Evidence, the address browsers reach it at, and how humans sign in (ADR 0002). A flag wins
// over its environment variable, which wins over the default. Settings that usually carry a
// secret are read from the environment only, so they never show in a process list.
// docs/build/settings.md lists them all.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/tuongaz/darkory/internal/blob"
)

// Defaults for a Local Install.
const (
	DefaultListen = "0.0.0.0:7357"
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
	// NoUpdateCheck stops `serve` asking for a newer release, so health never reports one
	// (DARKORY_NO_UPDATE_CHECK, --no-update-check).
	NoUpdateCheck bool
	// DatabaseListen is where the Postgres LISTEN connection that wakes this process for other
	// processes' writes goes (DARKORY_DB_LISTEN; environment only). Empty: Database. It must reach
	// Postgres directly or through session pooling, never a transaction-pooling PgBouncer.
	DatabaseListen string
	// Migrate lets `serve` apply pending migrations to a Postgres database at start (DARKORY_MIGRATE,
	// --migrate). Without it, Postgres is migrated by `darkory migrate` as its own step, and `serve`
	// refuses to start while migrations are pending. SQLite always migrates at start, after a backup.
	Migrate bool
	// ProxyHops is how many proxies in front of the server append to X-Forwarded-For, so the
	// client's address is found that many entries from its end (DARKORY_PROXY_HOPS, --proxy-hops).
	// Zero: the connection's own address. Only rate limits use it.
	ProxyHops int
	// Evidence is where Evidence files are kept (DARKORY_EVIDENCE, --evidence; DARKORY_S3_*).
	Evidence blob.Settings
	// SMTP sends emailed sign-in links; unset, email sign-in is off.
	SMTP SMTP
	// EvidenceMaxMB bounds one Evidence file, in MiB (DARKORY_EVIDENCE_MAX_MB, --evidence-max-mb).
	EvidenceMaxMB int64
	// SessionIdle ends a browser Session unused for this long (DARKORY_SESSION_IDLE,
	// --session-idle); SessionLifetime ends one this long after it started, used or not
	// (DARKORY_SESSION_LIFETIME, --session-lifetime). Token Sessions are not affected.
	SessionIdle, SessionLifetime time.Duration
	// MaxWaiting is how many Activity streams, and separately how many waiting `next` calls, one
	// Member may have open on a server process at once (DARKORY_MAX_WAITING, --max-waiting).
	MaxWaiting int
	// Runner says whether serve runs the Runner beside the server (ADR 0013): on, off, or auto —
	// on when <data>/agents holds agent tokens (DARKORY_RUNNER, --runner).
	Runner string
}

// Defaults for browser Sessions and long requests.
const (
	DefaultSessionIdle     = 30 * 24 * time.Hour
	DefaultSessionLifetime = 90 * 24 * time.Hour
	DefaultMaxWaiting      = 16
)

// SMTP names the server that sends email (environment only).
type SMTP struct {
	// URL is smtp://user:pass@host:587 (STARTTLS, required), smtps://user:pass@host:465 (TLS from
	// the start), or smtp://host:25?tls=none for a relay on a trusted network (DARKORY_SMTP_URL).
	URL string
	// From is the sender, such as "Darkory <darkory@example.com>" (DARKORY_SMTP_FROM).
	From string
	// MaxPerHour caps the emails a server process sends an hour, to protect the SMTP account's
	// reputation under a flood (DARKORY_SMTP_MAX_PER_HOUR, default 300).
	MaxPerHour int
}

// DefaultSMTPMaxPerHour is the default cap on emails sent an hour.
const DefaultSMTPMaxPerHour = 300

// DatabaseListenURL is where the LISTEN connection goes: DatabaseListen, or Database.
func (c Serve) DatabaseListenURL() string {
	if c.DatabaseListen != "" {
		return c.DatabaseListen
	}
	return c.Database
}

// How humans sign in to an Install (ADR 0008). An Install always has the printed link — `serve`
// prints one at start, and an admin issues them through /v1 — and has the emailed link when SMTP
// is set. GitHub and Google sign-in are not built yet.
const (
	SignInPrintedLink = "printed_link"
	SignInEmailLink   = "email_link"
)

// SignInModes lists the sign-in modes of an Install with or without email set up, for the health
// reply and the startup log.
func SignInModes(email bool) []string {
	if email {
		return []string{SignInPrintedLink, SignInEmailLink}
	}
	return []string{SignInPrintedLink}
}

// SignInModes lists how humans sign in to this Install.
func (c Serve) SignInModes() []string { return SignInModes(c.SMTP.URL != "") }

// DefaultEvidenceMaxMB is the largest Evidence file, in MiB, unless set otherwise.
const DefaultEvidenceMaxMB = 100

// Init holds the settings of `darkory init`.
type Init struct {
	Store
	// Listen and PublicURL build the printed login link, as for Serve.
	Listen    string
	PublicURL string
	// Org names the Organisation (--org); Name is the first Member's name (--name, default $USER).
	Org  string
	Name string
	// NoAgents skips the roster: Project MAIN, the Workspace for the git repository init runs in,
	// and the agents (--no-agents).
	NoAgents bool
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
	// Any value but empty, 0 or false turns the check off, as for the CLI's notice.
	noUpdate := !slices.Contains([]string{"", "0", "false"}, getenv("DARKORY_NO_UPDATE_CHECK"))
	fs.BoolVar(&c.NoUpdateCheck, "no-update-check", noUpdate, "do not ask for a newer release (DARKORY_NO_UPDATE_CHECK)")
	migrate, _ := strconv.ParseBool(getenv("DARKORY_MIGRATE"))
	fs.BoolVar(&c.Migrate, "migrate", migrate, "on Postgres, apply pending migrations at start instead of refusing to start (DARKORY_MIGRATE)")
	hops := 0
	if v := getenv("DARKORY_PROXY_HOPS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return Serve{}, fmt.Errorf("DARKORY_PROXY_HOPS is a count of proxies, got %q", v)
		}
		hops = n
	}
	fs.IntVar(&c.ProxyHops, "proxy-hops", hops, "proxies in front that append to X-Forwarded-For (DARKORY_PROXY_HOPS)")
	var evidence string
	fs.StringVar(&evidence, "evidence", getenv("DARKORY_EVIDENCE"), "directory for Evidence, or s3://bucket/prefix; default evidence in the data directory (DARKORY_EVIDENCE)")
	maxMB, err := strconv.ParseInt(or(getenv("DARKORY_EVIDENCE_MAX_MB"), strconv.Itoa(DefaultEvidenceMaxMB)), 10, 64)
	if err != nil {
		return Serve{}, fmt.Errorf("DARKORY_EVIDENCE_MAX_MB: %w", err)
	}
	fs.Int64Var(&c.EvidenceMaxMB, "evidence-max-mb", maxMB, "largest Evidence file in MiB (DARKORY_EVIDENCE_MAX_MB)")
	for _, d := range []struct {
		flag, env, usage string
		into             *time.Duration
		def              time.Duration
	}{
		{"session-idle", "DARKORY_SESSION_IDLE", "end a browser Session unused this long (DARKORY_SESSION_IDLE)", &c.SessionIdle, DefaultSessionIdle},
		{"session-lifetime", "DARKORY_SESSION_LIFETIME", "end a browser Session this long after it started (DARKORY_SESSION_LIFETIME)", &c.SessionLifetime, DefaultSessionLifetime},
	} {
		v := d.def
		if s := getenv(d.env); s != "" {
			if v, err = time.ParseDuration(s); err != nil {
				return Serve{}, fmt.Errorf("%s is a duration such as 720h, got %q", d.env, s)
			}
		}
		fs.DurationVar(d.into, d.flag, v, d.usage)
	}
	maxWaiting := DefaultMaxWaiting
	if v := getenv("DARKORY_MAX_WAITING"); v != "" {
		if maxWaiting, err = strconv.Atoi(v); err != nil {
			return Serve{}, fmt.Errorf("DARKORY_MAX_WAITING is a count, got %q", v)
		}
	}
	fs.IntVar(&c.MaxWaiting, "max-waiting", maxWaiting, "Activity streams, and waiting next calls, one Member may have open at once (DARKORY_MAX_WAITING)")
	fs.StringVar(&c.Runner, "runner", or(getenv("DARKORY_RUNNER"), "auto"), "run the Runner, agent sessions, beside the server: auto (when <data>/agents holds tokens), on or off (DARKORY_RUNNER)")
	if err := fs.Parse(args); err != nil {
		return Serve{}, err
	}
	if c.SessionIdle <= 0 || c.SessionLifetime <= 0 {
		return Serve{}, errors.New("--session-idle and --session-lifetime are above zero")
	}
	if c.MaxWaiting < 1 {
		return Serve{}, fmt.Errorf("--max-waiting is 1 or more, got %d", c.MaxWaiting)
	}
	switch c.Runner {
	case "auto", "on", "off":
	case "true", "1":
		c.Runner = "on"
	case "false", "0":
		c.Runner = "off"
	default:
		return Serve{}, fmt.Errorf("--runner is auto, on or off, got %q", c.Runner)
	}
	if c.EvidenceMaxMB < 1 {
		return Serve{}, fmt.Errorf("--evidence-max-mb is 1 or more, got %d", c.EvidenceMaxMB)
	}
	if fs.NArg() > 0 {
		return Serve{}, fmt.Errorf("serve takes no arguments, got %q", fs.Args())
	}
	if c.ProxyHops < 0 {
		return Serve{}, errors.New("--proxy-hops is not negative")
	}
	c.finish()
	c.DatabaseListen = getenv("DARKORY_DB_LISTEN")
	if c.Evidence, err = loadEvidence(evidence, c.DataDir, getenv); err != nil {
		return Serve{}, err
	}
	c.SMTP = SMTP{URL: getenv("DARKORY_SMTP_URL"), From: getenv("DARKORY_SMTP_FROM"), MaxPerHour: DefaultSMTPMaxPerHour}
	if v := getenv("DARKORY_SMTP_MAX_PER_HOUR"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Serve{}, fmt.Errorf("DARKORY_SMTP_MAX_PER_HOUR is a number of emails above zero, got %q", v)
		}
		c.SMTP.MaxPerHour = n
	}
	if c.SMTP.URL != "" {
		// A link in an email must never be built on the Host a request names, which anyone can set.
		if c.PublicURL == "" {
			return Serve{}, errors.New("DARKORY_SMTP_URL needs DARKORY_PUBLIC_URL: emailed login links are built on it")
		}
		if c.SMTP.From == "" {
			return Serve{}, errors.New("DARKORY_SMTP_URL needs DARKORY_SMTP_FROM, the address emails are sent from")
		}
	}
	return c, nil
}

// loadEvidence reads where Evidence is kept: a directory, by default evidence in the data
// directory, or an S3-compatible bucket named s3://bucket/prefix and set up by DARKORY_S3_*.
func loadEvidence(location, dataDir string, getenv func(string) string) (blob.Settings, error) {
	if !strings.HasPrefix(location, "s3://") {
		if location == "" {
			location = filepath.Join(dataDir, "evidence")
		}
		return blob.Settings{Dir: location}, nil
	}
	u, err := url.Parse(location)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" {
		return blob.Settings{}, fmt.Errorf("DARKORY_EVIDENCE: want s3://bucket or s3://bucket/prefix, got %q", location)
	}
	pathStyle, err := strconv.ParseBool(or(getenv("DARKORY_S3_PATH_STYLE"), "false"))
	if err != nil {
		return blob.Settings{}, fmt.Errorf("DARKORY_S3_PATH_STYLE is true or false, got %q", getenv("DARKORY_S3_PATH_STYLE"))
	}
	s3 := &blob.S3Settings{
		Bucket:    u.Host,
		Prefix:    strings.Trim(u.Path, "/"),
		Endpoint:  getenv("DARKORY_S3_ENDPOINT"),
		Region:    or(getenv("DARKORY_S3_REGION"), or(getenv("AWS_REGION"), "us-east-1")),
		AccessKey: or(getenv("DARKORY_S3_ACCESS_KEY"), getenv("AWS_ACCESS_KEY_ID")),
		SecretKey: or(getenv("DARKORY_S3_SECRET_KEY"), getenv("AWS_SECRET_ACCESS_KEY")),
		PathStyle: pathStyle,
	}
	if s3.AccessKey == "" || s3.SecretKey == "" {
		return blob.Settings{}, errors.New("DARKORY_EVIDENCE names an S3 bucket: set DARKORY_S3_ACCESS_KEY and DARKORY_S3_SECRET_KEY")
	}
	if s3.Endpoint != "" && !strings.HasPrefix(s3.Endpoint, "http://") && !strings.HasPrefix(s3.Endpoint, "https://") {
		return blob.Settings{}, fmt.Errorf("DARKORY_S3_ENDPOINT needs http:// or https://, got %q", s3.Endpoint)
	}
	return blob.Settings{S3: s3}, nil
}

// Migrate holds the settings of `darkory migrate`.
type Migrate struct {
	Store
	// DryRun lists the pending migrations without applying them (--dry-run).
	DryRun bool
}

// LoadMigrate reads the settings of `darkory migrate` from args and the environment.
func LoadMigrate(args []string, getenv func(string) string, usage io.Writer) (Migrate, error) {
	var c Migrate
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.SetOutput(usage)
	storeFlags(fs, getenv, &c.Store)
	fs.BoolVar(&c.DryRun, "dry-run", false, "list the pending migrations without applying them")
	if err := fs.Parse(args); err != nil {
		return Migrate{}, err
	}
	if fs.NArg() > 0 {
		return Migrate{}, fmt.Errorf("migrate takes no arguments, got %q", fs.Args())
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
	fs.BoolVar(&c.NoAgents, "no-agents", false, "seed no Project MAIN, Workspace or agents: just the Organisation and its first Member")
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
