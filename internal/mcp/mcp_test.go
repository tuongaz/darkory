package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// fixture is an Install with the Team WEB, the Skill build, and the agent bob in WEB with build,
// who has filed the Feature WEB-1 (and its Break down WEB-2) and the Task WEB-3 needing build.
type fixture struct {
	t   *testing.T
	url string
	bob string // bob's token
}

func newFixture(t *testing.T, st *store.Store, o server.Options) *fixture {
	t.Helper()
	ctx := t.Context()
	srv := server.New(st, o)
	init, err := srv.Core().Init(ctx, "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	ada := dial(t, ts.URL, init.Token.Secret, "ada-1")
	must(t)(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"}))
	must(t)(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: "build", Kind: client.Generic, Body: "Build it."}))
	must(t)(ada.CreateMemberWithResponse(ctx, &client.CreateMemberParams{}, client.CreateMemberBody{Name: "bob", Kind: client.Agent}))
	must(t)(ada.AddTeamMemberWithResponse(ctx, "WEB", "bob", &client.AddTeamMemberParams{}))
	must(t)(ada.GrantSkillWithResponse(ctx, "bob", "build", &client.GrantSkillParams{}))
	tok, err := ada.IssueTokenWithResponse(ctx, "bob", &client.IssueTokenParams{}, client.IssueTokenBody{Name: "bob"})
	must(t)(tok, err)
	bob := dial(t, ts.URL, tok.JSON201.Secret, "bob-setup")
	must(t)(bob.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Search"}))
	must(t)(bob.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: ptr("WEB-1"), Skill: ptr("build"), Title: "Build search"}))
	return &fixture{t: t, url: ts.URL, bob: tok.JSON201.Secret}
}

func ptr[T any](v T) *T { return &v }

func dial(t *testing.T, url, token, session string) *remote.Conn {
	t.Helper()
	c, err := remote.Dial(remote.Settings{URL: url, Token: token, Session: session})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// must fails the test unless a generated client call succeeded.
func must(t *testing.T) func(remote.Response, error) {
	return func(res remote.Response, err error) {
		t.Helper()
		if err := remote.Check(res, err, http.StatusOK, http.StatusCreated, http.StatusNoContent); err != nil {
			t.Fatal(err)
		}
	}
}

// connect starts an MCP server for bob in Session session and returns a client connected to it
// over the SDK's in-memory transport.
func (f *fixture) connect(session string, o Options) (*Server, *sdk.ClientSession) {
	f.t.Helper()
	o.Settings = remote.Settings{URL: f.url, Token: f.bob, Session: session}
	srv, err := New(o)
	if err != nil {
		f.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ct, st := sdk.NewInMemoryTransports()
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.Run(ctx, st)
	}()
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "test-agent", Version: "1"}, nil).Connect(f.t.Context(), ct, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		cs.Close()
		cancel()
		<-done
	})
	return srv, cs
}

// call calls a tool and returns its result, failing on a protocol error.
func call(t *testing.T, cs *sdk.ClientSession, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

// ok calls a tool that must succeed and decodes its structured output into v.
func ok(t *testing.T, cs *sdk.ClientSession, v any, name string, args map[string]any) *sdk.CallToolResult {
	t.Helper()
	res := call(t, cs, name, args)
	if res.IsError {
		t.Fatalf("%s failed: %s", name, text(res))
	}
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s gave %s: %v", name, b, err)
	}
	return res
}

func text(res *sdk.CallToolResult) string {
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			b.WriteString(tc.Text + "\n")
		}
	}
	return b.String()
}

