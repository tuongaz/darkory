package cli

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/core"
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
	in.seed("bob", core.NewTask{Project: ptr("WEB"), Title: "Search\u202eevil\u2066", Breakdown: true})
	filed := in.seed("bob", core.NewTask{Parent: ptr("WEB-1"), Step: ptr("Build"), Title: hostileTitle,
		Description: "line one\n\x1b[31mred\u009b2J\x7f"})
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
		shown.Task.Description != "line one\n\x1b[31mred\u009b2J\x7f" || shown.Feature.Title != "Search\u202eevil\u2066" {
		t.Fatalf("--json round trip: %q %q %q, %v", shown.Task.Title, shown.Task.Description, shown.Feature.Title, err)
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

// Fields Phase 1 cannot yet write — Notes, Observations, Evidence, Member names, model labels —
// are escaped as well, here as a fake Install serves them.
func TestOutputEscapesEveryField(t *testing.T) {
	h := hostileTitle + "\u009b\u202e"
	js := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	task := `{"id":"t3","key":` + js("WEB-3"+h) + `,"feature_id":"f1","kind":` + js("work"+h) + `,"title":` + js(h) +
		`,"description":` + js(h) + `,"state":"open","blocked":false,"filed_by":"m1","waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z",` +
		`"skill_id":"s1","claim":{"id":"c1","task_id":"t3","holder_id":"m1","session_id":` + js(h) + `,"model_label":` + js(h) + `,"started_at":"2026-10-06T00:00:00Z"}}`
	feature := `{"id":"f1","key":"WEB-1","team_id":"tm1","title":` + js(h) + `,"description":` + js(h) + `,"owner_id":"m1","state":"open","rank":1,"filed_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
	detail := `{"task":` + task + `,"feature":` + feature + `,"claims":[],"blockers":[` + task + `],"blocking":[],` +
		`"notes":[{"id":"n1","task_id":"t3","author_id":"m1","body":` + js(h) + `,"created_at":"2026-10-06T00:00:00Z"}],` +
		`"observations":[{"id":"o1","task_id":"t3","feature_id":"f1","author_id":"m1","outcome":"worked","body":` + js(h) + `,"created_at":"2026-10-06T00:00:00Z"}],` +
		`"evidence":[{"id":"e1","feature_id":"f1","filename":` + js(h) + `,"content_type":` + js(h) + `,"size":1,"sha256":"x","attached_by":"m1","created_at":"2026-10-06T00:00:00Z"}]}`
	rc := &recorder{answers: map[string]answer{
		"GET /v1/tasks/WEB-3":        {200, detail},
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
