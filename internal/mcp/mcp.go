// Package mcp is `darkory mcp`: an MCP server over stdio that gives an agent the operations of
// /v1 as tools, written on the generated client like the CLI (plan invariant 9). While it runs it
// sends Heartbeats for every Claim its Session holds with a heartbeat timeout, and tells the agent
// in its next tool result when one lapses or is taken back (ADR 0005).
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/version"
)

// Options configure a Server.
type Options struct {
	// Settings say which Install to reach and as whom; an empty Session gets a fresh id, which
	// lasts as long as the process.
	Settings remote.Settings
	// HeartbeatEvery says how often to heartbeat a Claim with a given timeout; nil means a third.
	HeartbeatEvery func(time.Duration) time.Duration
	// ListEvery is how often to look for Claims this Session made elsewhere; zero means 30 s.
	ListEvery time.Duration
	// Log receives what the agent need not see, such as a Heartbeat that will be tried again.
	Log *slog.Logger
}

// Server is the MCP server for one Member and Session.
type Server struct {
	conn   *remote.Conn
	keeper *remote.Keeper
	mcp    *sdk.Server
	log    *slog.Logger

	mu      sync.Mutex
	notices []string
}

// mcpPreamble comes before the working rules in the server's instructions.
const mcpPreamble = `This MCP server is the darkory CLI as tools: next, claim, show_task, note, observe,
attach_evidence, handover, complete, release, file_task (with blocks for a question), and so on.
Where the rules below name a darkory command, call the tool of that name. This server sends
Heartbeats for the Claims its Session makes while it runs, so you need not call heartbeat
yourself; when a Claim lapses or is taken back, the next tool result says so — then stop working
that Task.

`

// New returns a Server; nothing is sent until a tool is called or Run starts the Heartbeats.
func New(o Options) (*Server, error) {
	if o.Settings.Session == "" {
		o.Settings.Session = remote.NewSessionID()
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	conn, err := remote.Dial(o.Settings)
	if err != nil {
		return nil, err
	}
	s := &Server{conn: conn, log: o.Log}
	listEvery := o.ListEvery
	if listEvery <= 0 {
		listEvery = 30 * time.Second
	}
	s.keeper = &remote.Keeper{
		Conn:      conn,
		Every:     o.HeartbeatEvery,
		ListEvery: listEvery,
		OnNotice:  func(n remote.Notice) { s.notify(n.String()) },
		OnError:   func(err error) { s.log.Warn("darkory mcp", "err", err) },
	}
	s.mcp = sdk.NewServer(&sdk.Implementation{Name: "darkory", Title: "Darkory", Version: version.Version},
		&sdk.ServerOptions{Instructions: mcpPreamble + remote.Rules, Logger: o.Log})
	s.addTools()
	s.addRules()
	return s, nil
}

// Session is the Session id the server acts in.
func (s *Server) Session() string { return s.conn.Settings.Session }

// MCP is the underlying MCP server.
func (s *Server) MCP() *sdk.Server { return s.mcp }

// Run serves one client over t and keeps this Session's Claims alive until the client goes away
// or ctx ends.
func (s *Server) Run(ctx context.Context, t sdk.Transport) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	kept := make(chan error, 1)
	go func() { kept <- s.keeper.Run(ctx) }()
	err := s.mcp.Run(ctx, t)
	cancel()
	if kerr := <-kept; errors.Is(kerr, remote.ErrStopped) {
		s.log.Warn("darkory mcp stopped sending Heartbeats", "err", kerr)
	}
	return err
}

func (s *Server) notify(msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.notices = append(s.notices, msg)
}

func (s *Server) drain() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.notices
	s.notices = nil
	return out
}

func (s *Server) addRules() {
	s.mcp.AddPrompt(&sdk.Prompt{Name: "prime", Title: "Darkory working rules",
		Description: "The working rules for an agent's Darkory Session: read them before taking work."},
		func(context.Context, *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
			return &sdk.GetPromptResult{Description: "Darkory working rules", Messages: []*sdk.PromptMessage{
				{Role: "user", Content: &sdk.TextContent{Text: mcpPreamble + remote.Rules}}}}, nil
		})
	s.mcp.AddResource(&sdk.Resource{URI: RulesURI, Name: "rules", Title: "Darkory working rules", MIMEType: "text/markdown",
		Description: "The working rules for an agent's Darkory Session."},
		func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
			return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{
				{URI: RulesURI, MIMEType: "text/markdown", Text: mcpPreamble + remote.Rules}}}, nil
		})
}

// RulesURI is the resource holding the working rules.
const RulesURI = "darkory://rules"

// tool adds a tool whose input schema is inferred from In and whose structured output is Out.
// A failed call is a tool error whose text starts with the Error code; any Claim notices queued
// by the Heartbeats ride along on every result.
func tool[In, Out any](s *Server, name, description string, fn func(context.Context, In) (Out, error), tweak ...func(*jsonschema.Schema)) {
	in, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Sprintf("tool %s: input schema: %v", name, err))
	}
	for _, f := range tweak {
		f(in)
	}
	out, err := jsonschema.For[Out](nil)
	if err != nil {
		panic(fmt.Sprintf("tool %s: output schema: %v", name, err))
	}
	sdk.AddTool(s.mcp, &sdk.Tool{Name: name, Description: description, InputSchema: in, OutputSchema: out},
		func(ctx context.Context, _ *sdk.CallToolRequest, input In) (*sdk.CallToolResult, any, error) {
			v, err := fn(ctx, input)
			notices := s.drain()
			if err != nil {
				return failure(err, notices), nil, nil
			}
			b, err := json.Marshal(v)
			if err != nil {
				return nil, nil, err
			}
			res := &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(b)}}}
			withNotices(res, notices)
			return res, v, nil
		})
}

// failure is the tool error for err: its text is "<code>: <message>", and _meta carries the
// Error as darkory/error.
func failure(err error, notices []string) *sdk.CallToolResult {
	e := map[string]any{"message": err.Error()}
	text := err.Error()
	var re *remote.Error
	if errors.As(err, &re) && re.Code != "" {
		e = map[string]any{"code": string(re.Code), "message": re.Message}
		if re.Details != nil {
			e["details"] = re.Details
		}
		text = string(re.Code) + ": " + re.Message
		if re.Refused() {
			text += "\n(The record refused this on one of its rules; read the message rather than retrying.)"
		}
	}
	res := &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: text}}, Meta: sdk.Meta{"darkory/error": e}}
	withNotices(res, notices)
	return res
}

func withNotices(res *sdk.CallToolResult, notices []string) {
	if len(notices) == 0 {
		return
	}
	res.Content = append(res.Content, &sdk.TextContent{Text: "Claim notice: " + strings.Join(notices, "\nClaim notice: ")})
	if res.Meta == nil {
		res.Meta = sdk.Meta{}
	}
	res.Meta["darkory/claim_notices"] = notices
}

// enum restricts a property of a tool's input to values.
func enum(property string, values ...any) func(*jsonschema.Schema) {
	return func(s *jsonschema.Schema) {
		if p, ok := s.Properties[property]; ok {
			p.Enum = values
		}
	}
}