// The server lists a tool for each agent operation, each with input and output schemas, and gives
// the working rules as its instructions, a prompt and a resource.
func TestToolsAndRules(t *testing.T) {
	f := newFixture(t, storetest.Open(t, store.SQLite), server.Options{})
	_, cs := f.connect("bob-mcp", Options{})
	tools, err := cs.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range tools.Tools {
		names = append(names, tl.Name)
		if tl.InputSchema == nil || tl.OutputSchema == nil || tl.Description == "" {
			t.Errorf("%s lacks a schema or description", tl.Name)
		}
	}
	for _, want := range []string{"next", "takeable", "claim", "heartbeat", "release", "handover", "complete", "note", "observe",
		"attach_evidence", "file_task", "block", "unblock", "show_task", "list_tasks", "feature_show", "observations",
		"skill_show", "propose_skill_version", "me", "activity"} {
		if !slices.Contains(names, want) {
			t.Errorf("no tool %s in %v", want, names)
		}
	}
	if ins := cs.InitializeResult().Instructions; !strings.Contains(ins, "darkory next") || !strings.Contains(ins, "need not call heartbeat") {
		t.Errorf("instructions: %q", ins)
	}
	p, err := cs.GetPrompt(t.Context(), &sdk.GetPromptParams{Name: "prime"})
	if err != nil || len(p.Messages) != 1 || !strings.Contains(p.Messages[0].Content.(*sdk.TextContent).Text, "Hand over rather than skip review") {
		t.Errorf("prime prompt: %+v, %v", p, err)
	}
	r, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: RulesURI})
	if err != nil || len(r.Contents) != 1 || !strings.Contains(r.Contents[0].Text, "Record Observations") {
		t.Errorf("rules resource: %+v, %v", r, err)
	}
	// An argument the schema rules out is refused before anything is sent.
	if res := call(t, cs, "observe", map[string]any{"task": "WEB-3", "outcome": "meh", "body": "x"}); !res.IsError {
		t.Errorf("observe with a bad outcome: %s", text(res))
	}
}

// next, claim and complete through MCP; a refusal is a tool error carrying its code.
func TestNextClaimComplete(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st, server.Options{})
		srv, cs := f.connect("bob-mcp", Options{})

		var next nextOut
		ok(t, cs, &next, "next", map[string]any{"wait_seconds": 0, "heartbeat_timeout_seconds": 60, "model_label": "test-model"})
		if !next.Claimed || next.Task == nil || next.Task.Task.Key != "WEB-2" || next.Task.Task.Claim == nil ||
			next.Task.Task.Claim.SessionID != "bob-mcp" || deref(next.Task.Task.Claim.ModelLabel) != "test-model" {
			t.Fatalf("next: %+v", next)
		}
		var claimed client.TaskDetail
		ok(t, cs, &claimed, "claim", map[string]any{"task": "WEB-3", "heartbeat_timeout_seconds": 60})
		if claimed.Task.Claim == nil || deref(claimed.Task.Claim.HeartbeatTimeoutSeconds) != 60 {
			t.Fatalf("claim: %+v", claimed.Task)
		}
		if held := srv.keeper.Held(); !slices.Equal(held, []string{"WEB-2", "WEB-3"}) {
			t.Fatalf("keeping %v alive", held)
		}

		var done client.Task
		ok(t, cs, &done, "complete", map[string]any{"task": "WEB-3", "note": "built"})
		if done.State != client.TaskStateDone {
			t.Fatalf("complete: %+v", done)
		}
		if held := srv.keeper.Held(); !slices.Equal(held, []string{"WEB-2"}) {
			t.Fatalf("after complete, keeping %v alive", held)
		}
		var released client.Task
		ok(t, cs, &released, "release", map[string]any{"task": "WEB-2", "note": "later"})

		// The released Break down is takeable again; after that nothing is.
		var again nextOut
		ok(t, cs, &again, "next", map[string]any{"wait_seconds": 0})
		if !again.Claimed || again.Task.Task.Key != "WEB-2" {
			t.Fatalf("next after release: %+v", again)
		}
		var nothing nextOut
		ok(t, cs, &nothing, "next", map[string]any{"wait_seconds": 0})
		if nothing.Claimed || nothing.Task != nil {
			t.Fatalf("next with nothing takeable: %+v", nothing)
		}

		// Claiming a held Task is refused: a tool error whose text and _meta carry the code.
		res := call(t, cs, "claim", map[string]any{"task": "WEB-2"})
		meta, _ := res.Meta["darkory/error"].(map[string]any)
		if !res.IsError || !strings.HasPrefix(text(res), "already_claimed: ") || meta["code"] != "already_claimed" {
			t.Fatalf("claim of a held Task: error %v, %q, meta %v", res.IsError, text(res), res.Meta)
		}
		res = call(t, cs, "show_task", map[string]any{"task": "WEB-99"})
		if !res.IsError || !strings.HasPrefix(text(res), "not_found: ") {
			t.Fatalf("show_task of nothing: %q", text(res))
		}

		var shown client.TaskDetail
		ok(t, cs, &shown, "show_task", map[string]any{"task": "WEB-3"})
		if len(shown.Notes) != 1 || shown.Notes[0].Body != "built" {
			t.Fatalf("show_task: %+v", shown.Notes)
		}
		var me client.Me
		ok(t, cs, &me, "me", nil)
		if me.Member.Name != "bob" || me.Session.ID != "bob-mcp" {
			t.Fatalf("me: %+v", me)
		}
		var list client.TaskList
		ok(t, cs, &list, "list_tasks", map[string]any{"mine": true})
		if len(list.Items) != 1 || list.Items[0].Key != "WEB-2" {
			t.Fatalf("list_tasks mine: %+v", list)
		}
		var page client.ActivityPage
		ok(t, cs, &page, "activity", map[string]any{"after": 0})
		if page.LastSeq == 0 || len(page.Items) == 0 {
			t.Fatalf("activity: %+v", page)
		}
	})
}

