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
	"os/signal"
	"syscall"
	"time"

	"github.com/tuongaz/darkory/internal/config"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/version"
)

const usage = `darkory: management for a software factory of agents and humans.

Usage:
  darkory serve [--listen addr] [--data dir] [--db dsn]   run the server
  darkory version                                         print the version
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
	case "serve":
		return serve(args[1:], stderr)
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

func serve(args []string, stderr io.Writer) error {
	cfg, err := config.LoadServe(args, os.Getenv, stderr)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if store.EngineOf(cfg.Database) == store.SQLite {
		if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
			return err
		}
	}
	st, err := store.Open(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := st.Migrate(ctx)
	if err != nil {
		return err
	}
	if res.Backup != "" {
		log.Info("backed up the database before migrating", "backup", res.Backup)
	}
	if len(res.Applied) > 0 {
		log.Info("migrated the database", "applied", res.Applied)
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler: server.New(st).Handler(),
		// No write timeout: the Activity stream and the long-poll `next` hold responses open.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	log.Info("darkory is serving", "version", version.Version, "url", "http://"+ln.Addr().String(), "engine", st.Engine())

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
