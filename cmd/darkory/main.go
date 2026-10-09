// Command darkory is the Darkory server, its CLI and its MCP server, in one binary.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/cli"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/gitinfo"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/runner"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/version"
	"github.com/tuongaz/darkory/internal/wake"
)

var usage = `darkory: management for a software factory of agents and humans.

Usage:
  darkory init [--org name] [--name member] [--data dir] [--db dsn] [--no-agents]
                                                                       create the Organisation, its first Member and its agents
  darkory serve [--listen addr] [--data dir] [--db dsn] [--public-url url] [--no-browser] [--no-login-link]
                [--migrate] [--evidence dir|s3://bucket/prefix] [--evidence-max-mb n]
                [--files dir|s3://bucket/prefix] [--files-max-mb n] [--proxy-hops n]
                [--no-update-check] [--runner auto|on|off] [--workspaces dir]
                                                                       run the server, and the Runner beside it
  darkory migrate [--data dir] [--db dsn] [--dry-run]                  apply pending migrations, or list them
  darkory mcp                                                          serve the agent operations to an MCP client over stdio
  darkory runner [--data dir] [--url url] [--token-dir dir] [--member name]… [--workspaces dir]
                                                                       run the Runner alone: Shifts for the agents' tokens
  darkory join <task> [--readonly] [--data dir]                        join the Shift the Runner runs for a Task, in tmux
  darkory update [--check] [--version v]                               replace this binary with a newer release
  darkory version                                                      print the version
` + cli.Usage()

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		var ex *cli.ExitError
		if !errors.As(err, &ex) {
			fmt.Fprintln(os.Stderr, "darkory:", err)
		}
		os.Exit(exitCode(err))
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	switch args[0] {
	case "init":
		return initInstall(args[1:], stdout, stderr)
	case "serve":
		return serve(args[1:], stdout, stderr)
	case "migrate":
		return migrate(args[1:], stdout, stderr)
	case "update":
		return runUpdate(args[1:], stdout, stderr)
	case "version", "--version":
		fmt.Fprintln(stdout, version.Version)
		return nil
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return nil
	case "mcp":
		return runMCP(args[1:], stderr)
	case "runner":
		return runRunner(args[1:], stderr)
	case "join":
		return joinSession(args[1:], stderr)
	}
	if cli.Handles(args) {
		return runCLI(args, stdout, stderr)
	}
	fmt.Fprintf(stderr, "darkory: unknown command %q\n%s", args[0], usage)
	return &cli.ExitError{Code: cli.ExitUsage}
}

