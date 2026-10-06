package server

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/runnerapi"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Workspaces, Team defaults, quick and ship-when-done Features and agent settings through the
// generated client on both engines, with the codes and statuses of their refusals.
func TestWorkspacesAndAgentsThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddTeamMemberWithResponse(ctx, "WEB", "ada", &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
		for _, s := range []string{"build", "review"} {
			got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: s, Kind: client.Generic, Body: s})).
				want(t, http.StatusCreated)
		}
		bob, _ := h.member("bob", client.Agent, "WEB", "build")
		rev, _ := h.member("rev", client.Agent, "WEB", "review")

		res := got(bob.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "/src/web"})).
			want(t, http.StatusForbidden)
		if res.JSONDefault.Code != client.ErrorCodeForbidden {
			t.Fatalf("refused with %s", res.Body)
		}
		got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "web", Path: "relative"})).
			want(t, http.StatusBadRequest)
		mode := client.WorkspaceModePullRequest
		web := got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{IdempotencyKey: key("ws-1")},
			client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode, DefaultBranch: ptrStr("trunk")})).want(t, http.StatusCreated).JSON201
		if web.Kind != client.WorkspaceKindGit || web.Mode != client.WorkspaceModePullRequest || web.DefaultBranch != "trunk" {
			t.Fatalf("created %+v", web)
		}
		again := got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{IdempotencyKey: key("ws-1")},
			client.CreateWorkspaceBody{Name: "web", Path: "/src/web", Mode: &mode, DefaultBranch: ptrStr("trunk")})).want(t, http.StatusCreated).JSON201
		if again.ID != web.ID {
			t.Fatal("a retry made another Workspace")
		}
		conflict := got(ada.CreateWorkspaceWithResponse(ctx, &client.CreateWorkspaceParams{}, client.CreateWorkspaceBody{Name: "Web", Path: "/x"})).
			want(t, http.StatusConflict)
		if conflict.JSONDefault.Code != client.ErrorCodeConflict {
			t.Fatalf("refused with %s", conflict.Body)
		}
		plain := client.WorkspaceModePlain
		changed := got(ada.UpdateWorkspaceWithResponse(ctx, "web", &client.UpdateWorkspaceParams{}, client.UpdateWorkspaceBody{Mode: &plain})).
			want(t, http.StatusOK).JSON200
		if changed.Mode != client.WorkspaceModePlain || changed.DefaultBranch != "trunk" {
			t.Fatalf("changed %+v", changed)
		}
		list := got(bob.ListWorkspacesWithResponse(ctx)).want(t, http.StatusOK).JSON200.Items
		if len(list) != 1 || list[0].ID != web.ID {
			t.Fatalf("listed %+v", list)
		}

		team := got(ada.UpdateTeamWithResponse(ctx, "WEB", &client.UpdateTeamParams{}, client.UpdateTeamBody{DefaultWorkspace: ptrStr("web"),
			ShipWhenDone: ptrBool(true)})).want(t, http.StatusOK).JSON200
		if team.DefaultWorkspaceID == nil || *team.DefaultWorkspaceID != web.ID || !team.ShipWhenDone {
			t.Fatalf("WEB %+v", team)
		}
		got(bob.UpdateTeamWithResponse(ctx, "WEB", &client.UpdateTeamParams{}, client.UpdateTeamBody{ShipWhenDone: ptrBool(false)})).
			want(t, http.StatusForbidden)

		// A Feature takes the Team's ship_when_done; its Tasks the Team's Workspace.
		f := got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Checkout"})).
			want(t, http.StatusCreated).JSON201
		if !f.Feature.ShipWhenDone || f.Feature.Quick || f.Tasks[0].WorkspaceIds == nil || (*f.Tasks[0].WorkspaceIds)[0] != web.ID {
			t.Fatalf("filed %+v with %+v", f.Feature, f.Tasks[0])
		}
		task := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Pay",
			Skill: ptrStr("build"), Workspaces: &[]string{"WEB"}})).want(t, http.StatusCreated).JSON201
		if len(task.Workspaces) != 1 || task.Workspaces[0].Name != "web" || task.Workspaces[0].Path != "/src/web" {
			t.Fatalf("the Task's Workspaces %+v", task.Workspaces)
		}
		none := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Ask",
			AimedAt: ptrStr("ada"), Workspaces: &[]string{}})).want(t, http.StatusCreated).JSON201
		if none.Task.WorkspaceIds != nil || len(none.Workspaces) != 0 {
			t.Fatalf("named none, got %v %+v", none.Task.WorkspaceIds, none.Workspaces)
		}
		if raw := string(got(ada.GetTaskWithResponse(ctx, none.Task.Key)).want(t, http.StatusOK).Body); !strings.Contains(raw, `"workspaces":[]`) ||
			strings.Contains(raw, "workspace_ids") {
			t.Fatalf("a Task naming none reads %s", raw)
		}
		missing := got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Lost",
			Skill: ptrStr("build"), Workspaces: &[]string{"nowhere"}})).want(t, http.StatusNotFound)
		if missing.JSONDefault.Code != client.ErrorCodeNotFound {
			t.Fatalf("refused with %s", missing.Body)
		}
		got(ada.RemoveWorkspaceWithResponse(ctx, "web", &client.RemoveWorkspaceParams{})).want(t, http.StatusConflict)

		// A quick Feature: one Task, built and reviewed, ships with no Retrospective.
		got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Fix", Quick: ptrBool(true)})).
			want(t, http.StatusBadRequest)
		q := got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Fix the footer",
			Quick: ptrBool(true), Skill: ptrStr("build")})).want(t, http.StatusCreated).JSON201
		if !q.Feature.Quick || !q.Feature.ShipWhenDone || len(q.Tasks) != 1 || q.Tasks[0].Kind != client.Work || q.Tasks[0].Title != "Fix the footer" {
			t.Fatalf("quick: %+v %+v", q.Feature, q.Tasks)
		}
		key := q.Tasks[0].Key
		got(bob.ClaimTaskWithResponse(ctx, key, &client.ClaimTaskParams{}, client.ClaimTaskBody{HeartbeatTimeoutSeconds: ptrInt(0)})).want(t, http.StatusOK)
		got(bob.HandoverTaskWithResponse(ctx, key, &client.HandoverTaskParams{}, client.HandoverTaskBody{Skill: "review"})).want(t, http.StatusOK)
		got(rev.ClaimTaskWithResponse(ctx, key, &client.ClaimTaskParams{}, client.ClaimTaskBody{HeartbeatTimeoutSeconds: ptrInt(0)})).want(t, http.StatusOK)
		got(rev.CompleteTaskWithResponse(ctx, key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})).want(t, http.StatusOK)
		shipped := got(ada.GetFeatureWithResponse(ctx, q.Feature.Key)).want(t, http.StatusOK).JSON200
		if shipped.Feature.State != client.FeatureStateShipped || len(shipped.Tasks) != 1 {
			t.Fatalf("after the review: %+v with %d Tasks", shipped.Feature, len(shipped.Tasks))
		}
		kinds := []client.ActivityKind{client.ActivityKindFeatureShipped}
		page := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Kind: &kinds})).want(t, http.StatusOK).JSON200
		if len(page.Items) != 1 || page.Items[0].Payload["ship_when_done"] != true || page.Items[0].SubjectType != client.SubjectTypeFeature {
			t.Fatalf("feature.shipped %+v", page.Items)
		}

		// Agent settings: admins only, agents only.
		got(ada.SetAgentSettingsWithResponse(ctx, "ada", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{Paused: ptrBool(true)})).
			want(t, http.StatusBadRequest)
		got(bob.SetAgentSettingsWithResponse(ctx, "bob", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{Paused: ptrBool(true)})).
			want(t, http.StatusForbidden)
		m := got(ada.SetAgentSettingsWithResponse(ctx, "bob", &client.SetAgentSettingsParams{}, client.SetAgentSettingsBody{
			Model: ptrStr("claude-opus-5-5"), Env: &map[string]string{"FOO": "bar"}})).want(t, http.StatusOK).JSON200
		if m.Agent == nil || m.Agent.Command != "claude" || m.Agent.Model != "claude-opus-5-5" || m.Agent.Env["FOO"] != "bar" ||
			!m.Agent.Unattended || m.Agent.Paused || m.Agent.ProgressFile != nil || !slices.Contains(m.Agent.Args, "{prompt_file}") {
			t.Fatalf("settings %+v", m.Agent)
		}
		members := got(rev.ListMembersWithResponse(ctx, &client.ListMembersParams{})).want(t, http.StatusOK).JSON200.Items
		for _, mm := range members {
			if (mm.Name == "bob") != (mm.Agent != nil) {
				t.Fatalf("%s listed with settings %+v", mm.Name, mm.Agent)
			}
		}
		kinds = []client.ActivityKind{client.ActivityKindMemberAgentChanged, client.ActivityKindWorkspaceAdded, client.ActivityKindWorkspaceChanged, client.ActivityKindTeamChanged}
		page = got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Kind: &kinds})).want(t, http.StatusOK).JSON200
		var seen []string
		for _, a := range page.Items {
			seen = append(seen, string(a.Kind)+":"+string(a.SubjectType))
		}
		if want := []string{"workspace.added:workspace", "workspace.changed:workspace", "team.changed:team", "member.agent_changed:member"}; !slices.Equal(seen, want) {
			t.Fatalf("Activity %v, want %v", seen, want)
		}
	})
}

