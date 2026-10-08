package cli

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// hostileTitle sets the clipboard (OSC 52, ended by BEL) and clears the screen when a terminal
// prints it raw.
const hostileTitle = "ok\x1b]52;c;ZXZpbA==\x07\x1b[2J"

// actable returns the first thing in s a terminal could act on, or "": a control other than
// newline or tab, DEL, a C1 control (U+009B is the 8-bit CSI), a bidi override or isolate.
func actable(s string) string {
	for i, r := range s {
		if (r < 0x20 && r != '\n' && r != '\t') || (r >= 0x7f && r <= 0x9f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return s[i:min(i+6, len(s))]
		}
	}
	return ""
}

// Text other Members wrote reaches the terminal with its controls escaped; --json carries it
// exactly.
func TestOutputEscapesTerminalControls(t *testing.T) {
	in := newInstall(t, storetest.Open(t, store.SQLite))
	in.setup()
	ada, bob := in.as("ada", "ada-1"), in.as("bob", "bob-1")
	bob.ok("file", "--project", "WEB", "--title", "Search\u202eevil\u2066", "--breakdown")
	var filed client.TaskDetail
	bob.json(&filed, "file", "--parent", "WEB-1", "--step", "Build", "--title", hostileTitle, "--body", "line one\n\x1b[31mred\u009b2J\x7f")
	key := filed.Task.Key
	if filed.Task.Title != hostileTitle {
		t.Fatalf("--json carried the title as %q", filed.Task.Title)
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	followed := &lockedBuffer{}
	done := make(chan result, 1)
	go func() { done <- ada.runTo(ctx, followed, &lockedBuffer{}, "activity", "--follow", "--all") }()
	eventually(t, 10*time.Second, "the stream to reach the Task", func() bool { return strings.Contains(followed.String(), "task.filed") })
	cancel()
	<-done

	bob.ok("claim", key, "--timeout", "60")
	for name, out := range map[string]string{
		"show":              bob.ok("show", key),
		"tasks":             bob.ok("tasks"),
		"parent show":       bob.ok("show", "WEB-1"),
		"activity":          bob.ok("activity"),
		"activity --follow": followed.String(),
		"heartbeat":         bob.ok("heartbeat", key),
		"error":             ada.fails(ExitRefused, "claim", key).stderr,
		"not found":         bob.fails(ExitFailed, "show", "WEB-\x1b[2J9").stderr,
	} {
		if a := actable(out); a != "" {
			t.Errorf("%s printed %q raw:\n%s", name, a, out)
		}
	}
	if out := bob.ok("show", key); !strings.Contains(out, `ok\x1b]52;c;ZXZpbA==\x07\x1b[2J`) || !strings.Contains(out, `\x1b[31mred\u009b2J\x7f`) {
		t.Errorf("show does not show the escapes:\n%s", out)
	}

	// --json prints no raw control, and decodes to exactly what was filed.
	raw := bob.ok("show", key, "--json")
	if a := actable(raw); a != "" {
		t.Errorf("--json printed %q raw", a)
	}
	var shown client.TaskDetail
	if err := json.Unmarshal([]byte(raw), &shown); err != nil || shown.Task.Title != hostileTitle ||
		shown.Task.Description != "line one\n\x1b[31mred\u009b2J\x7f" || shown.Parent == nil || shown.Parent.Title != "Search\u202eevil\u2066" {
		t.Fatalf("--json round trip: %q %q %+v, %v", shown.Task.Title, shown.Task.Description, shown.Parent, err)
	}
	// The JSON stream round-trips too.
	ctx, cancel = context.WithCancel(t.Context())
	defer cancel()
	stream := &lockedBuffer{}
	go func() { done <- ada.runTo(ctx, stream, &lockedBuffer{}, "activity", "--follow", "--json", "--all") }()
	eventually(t, 10*time.Second, "the JSON stream", func() bool { return strings.Contains(stream.String(), "task.claimed") })
	cancel()
	<-done
	if a := actable(stream.String()); a != "" {
		t.Errorf("activity --follow --json printed %q raw", a)
	}
	found := false
	for line := range strings.Lines(stream.String()) {
		var a client.Activity
		if err := json.Unmarshal([]byte(line), &a); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		found = found || a.Payload["title"] == hostileTitle
	}
	if !found {
		t.Error("the stream lost the title")
	}
}

// Every field another Member wrote — Notes, Observations, Evidence, proposals, Member, Project,
// Step, outcome and Label names, model labels — is escaped as well, here as a fake Install serves
// them.
func TestOutputEscapesEveryField(t *testing.T) {
	h := hostileTitle + "\u009b\u202e"
	js := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	task := `{"id":"t3","key":` + js("WEB-3"+h) + `,"project_id":"p1","parent_id":"f1","kind":` + js("work"+h) + `,"title":` + js(h) +
		`,"description":` + js(h) + `,"state":"open","owner_id":"m1","step_id":"st1","labels":["l1"],"blocked":false,"breakdown":false,` +
		`"auto_complete":false,"acceptance":false,"filed_by":"m1","waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z",` +
		`"skill_id":"s1","claim":{"id":"c1","task_id":"t3","holder_id":"m1","session_id":` + js(h) + `,"model_label":` + js(h) + `,"started_at":"2026-10-06T00:00:00Z"}}`
	parent := `{"id":"f1","key":` + js("WEB-1"+h) + `,"project_id":"p1","kind":"work","title":` + js(h) + `,"description":` + js(h) +
		`,"state":"open","owner_id":"m1","rank":1,"blocked":false,"breakdown":false,"auto_complete":false,"acceptance":false,"filed_by":"m1",` +
		`"subtask_counts":{"open":1,"working":1,"done":0,"dropped":0},"waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z"}`
	detail := `{"task":` + task + `,"parent":{"id":"f1","key":` + js("WEB-1"+h) + `,"title":` + js(h) + `},"subtasks":[],` +
		`"step":{"id":"st1","name":` + js(h) + `,"skill_id":"s1","position":1,"x":0,"y":0},` +
		`"connectors":[{"id":"k1","from_step_id":"st1","name":` + js(h) + `,"position":1}],` +
		`"labels":[{"id":"l1","project_id":"p1","name":` + js(h) + `,"color":"#ff0000","created_at":"2026-10-06T00:00:00Z"}],` +
		`"workspaces":[],"claims":[],"blockers":[` + task + `],"blocking":[],` +
		`"notes":[{"id":"n1","task_id":"t3","author_id":"m1","body":` + js(h) + `,"created_at":"2026-10-06T00:00:00Z"}],` +
		`"observations":[{"id":"o1","task_id":"t3","author_id":"m1","outcome":"worked","body":` + js(h) + `,"created_at":"2026-10-06T00:00:00Z"}],` +
		`"evidence":[{"id":"e1","task_id":"t3","filename":` + js(h) + `,"content_type":` + js(h) + `,"size":1,"sha256":"x","attached_by":"m1","created_at":"2026-10-06T00:00:00Z"}],` +
		`"proposals":[{"id":"p1","skill_id":"s1","task_id":"t3","based_on_version":1,"body":` + js(h) + `,"author_id":"m1","state":"pending","created_at":"2026-10-06T00:00:00Z"}]}`
	parentDetail := `{"task":` + parent + `,"subtasks":[` + task + `],"connectors":[],"labels":[],"workspaces":[],"claims":[],"blockers":[],` +
		`"blocking":[],"notes":[],"observations":[],"evidence":[],"proposals":[]}`
	rc := &recorder{answers: map[string]answer{
		"GET /v1/tasks/WEB-3": {200, detail},
		"GET /v1/tasks/WEB-1": {200, parentDetail},
		"GET /v1/tasks/f1":    {200, parentDetail},
		"GET /v1/projects":    {200, `{"items":[{"id":"p1","key":` + js("WEB"+h) + `,"name":` + js(h) + `,"auto_complete":false,"acceptance":false,"created_at":"2026-10-06T00:00:00Z"}]}`},
		"GET /v1/projects/p1/workflow": {200, `{"project_id":"p1","steps":[{"id":"st1","name":` + js(h) + `,"skill_id":"s1","position":1,"x":0,"y":0,` +
			`"tasks":1,"working":1,"takers":[{"id":"m1","name":` + js(h) + `,"kind":"agent"}],"median_ms":1000}],"connectors":[{"id":"k1","from_step_id":"st1","name":` + js(h) + `,"position":1}]}`},
		"GET /v1/projects/WEB/workflow": {200, `{"project_id":"p1","steps":[{"id":"st1","name":` + js(h) + `,"skill_id":"s1","position":1,"x":0,"y":0,` +
			`"tasks":1,"working":1,"takers":[{"id":"m1","name":` + js(h) + `,"kind":"agent"}],"median_ms":1000}],"connectors":[{"id":"k1","from_step_id":"st1","name":` + js(h) + `,"position":1}]}`},
		"GET /v1/labels":             {200, `{"items":[]}`},
		"GET /v1/projects/p1/labels": {200, `{"items":[{"id":"l1","project_id":"p1","name":` + js(h) + `,"color":"#ff0000","created_at":"2026-10-06T00:00:00Z"}]}`},
		"GET /v1/members":            {200, `{"items":[{"id":"m1","name":` + js(h) + `,"kind":"agent","admin":false,"created_at":"2026-10-06T00:00:00Z","email":` + js(h) + `}]}`},
		"GET /v1/skills":             {200, `{"items":[{"id":"s1","name":` + js(h) + `,"kind":"generic","builtin":false,"current_version":1,"created_at":"2026-10-06T00:00:00Z"}]}`},
		"GET /v1/activity":           {200, `{"items":[{"seq":1,"at":"2026-10-06T00:00:00Z","actor_id":"m1","kind":` + js(h) + `,"subject_id":` + js(h) + `,"payload":{"x":` + js(h) + `}}],"last_seq":1}`},
		"POST /v1/tasks/WEB-3/claim": {409, `{"code":"already_claimed","message":` + js("held: "+h) + `}`},
	}}
	ts := httptest.NewServer(rc)
	defer ts.Close()
	r := &runner{t: t, env: map[string]string{"DARKORY_URL": ts.URL, "DARKORY_TOKEN": "dk_test", "DARKORY_SESSION": "s"}}
	for name, out := range map[string]string{
		"show":        r.ok("show", "WEB-3"),
		"parent show": r.ok("show", "WEB-1"),
		"workflow":    r.ok("workflow", "show", "WEB"),
		"member list": r.ok("member", "list"),
		"activity":    r.ok("activity"),
		"error":       r.fails(ExitRefused, "claim", "WEB-3").stderr,
	} {
		if a := actable(out); a != "" {
			t.Errorf("%s printed %q raw:\n%s", name, a, out)
		}
		if !strings.Contains(out, `\x1b]52`) {
			t.Errorf("%s does not show the escape:\n%s", name, out)
		}
	}
	// A title cannot pass for a line of its own.
	rc.answers["GET /v1/tasks"] = answer{200, `{"items":[` + strings.Replace(task, js(h), js("real\nWEB-9     open          build          Injected"), 1) + `]}`}
	if out := r.ok("tasks"); strings.Count(out, "\n") != 1 {
		t.Errorf("one Task printed as several lines:\n%s", out)
	}
}
