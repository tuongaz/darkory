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
	"slices"
	"strconv"
	"syscall"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/tuongaz/darkory/internal/cli"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/mcp"
)

const mcpUsage = `Usage: darkory mcp [--url url] [--token dk_…] [--session id] [--insecure] [--evidence-root dir]
                   [--evidence-allow-hidden] [--evidence-max-mb n] [--no-heartbeat]

Serves the agent operations as MCP tools over standard input and output. It reads DARKORY_URL,
DARKORY_TOKEN and DARKORY_SESSION (a fresh Session id per process when unset), and sends
Heartbeats for its Session's Claims while it runs, unless --no-heartbeat (DARKORY_MCP_NO_HEARTBEAT=1)
leaves them to the Runner that started the Shift. attach_evidence reads only regular files under
the evidence root (the working directory unless set), none hidden unless allowed. A plain http://
URL must name this machine unless --insecure (DARKORY_INSECURE=1) is given, since the token would
cross the network in clear text. Prefer DARKORY_TOKEN to --token, which other processes can read.

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
	fs.BoolVar(&s.Insecure, "insecure", s.Insecure, "allow plain http:// to a host other than this machine (DARKORY_INSECURE)")
	var o mcp.Options
	fs.StringVar(&o.EvidenceRoot, "evidence-root", os.Getenv("DARKORY_EVIDENCE_ROOT"),
		"the only directory attach_evidence reads from (DARKORY_EVIDENCE_ROOT; default the working directory)")
	fs.BoolVar(&o.EvidenceAllowHidden, "evidence-allow-hidden", false, "let attach_evidence send files under names starting with a dot")
	maxMB := int64(mcp.DefaultEvidenceMaxMB)
	if v := os.Getenv("DARKORY_EVIDENCE_MAX_MB"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return fmt.Errorf("DARKORY_EVIDENCE_MAX_MB is a number of MiB, got %q", v)
		}
		maxMB = n
	}
	fs.Int64Var(&o.EvidenceMaxMB, "evidence-max-mb", maxMB, "the largest file attach_evidence sends, in MiB (DARKORY_EVIDENCE_MAX_MB)")
	noHeartbeat := !slices.Contains([]string{"", "0", "false"}, os.Getenv("DARKORY_MCP_NO_HEARTBEAT"))
	fs.BoolVar(&o.NoHeartbeats, "no-heartbeat", noHeartbeat, "send no Heartbeats: the Runner that started the Shift sends them (DARKORY_MCP_NO_HEARTBEAT)")
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
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "token" {
			fmt.Fprintln(stderr, "darkory mcp: warning: --token shows the token to other processes on this machine, "+
				"which can read a command's arguments; set DARKORY_TOKEN instead")
		}
	})
	if err := s.CheckURL(); err != nil {
		fmt.Fprintf(stderr, "darkory mcp: %v\n", err)
		return &cli.ExitError{Code: cli.ExitUsage}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Standard output carries the protocol; what the agent need not see goes to standard error.
	if o.EvidenceMaxMB < 1 {
		return fmt.Errorf("--evidence-max-mb is 1 or more, got %d", o.EvidenceMaxMB)
	}
	o.Settings = s
	o.Log = slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	srv, err := mcp.New(o)
	if err != nil {
		return err
	}
	err = srv.Run(ctx, &sdk.StdioTransport{})
	if ctx.Err() != nil {
		return nil
	}
	return err
}