// openStore opens the record cfg names, creating the data directory for SQLite. With migrate it
// brings the schema up to date, backing up a SQLite file first; without, it refuses a database
// with pending migrations (ADR 0009: Cloud runs `darkory migrate` as its own step). Either way it
// refuses a database newer than the binary.
func openStore(ctx context.Context, cfg config.Store, migrate bool, log *slog.Logger) (*store.Store, error) {
	st, err := openDatabase(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if !migrate {
		pending, err := st.Pending(ctx)
		if err == nil && len(pending) > 0 {
			err = fmt.Errorf("the database needs migrations %s; run darkory migrate before starting this release, or serve --migrate",
				migrationList(pending))
		}
		if err != nil {
			st.Close()
			return nil, err
		}
		return st, nil
	}
	res, err := st.Migrate(ctx)
	if err != nil {
		st.Close()
		return nil, err
	}
	if res.Backup != "" {
		log.Info("backed up the database before migrating", "backup", res.Backup)
	}
	if len(res.Applied) > 0 {
		log.Info("migrated the database", "applied", res.Applied)
	}
	return st, nil
}

// initInstall creates the Install's Organisation, its first Member as a human admin, and the
// built-in Skills and Project MAIN on the default Workflows, and prints that Member's first token
// and a login link (ADR 0006). Unless told --no-agents it seeds the roster too
// (docs/build/agents-plan.md, D4): the git repository init runs in as MAIN's default Workspace,
// and the agents, whose tokens it writes to <data>/agents/<name>.token for the Runner.
func initInstall(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.LoadInit(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	ctx := context.Background()
	opts := core.InitOptions{Project: true, Roster: !cfg.NoAgents}
	if opts.Roster {
		if wd, err := os.Getwd(); err == nil {
			if repo, ok := gitinfo.Find(ctx, wd); ok {
				opts.Workspace = &core.NewWorkspace{Name: gitinfo.Name(repo.Root), Path: repo.Root, DefaultBranch: repo.DefaultBranch}
			}
		}
	}
	st, err := openStore(ctx, cfg.Store, true, slog.New(slog.NewTextHandler(stderr, nil)))
	if err != nil {
		return err
	}
	defer st.Close()
	out, err := core.New(st, clock.Real{}, wake.New(), nil).InitWith(ctx, cfg.Org, cfg.Name, opts)
	if errors.Is(err, core.ErrInitialised) {
		return fmt.Errorf("%s already holds an Organisation; darkory init runs once", cfg.Database)
	}
	if err != nil {
		return err
	}
	tokens := filepath.Join(cfg.DataDir, "agents")
	for _, a := range out.Agents {
		if err := writeToken(tokens, a.Member.Name, a.Token.Secret); err != nil {
			return fmt.Errorf("the Organisation is made, but %s's token could not be kept: %w; an admin issues another with darkory token issue %s --name runner",
				a.Member.Name, err, a.Member.Name)
		}
	}
	link := server.LoginURL(config.BaseURL(cfg.PublicURL, cfg.Listen), out.Link.Code)
	fmt.Fprintf(stdout, `Initialised the Organisation %q in %s.

First Member: %s (human, admin)

Token for %s, shown once; keep it safe:
  %s

Sign in with a browser within %d minutes, once darkory serve is running:
  %s
`, out.Organisation.Name, cfg.Database, out.Member.Name, out.Member.Name, out.Token.Secret,
		int(core.LoginLinkTTL.Minutes()), link)
	printSeeded(stdout, out, tokens)
	fmt.Fprint(stdout, "\ndarkory serve prints a fresh login link every time it starts.\n")
	return nil
}

// printSeeded says what init seeded besides the first Member: Project MAIN, and the roster.
func printSeeded(w io.Writer, out core.Initialised, tokens string) {
	if len(out.Agents) == 0 {
		fmt.Fprintf(w, "\nProject %s (%s), on the default Workflows, holds %s. No agents and no Workspace: init ran with --no-agents.\n",
			out.Project.Key, out.Project.Name, out.Member.Name)
		return
	}
	fmt.Fprintf(w, "\nProject %s (%s), on the default Workflows, holds %s and the agents below.\n", out.Project.Key, out.Project.Name, out.Member.Name)
	if ws := out.Workspace; ws != nil {
		fmt.Fprintf(w, "Workspace %s: %s (git, default branch %s), Project %s's default.\n", ws.Name, ws.Path, ws.DefaultBranch, out.Project.Key)
	} else {
		fmt.Fprintf(w, "No Workspace: init ran outside a git repository. Add one with darkory workspace add --path <repository>,\n"+
			"then make it the Project's default with darkory project set %s --workspace <name>.\n", out.Project.Key)
	}
	fmt.Fprintf(w, "Agents, reporting to %s, each with a token in %s:\n", out.Member.Name, filepath.Join(tokens, "<name>.token"))
	width := 0
	for _, a := range out.Agents {
		width = max(width, len(strings.Join(a.Skills, ", ")))
	}
	for _, a := range out.Agents {
		fmt.Fprintf(w, "  %-9s %-*s   %s\n", a.Member.Name, width, strings.Join(a.Skills, ", "), a.Member.Agent.Model)
	}
}

// writeToken keeps an agent's token secret in dir/<name>.token, readable by this user alone.
func writeToken(dir, name, secret string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, name+".token"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// A file left by an earlier Install keeps its mode on open; this one is the secret's.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.WriteString(secret + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// sweepEvery is how often the server records the lapses of expired Claims, for visibility.
const sweepEvery = time.Second

func serve(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.LoadServe(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var sender mail.Sender
	if cfg.SMTP.URL != "" {
		smtp, err := mail.NewSMTP(cfg.SMTP.URL, cfg.SMTP.From)
		if err != nil {
			return err
		}
		sender = smtp
		log.Info("emailed sign-in is on", "smtp", smtp.String())
	}

	st, err := openStore(ctx, cfg.Store, migrateAtStart(cfg), log)
	if err != nil {
		return err
	}
	defer st.Close()

	// Evidence on disk by default; a bucket that cannot be reached stops the start, rather than
	// the first upload.
	blobs, err := blob.Open(ctx, cfg.Evidence, nil)
	if err != nil {
		return err
	}
	if cfg.Evidence.S3 != nil {
		log.Info("Evidence is kept in S3-compatible storage", "bucket", cfg.Evidence.S3.String())
	}
	// Files, such as avatars, likewise: on disk by default, beside Evidence.
	files, err := blob.Open(ctx, cfg.Files, nil)
	if err != nil {
		return err
	}
	if cfg.Files.S3 != nil {
		log.Info("files are kept in S3-compatible storage", "bucket", cfg.Files.S3.String())
	}

	n := wake.New()
	if st.Engine() == store.Postgres {
		// Other server processes on this database wake this one's waiters, and it theirs (ADR 0006).
		pg, err := wake.ListenPostgres(ctx, n, st, cfg.DatabaseListenURL(), log)
		if err != nil {
			return err
		}
		defer pg.Close()
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	api := server.New(st, server.Options{Log: log, PublicURL: cfg.PublicURL, Wake: n, Mail: sender,
		MailPerHour: cfg.SMTP.MaxPerHour, ProxyHops: cfg.ProxyHops, Blobs: blobs, MaxEvidenceSize: cfg.EvidenceMaxMB << 20,
		Files: files, MaxFileSize: cfg.FilesMaxMB << 20,
		Sessions: auth.SessionLimits{Idle: cfg.SessionIdle, Lifetime: cfg.SessionLifetime, TokenIdle: cfg.TokenSessionIdle}, MaxWaiting: cfg.MaxWaiting})
	// Requests share a context that ends at shutdown, so Activity streams and waiting `next`
	// calls return instead of holding the shutdown to its timeout.
	reqCtx, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	srv := &http.Server{
		Handler: api.Handler(),
		// No write timeout: the Activity stream and the long-poll `next` hold responses open. No
		// read timeout either, which would end them too: the server bounds each request's body
		// instead (server.Options.BodyReadTimeout).
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return reqCtx },
	}
	srv.RegisterOnShutdown(cancelRequests)
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	base := config.BaseURL(cfg.PublicURL, ln.Addr().String())
	log.Info("darkory is serving", "version", version.Version, "url", base, "listen", ln.Addr().String(), "engine", st.Engine(), "sign_in", api.SignInModes())
	if host, _, _ := net.SplitHostPort(ln.Addr().String()); net.ParseIP(host).IsUnspecified() {
		log.Info("listening on every network interface, so other machines can reach this Install; every request still needs a token or a signed-in browser (--listen 127.0.0.1:7357 keeps it to this machine)")
	}

	// The Runner is a client of the server it sits beside (plan invariant 9): it reaches it on the
	// listen address, whatever the public URL. It stops before the server does, so its last
	// releases and Evidence still reach it.
	run, err := serveRunner(cfg, ln.Addr().String(), log)
	if err != nil {
		srv.Close()
		return err
	}
	runCtx, stopRunner := context.WithCancel(context.Background())
	defer stopRunner()
	runDone := make(chan struct{})
	if run == nil {
		close(runDone)
	} else {
		api.AttachRunner(run)
		go func() {
			defer close(runDone)
			if err := run.Run(runCtx); err != nil {
				log.Warn("the Runner is not running agents", "err", err)
			}
		}()
	}

	go housekeeping(ctx, api.Core(), log)
	if !cfg.NoUpdateCheck {
		go api.WatchForUpdates(ctx)
	}
	announceSignIn(ctx, api.Core(), cfg, base, stdout, log)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	stopRunner()
	select {
	case <-runDone:
	case <-time.After(10 * time.Second):
		log.Warn("the Runner did not stop within 10 s")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// serveRunner is the Runner serve runs beside the server, or nil: with --runner=auto, only when
// <data>/agents holds agent tokens.
func serveRunner(cfg config.Serve, listen string, log *slog.Logger) (*runner.Runner, error) {
	if cfg.Runner == "off" {
		return nil, nil
	}
	dir := runner.TokenDir(cfg.DataDir)
	tokens, err := runner.ReadTokens(dir)
	if err != nil {
		return nil, err
	}
	if len(tokens) == 0 {
		if cfg.Runner == "on" {
			return nil, fmt.Errorf("--runner=on, but %s holds no agent tokens", dir)
		}
		return nil, nil
	}
	return newRunner(config.BaseURL("", listen), cfg.DataDir, cfg.Workspaces, tokens, nil, or(os.Getenv("DARKORY_RUNNER_TMUX"), "auto"), log)
}

// openDatabase opens the record cfg names, creating the data directory for SQLite.
func openDatabase(ctx context.Context, cfg config.Store) (*store.Store, error) {
	if store.EngineOf(cfg.Database) == store.SQLite {
		if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
			return nil, err
		}
	}
	return store.Open(ctx, cfg.Database)
}

// migrateAtStart says whether serve migrates as it starts: always on SQLite, after a backup, and
// on Postgres only when asked, since Cloud migrates as its own step before a rollout (ADR 0009).
func migrateAtStart(cfg config.Serve) bool {
	return store.EngineOf(cfg.Database) == store.SQLite || cfg.Migrate
}

// migrate applies the pending migrations to the database and exits, for a Cloud rollout, or with
// --dry-run lists them (ADR 0009). It backs up a SQLite file first, as serve does.
func migrate(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.LoadMigrate(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	st, err := openDatabase(ctx, cfg.Store)
	if err != nil {
		return err
	}
	defer st.Close()
	pending, err := st.Pending(ctx)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		fmt.Fprintln(stdout, "No pending migrations.")
		return nil
	}
	if cfg.DryRun {
		fmt.Fprintf(stdout, "%d pending migration(s), not applied:\n", len(pending))
		for _, m := range pending {
			fmt.Fprintf(stdout, "  %s\n", m)
		}
		return nil
	}
	res, err := st.Migrate(ctx)
	if res.Backup != "" {
		fmt.Fprintf(stdout, "Backed up the database to %s\n", res.Backup)
	}
	names := map[int]string{}
	for _, m := range pending {
		names[m.Version] = m.String()
	}
	for _, v := range res.Applied {
		fmt.Fprintf(stdout, "Applied %s\n", names[v])
	}
	return err
}

func migrationList(ms []store.Migration) string {
	names := make([]string, len(ms))
	for i, m := range ms {
		names[i] = m.String()
	}
	return strings.Join(names, ", ")
}

// announceSignIn prints the startup login link unless --no-login-link says not to issue one, as
// for a container whose output is shipped to logs others read.
func announceSignIn(ctx context.Context, svc *core.Service, cfg config.Serve, base string, stdout io.Writer, log *slog.Logger) {
	if cfg.NoLoginLink {
		log.Info("not issuing a startup login link (--no-login-link); an admin issues one with POST /v1/members/{member}/login-links")
		return
	}
	printStartupLink(ctx, svc, base, !cfg.NoBrowser, stdout, log)
}

// printStartupLink prints a one-time login link for the Member `darkory init` created, and opens
// it in a browser when asked (ADR 0008).
func printStartupLink(ctx context.Context, svc *core.Service, base string, open bool, stdout io.Writer, log *slog.Logger) {
	m, link, err := svc.StartupLink(ctx)
	if errors.Is(err, core.ErrNotInitialised) {
		log.Warn("this Install holds no Organisation yet; run darkory init")
		return
	}
	if err != nil {
		log.Error("could not issue the startup login link", "err", err)
		return
	}
	url := server.LoginURL(base, link.Code)
	fmt.Fprintf(stdout, "Sign in as %s within %d minutes (the link works once):\n  %s\n", m.Name, int(core.LoginLinkTTL.Minutes()), url)
	if open {
		if err := openBrowser(url); err != nil {
			log.Info("could not open a browser; open the link yourself", "err", err)
		}
	}
}

// openBrowser opens url in the desktop's browser.
var openBrowser = func(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// housekeeping records the lapses of expired Claims every second, so the Task's Owner sees them
// promptly — correctness never waits for it (ADR 0004) — then closes the token Sessions gone idle,
// and drops idempotency responses older than a day, every hour.
func housekeeping(ctx context.Context, svc *core.Service, log *slog.Logger) {
	sweep := time.NewTicker(sweepEvery)
	defer sweep.Stop()
	purge := time.NewTicker(time.Hour)
	defer purge.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			if n, err := svc.Sweep(ctx); err != nil && ctx.Err() == nil {
				log.Error("sweeping lapsed Claims", "err", err)
			} else if n > 0 {
				log.Info("recorded lapsed Claims", "count", n)
			}
			// After the lapses, so a Session whose last Claim just lapsed is closed with it recorded.
			if n, err := svc.SweepSessions(ctx); err != nil && ctx.Err() == nil {
				log.Error("closing idle Sessions", "err", err)
			} else if n > 0 {
				log.Info("closed idle Sessions", "count", n)
			}
		case <-purge.C:
			if err := svc.PurgeIdempotencyKeys(ctx); err != nil && ctx.Err() == nil {
				log.Error("purging idempotency keys", "err", err)
			}
		}
	}
}