// fakeRunner stands in for the Runner: one session on a Task, and a terminal that says who
// joined, read-only or not, and echoes what a writer sends.
type fakeRunner struct {
	mu       sync.Mutex
	sessions []runnerapi.Session
	nudged   []string
	stopped  []string
}

func (f *fakeRunner) Sessions() []runnerapi.Session {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sessions)
}

func (f *fakeRunner) Nudge(task string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nudged = append(f.nudged, task)
	return nil
}

func (f *fakeRunner) Stop(task string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, task)
	return nil
}

func (f *fakeRunner) Attach(ctx context.Context, task string, readonly bool, conn *websocket.Conn) error {
	v, _ := runnerapi.ViewerOf(ctx)
	hello, _ := json.Marshal(map[string]any{"task": task, "readonly": readonly, "viewer": v.Name})
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}
	for {
		typ, b, err := conn.Read(ctx)
		if err != nil {
			return nil
		}
		if !readonly && typ == websocket.MessageBinary {
			if err := conn.Write(ctx, websocket.MessageBinary, b); err != nil {
				return err
			}
		}
	}
}

// The Runner's endpoints: with none attached, no_runner, and a list saying so; with one, its
// sessions, an admin's nudge
// and stop, and the terminal — read-write for an admin, read-only for anyone else or on asking,
// refused from another origin, before the upgrade when there is no session or no tmux.
func TestRunnerSessions(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.AddTeamMemberWithResponse(ctx, "WEB", "ada", &client.AddTeamMemberParams{})).want(t, http.StatusNoContent)
		bob, bobID := h.member("bob", client.Agent, "WEB")
		f := got(ada.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Checkout"})).
			want(t, http.StatusCreated).JSON201
		held, other := f.Tasks[0], got(ada.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key,
			Title: "Other", AimedAt: ptrStr("bob")})).want(t, http.StatusCreated).JSON201.Task

		// No Runner attached.
		got(ada.NudgeRunnerSessionWithResponse(ctx, held.Key, &client.NudgeRunnerSessionParams{})).want(t, http.StatusConflict)
		got(ada.StopRunnerSessionWithResponse(ctx, held.Key, &client.StopRunnerSessionParams{})).want(t, http.StatusConflict)
		got(ada.RunnerTerminalWithResponse(ctx, held.Key, &client.RunnerTerminalParams{})).want(t, http.StatusConflict)
		res := got(ada.NudgeRunnerSessionWithResponse(ctx, held.Key, &client.NudgeRunnerSessionParams{})).want(t, http.StatusConflict)
		if res.JSONDefault == nil || res.JSONDefault.Code != client.ErrorCodeNoRunner {
			t.Fatalf("without a Runner: %s", res.Body)
		}
		// The list answers, saying there is none, so a page can poll it.
		none := got(bob.ListRunnerSessionsWithResponse(ctx)).want(t, http.StatusOK)
		if none.JSON200.Runner || none.JSON200.Items == nil || len(none.JSON200.Items) != 0 || !strings.Contains(string(none.Body), `"items":[]`) {
			t.Fatalf("without a Runner: %s", none.Body)
		}

		fake := &fakeRunner{sessions: []runnerapi.Session{
			{TaskID: held.ID, MemberID: bobID, SessionID: "run-1", Host: "box", Tmux: "dk-" + held.Key, StartedAt: time.UnixMilli(1000).UTC(),
				State: runnerapi.StateRunning, LogPath: "/data/sessions/pane.log"},
			{TaskID: other.ID, MemberID: bobID, SessionID: "run-2", Host: "box", StartedAt: time.UnixMilli(2000).UTC(),
				State: runnerapi.StateNudged, LogPath: "/data/sessions/other.log"},
		}}
		h.srv.AttachRunner(fake)
		listed := got(bob.ListRunnerSessionsWithResponse(ctx)).want(t, http.StatusOK).JSON200
		list := listed.Items
		if !listed.Runner || len(list) != 2 || list[0].TaskID != held.ID || list[0].Tmux == nil || *list[0].Tmux != "dk-"+held.Key ||
			list[0].State != client.RunnerSessionRunning || list[1].Tmux != nil || list[1].State != client.RunnerSessionNudged {
			t.Fatalf("sessions %+v", list)
		}
		got(bob.NudgeRunnerSessionWithResponse(ctx, held.Key, &client.NudgeRunnerSessionParams{})).want(t, http.StatusForbidden)
		got(ada.NudgeRunnerSessionWithResponse(ctx, held.Key, &client.NudgeRunnerSessionParams{})).want(t, http.StatusNoContent)
		got(ada.StopRunnerSessionWithResponse(ctx, held.ID, &client.StopRunnerSessionParams{})).want(t, http.StatusNoContent)
		got(ada.StopRunnerSessionWithResponse(ctx, f.Feature.Key, &client.StopRunnerSessionParams{})).want(t, http.StatusNotFound)
		if !slices.Equal(fake.nudged, []string{held.ID}) || !slices.Equal(fake.stopped, []string{held.ID}) {
			t.Fatalf("nudged %v, stopped %v", fake.nudged, fake.stopped)
		}
		noTmux := got(ada.RunnerTerminalWithResponse(ctx, other.Key, &client.RunnerTerminalParams{})).want(t, http.StatusConflict)
		if noTmux.JSONDefault == nil || noTmux.JSONDefault.Code != client.ErrorCodeConflict {
			t.Fatalf("a session without tmux: %s", noTmux.Body)
		}

		url := "ws" + strings.TrimPrefix(h.ts.URL, "http") + "/v1/runner/sessions/" + held.Key + "/terminal"
		dial := func(secret, session, query, origin string) (*websocket.Conn, *http.Response, error) {
			hdr := http.Header{"Authorization": {"Bearer " + secret}, "Darkory-Session": {session}}
			if origin != "" {
				hdr.Set("Origin", origin)
			}
			return websocket.Dial(ctx, url+query, &websocket.DialOptions{HTTPHeader: hdr})
		}
		hello := func(conn *websocket.Conn) map[string]any {
			t.Helper()
			_, b, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			return m
		}
		conn, _, err := dial(h.adminSecret, "ada-term", "", h.ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		if m := hello(conn); m["task"] != held.ID || m["readonly"] != false || m["viewer"] != "ada" {
			t.Fatalf("the admin joined as %v", m)
		}
		if err := conn.Write(ctx, websocket.MessageBinary, []byte("ls\r")); err != nil {
			t.Fatal(err)
		}
		if _, b, err := conn.Read(ctx); err != nil || string(b) != "ls\r" {
			t.Fatalf("echo %q %v", b, err)
		}
		conn.Close(websocket.StatusNormalClosure, "")

		conn, _, err = dial(h.adminSecret, "ada-term", "?readonly=1", "")
		if err != nil {
			t.Fatal(err)
		}
		if m := hello(conn); m["readonly"] != true {
			t.Fatalf("readonly asked for: %v", m)
		}
		conn.Close(websocket.StatusNormalClosure, "")
		conn, _, err = dial(h.secrets["bob"], "bob-term", "", "")
		if err != nil {
			t.Fatal(err)
		}
		if m := hello(conn); m["readonly"] != true || m["viewer"] != "bob" {
			t.Fatalf("a Member who is not an admin: %v", m)
		}
		conn.Close(websocket.StatusNormalClosure, "")

		_, resp, err := dial(h.adminSecret, "ada-term", "", "http://evil.example")
		if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("another origin: %v %v", resp, err)
		}
		if _, resp, err := dial("dk_nothing", "x", "", ""); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("no credential: %v %v", resp, err)
		}
	})
}
