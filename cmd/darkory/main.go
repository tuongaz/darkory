// Command darkory is the Darkory server, and later its CLI and MCP server, in one binary.
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
	"runtime"
	"syscall"
	"time"

	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/version"
	"github.com/tuongaz/darkory/internal/wake"
)

const usage = `darkory: management for a software factory of agents and humans.

Usage:
  darkory init [--org name] [--name member] [--data dir] [--db dsn]   create the Organisation and its first Member
  darkory serve [--listen addr] [--data dir] [--db dsn] [--public-url url] [--no-browser]
                                                                       run the server
  darkory version                                                      print the version
`

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "darkory:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return errors.New("no command")
	}
	switch args[0] {
	case "init":
		return initInstall(args[1:], stdout, stderr)
	case "serve":
		return serve(args[1:], stdout, stderr)
	case "version", "--version":
		fmt.Fprintln(stdout, version.Version)
		return nil
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return nil
	}
	fmt.Fprint(stderr, usage)
	return fmt.Errorf("unknown command %q", args[0])
}

// openStore opens and migrates the record cfg names, creating the data directory for SQLite.
func openStore(ctx context.Context, cfg config.Store, log *slog.Logger) (*store.Store, error) {
	if store.EngineOf(cfg.Database) == store.SQLite {
		if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
			return nil, err
		}
	}
	st, err := store.Open(ctx, cfg.Database)
	if err != nil {
		return nil, err
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
// built-in Skills, and prints that Member's first token and a login link (ADR 0006).
func initInstall(args []string, stdout, stderr io.Writer) error {
	cfg, err := config.LoadInit(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	ctx := context.Background()
	st, err := openStore(ctx, cfg.Store, slog.New(slog.NewTextHandler(stderr, nil)))
	if err != nil {
		return err
	}
	defer st.Close()
	out, err := core.New(st, clock.Real{}, wake.New(), nil).Init(ctx, cfg.Org, cfg.Name)
	if errors.Is(err, core.ErrInitialised) {
		return fmt.Errorf("%s already holds an Organisation; darkory init runs once", cfg.Database)
	}
	if err != nil {
		return err
	}
	link := server.LoginURL(config.BaseURL(cfg.PublicURL, cfg.Listen), out.Link.Code)
	fmt.Fprintf(stdout, `Initialised the Organisation %q in %s.

First Member: %s (human, admin)

Token for %s, shown once; keep it safe:
  %s

Sign in with a browser within %d minutes, once darkory serve is running:
  %s

darkory serve prints a fresh login link every time it starts.
`, out.Organisation.Name, cfg.Database, out.Member.Name, out.Member.Name, out.Token.Secret,
		int(core.LoginLinkTTL.Minutes()), link)
	return nil
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

	st, err := openStore(ctx, cfg.Store, log)
	if err != nil {
		return err
	}
	defer st.Close()

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	api := server.New(st, server.Options{Log: log, PublicURL: cfg.PublicURL})
	// Requests share a context that ends at shutdown, so Activity streams and waiting `next`
	// calls return instead of holding the shutdown to its timeout.
	reqCtx, cancelRequests := context.WithCancel(context.Background())
	defer cancelRequests()
	srv := &http.Server{
		Handler: api.Handler(),
		// No write timeout: the Activity stream and the long-poll `next` hold responses open.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return reqCtx },
	}
	srv.RegisterOnShutdown(cancelRequests)
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	base := config.BaseURL(cfg.PublicURL, ln.Addr().String())
	log.Info("darkory is serving", "version", version.Version, "url", base, "engine", st.Engine())

	go housekeeping(ctx, api.Core(), log)
	printStartupLink(ctx, api.Core(), base, !cfg.NoBrowser, stdout, log)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
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

// housekeeping records the lapses of expired Claims every second, so the Feature owner sees them
// promptly — correctness never waits for it (ADR 0004) — and drops idempotency responses older
// than a day, every hour.
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
		case <-purge.C:
			if err := svc.PurgeIdempotencyKeys(ctx); err != nil && ctx.Err() == nil {
				log.Error("purging idempotency keys", "err", err)
			}
		}
	}
}
