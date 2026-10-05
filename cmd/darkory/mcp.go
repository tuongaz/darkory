package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/mcp"
)

const mcpUsage = `Usage: darkory mcp [--url url] [--token dk_…] [--session id]

Serves the agent operations as MCP tools over standard input and output. It reads DARKORY_URL,
DARKORY_TOKEN and DARKORY_SESSION (a fresh Session id per process when unset), and sends
Heartbeats for its Session's Claims while it runs.

`

// runMCP is `darkory mcp`: an MCP server over stdio (ADR 0005).
func runMCP(args []string, stderr io.Writer) error {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprint(stderr, mcpUsage)
		fs.PrintDefaults()
	}
	s := remote.FromEnv(os.Getenv)
	fs.StringVar(&s.URL, "url", s.URL, "the Install's URL (DARKORY_URL)")
	fs.StringVar(&s.Token, "token", s.Token, "the Member's token (DARKORY_TOKEN)")
	fs.StringVar(&s.Session, "session", s.Session, "this running copy's Session id (DARKORY_SESSION)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("mcp takes no arguments, got %q", fs.Args())
	}
	if s.Token == "" {
		return errors.New("mcp: no token: set DARKORY_TOKEN or pass --token")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Standard output carries the protocol; what the agent need not see goes to standard error.
	srv, err := mcp.New(mcp.Options{Settings: s, Log: slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))})
	if err != nil {
		return err
	}
	err = srv.Run(ctx, &sdk.StdioTransport{})
	if ctx.Err() != nil {
		return nil
	}
	return err
}