func deref[T any](p *T) T {
	var z T
	if p == nil {
		return z
	}
	return *p
}

// While the server runs, its Heartbeats keep a Claim with a short timeout alive.
func TestHeartbeatsKeepAClaimAlive(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st, server.Options{})
		_, cs := f.connect("bob-mcp", Options{})
		var claimed client.TaskDetail
		ok(t, cs, &claimed, "claim", map[string]any{"task": "WEB-3", "heartbeat_timeout_seconds": 2})
		time.Sleep(5 * time.Second)
		var shown client.TaskDetail
		ok(t, cs, &shown, "show_task", map[string]any{"task": "WEB-3"})
		if shown.Task.Claim == nil || shown.Task.Claim.ID != claimed.Task.Claim.ID || len(shown.Claims) != 1 {
			t.Fatalf("after 5 s on a 2 s timeout: %+v, Claims %+v", shown.Task.Claim, shown.Claims)
		}
	})
}

// A Claim that lapses under the server — here, the server's clock jumps past its expiry — is
// reported in the next tool result, and the server stops heartbeating it.
func TestALapsedClaimIsReported(t *testing.T) {
	fake := clock.NewFake(time.Now())
	f := newFixture(t, storetest.Open(t, store.SQLite), server.Options{Clock: fake})
	srv, cs := f.connect("bob-mcp", Options{HeartbeatEvery: func(time.Duration) time.Duration { return 100 * time.Millisecond }})
	var claimed client.TaskDetail
	ok(t, cs, &claimed, "claim", map[string]any{"task": "WEB-3", "heartbeat_timeout_seconds": 60})
	time.Sleep(300 * time.Millisecond) // a few Heartbeats go through
	fake.Advance(61 * time.Second)
	deadline := time.Now().Add(5 * time.Second)
	for len(srv.keeper.Held()) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the server still heartbeats a lapsed Claim")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var me client.Me
	res := ok(t, cs, &me, "me", nil)
	notices, _ := res.Meta["darkory/claim_notices"].([]any)
	if !strings.Contains(text(res), "Claim notice: your Claim on WEB-3 lapsed") || len(notices) != 1 {
		t.Fatalf("the next result says %q, meta %v", text(res), res.Meta)
	}
	// Reported once.
	res = ok(t, cs, &me, "me", nil)
	if strings.Contains(text(res), "Claim notice") {
		t.Fatalf("reported again: %q", text(res))
	}
	// The lapse made WEB-3 takeable again, and the server keeps the new Claim alive.
	ok(t, cs, &claimed, "claim", map[string]any{"task": "WEB-3", "heartbeat_timeout_seconds": 60})
	if held := srv.keeper.Held(); !slices.Equal(held, []string{"WEB-3"}) {
		t.Fatalf("after claiming again, keeping %v alive", held)
	}
}
