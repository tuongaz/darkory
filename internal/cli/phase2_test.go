package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// recorder is a fake Install that records every request and answers from a route table.
type recorder struct {
	mu   sync.Mutex
	reqs []recorded
	// answers maps "METHOD /path" to a status and body; anything else is 404 not_found.
	answers map[string]answer
}

type recorded struct {
	method, path, query string
	header              http.Header
	body                []byte
}

type answer struct {
	status int
	body   string
}

func (rc *recorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	rc.mu.Lock()
	rc.reqs = append(rc.reqs, recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone(), body})
	a, ok := rc.answers[r.Method+" "+r.URL.Path]
	rc.mu.Unlock()
	if !ok {
		a = answer{http.StatusNotFound, `{"code":"not_found","message":"nothing at ` + r.URL.Path + `"}`}
	}
	if a.status == http.StatusNoContent {
		w.WriteHeader(a.status)
		return
	}
	if strings.HasPrefix(a.body, "{") {
		w.Header().Set("Content-Type", "application/json")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.WriteHeader(a.status)
	io.WriteString(w, a.body)
}

func (rc *recorder) take() []recorded {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	out := rc.reqs
	rc.reqs = nil
	return out
}

const (
	taskJSON     = `{"id":"t3","key":"WEB-3","feature_id":"f1","kind":"work","title":"Build","description":"","state":"open","blocked":false,"filed_by":"m1","waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z"}`
	featureJSON  = `{"id":"f1","key":"WEB-1","team_id":"tm1","title":"Search","description":"","owner_id":"m1","state":"open","rank":2,"filed_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
	evidenceJSON = `{"id":"ev1","feature_id":"f1","filename":"shot.png","content_type":"image/png","size":4,"sha256":"x","attached_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
)

// The commands for operations Phase 2 builds form their requests as the contract says: method,
// path, query and JSON body, with the token, the Session and a fresh Idempotency-Key on writes.
func TestPhase2CommandsFormTheirRequests(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "shot.png")
	report := filepath.Join(dir, "report")
	proposal := filepath.Join(dir, "proposal.md")
	for path, content := range map[string]string{png: "\x89PNG\r\n\x1a\n", report: "all green\n", proposal: "Test the edges.\n"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	feature := `{"feature":` + featureJSON + `,"tasks":[],"evidence":[]}`
	detail := `{"task":` + taskJSON + `,"feature":` + featureJSON + `,"claims":[],"notes":[],"evidence":[],"blockers":[],"blocking":[],"observations":[]}`
	rc := &recorder{answers: map[string]answer{
		"POST /v1/tasks/WEB-3/handover":         {200, taskJSON},
		"POST /v1/tasks/WEB-3/drop":             {200, taskJSON},
		"POST /v1/tasks/WEB-3/take-back":        {200, taskJSON},
		"POST /v1/tasks/WEB-3/notes":            {201, `{"id":"n1","task_id":"t3","author_id":"m1","body":"x","created_at":"2026-10-06T00:00:00Z"}`},
		"POST /v1/tasks/WEB-3/observations":     {201, `{"id":"o1","task_id":"t3","feature_id":"f1","author_id":"m1","outcome":"didnt_work","body":"x","created_at":"2026-10-06T00:00:00Z"}`},
		"GET /v1/tasks/WEB-3":                   {200, detail},
		"POST /v1/tasks/WEB-3/evidence":         {201, evidenceJSON},
		"POST /v1/features/WEB-1/evidence":      {201, evidenceJSON},
		"GET /v1/evidence/ev1":                  {200, evidenceJSON},
		"GET /v1/evidence/ev1/content":          {200, "\x89PNG"},
		"PUT /v1/tasks/WEB-3/blockers/WEB-4":    {204, ""},
		"DELETE /v1/tasks/WEB-3/blockers/WEB-4": {204, ""},
		"POST /v1/features/WEB-1/rank":          {200, featureJSON},
		"POST /v1/features/WEB-1/ship":          {200, feature},
		"POST /v1/features/WEB-1/drop":          {200, feature},
		"POST /v1/features/WEB-1/owner":         {200, featureJSON},
		"GET /v1/features/WEB-1/observations":   {200, `{"items":[]}`},
		"POST /v1/tasks/WEB-9/skill-proposals":  {201, `{"id":"p1","skill_id":"s1","task_id":"t9","based_on_version":3,"body":"x","author_id":"m1","state":"pending","created_at":"2026-10-06T00:00:00Z"}`},
		"POST /v1/tasks":                        {201, detail},
	}}
	ts := httptest.NewServer(rc)
	defer ts.Close()

	for _, tc := range []struct {
		name  string
		args  []string
		stdin string
		// want is the request the command exists to send, the last one it sends.
		method, path, query string
		body                string // JSON; "" for none
		contentType         string
		raw                 string // a raw body, for Evidence
		// before are the requests sent first.
		before []string
	}{
		{name: "handover", args: []string{"handover", "WEB-3", "--skill", "review", "--note", "over to you"},
			method: "POST", path: "/v1/tasks/WEB-3/handover", body: `{"skill":"review","note":"over to you"}`},
		{name: "drop", args: []string{"drop", "WEB-3", "--reason", "duplicate"},
			method: "POST", path: "/v1/tasks/WEB-3/drop", body: `{"reason":"duplicate"}`},
		{name: "take-back", args: []string{"take-back", "WEB-3", "--reason", "stuck"},
			method: "POST", path: "/v1/tasks/WEB-3/take-back", body: `{"reason":"stuck"}`},
		{name: "note", args: []string{"note", "WEB-3", "the", "index", "is", "built"},
			method: "POST", path: "/v1/tasks/WEB-3/notes", body: `{"body":"the index is built"}`},
		{name: "note from stdin", args: []string{"note", "WEB-3", "-"}, stdin: "line one\nline two\n",
			method: "POST", path: "/v1/tasks/WEB-3/notes", body: `{"body":"line one\nline two"}`},
		{name: "observe", args: []string{"observe", "WEB-3", "--didnt-work", "the fixture was flaky"},
			method: "POST", path: "/v1/tasks/WEB-3/observations", body: `{"outcome":"didnt_work","body":"the fixture was flaky"}`},
		{name: "observe worked", args: []string{"observe", "WEB-3", "--worked", "-"}, stdin: "small commits\n",
			method: "POST", path: "/v1/tasks/WEB-3/observations", body: `{"outcome":"worked","body":"small commits"}`},
		{name: "attach to a Task", args: []string{"attach", "WEB-3", png},
			before: []string{"GET /v1/tasks/WEB-3"},
			method: "POST", path: "/v1/tasks/WEB-3/evidence", query: "filename=shot.png", contentType: "image/png", raw: "\x89PNG\r\n\x1a\n"},
		{name: "attach to a Feature", args: []string{"attach", "WEB-1", report, "--name", "report.txt"},
			before: []string{"GET /v1/tasks/WEB-1"},
			method: "POST", path: "/v1/features/WEB-1/evidence", query: "filename=report.txt", contentType: "text/plain; charset=utf-8", raw: "all green\n"},
		{name: "attach sniffing the content", args: []string{"attach", "--feature", "WEB-1", report, "--name", "report"},
			method: "POST", path: "/v1/features/WEB-1/evidence", query: "filename=report", contentType: "text/plain; charset=utf-8", raw: "all green\n"},
		{name: "evidence get", args: []string{"evidence", "get", "ev1"}, method: "GET", path: "/v1/evidence/ev1"},
		{name: "evidence download", args: []string{"evidence", "get", "ev1", "-o", filepath.Join(dir, "out.png")},
			method: "GET", path: "/v1/evidence/ev1/content"},
		{name: "block", args: []string{"block", "WEB-3", "--by", "WEB-4"}, method: "PUT", path: "/v1/tasks/WEB-3/blockers/WEB-4"},
		{name: "unblock", args: []string{"unblock", "WEB-3", "--by", "WEB-4"}, method: "DELETE", path: "/v1/tasks/WEB-3/blockers/WEB-4"},
		{name: "feature rank", args: []string{"feature", "rank", "WEB-1", "2"},
			method: "POST", path: "/v1/features/WEB-1/rank", body: `{"position":2}`},
		{name: "feature ship", args: []string{"feature", "ship", "WEB-1"}, method: "POST", path: "/v1/features/WEB-1/ship"},
		{name: "feature drop", args: []string{"feature", "drop", "WEB-1"}, method: "POST", path: "/v1/features/WEB-1/drop"},
		{name: "feature owner", args: []string{"feature", "owner", "WEB-1", "carol"},
			method: "POST", path: "/v1/features/WEB-1/owner", body: `{"owner":"carol"}`},
		{name: "feature observations", args: []string{"feature", "observations", "WEB-1", "--unreviewed"},
			method: "GET", path: "/v1/features/WEB-1/observations", query: "reviewed=false"},
		{name: "propose", args: []string{"propose", "WEB-9", "--skill", "qa-acme", "--base", "3", "--file", proposal},
			method: "POST", path: "/v1/tasks/WEB-9/skill-proposals", body: `{"skill":"qa-acme","based_on_version":3,"body":"Test the edges.\n"}`},
		{name: "file a question", args: []string{"file", "--blocks", "WEB-3", "--aim", "ada", "--title", "Which index?"},
			method: "POST", path: "/v1/tasks", body: `{"blocks":"WEB-3","aimed_at":"ada","title":"Which index?"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &runner{t: t, stdin: tc.stdin, env: map[string]string{
				"DARKORY_URL": ts.URL, "DARKORY_TOKEN": "dk_test", "DARKORY_SESSION": "s-test"}}
			for _, mode := range [][]string{{"--json"}, nil} {
				r.ok(append(tc.args, mode...)...)
				reqs := rc.take()
				var lines []string
				for _, q := range reqs {
					lines = append(lines, q.method+" "+q.path)
				}
				// Text output may read names afterwards; the requests that matter come first.
				n := len(tc.before) + 1
				if len(reqs) < n || !slices.Equal(lines[:len(tc.before)], tc.before) {
					t.Fatalf("sent %v, want %v then %s %s", lines, tc.before, tc.method, tc.path)
				}
				q := reqs[len(tc.before)]
				if q.method != tc.method || q.path != tc.path || q.query != tc.query {
					t.Fatalf("sent %s %s?%s, want %s %s?%s", q.method, q.path, q.query, tc.method, tc.path, tc.query)
				}
				if q.header.Get("Authorization") != "Bearer dk_test" || q.header.Get("Darkory-Session") != "s-test" {
					t.Errorf("credentials: %v", q.header)
				}
				if write := q.method != "GET"; write != (q.header.Get("Idempotency-Key") != "") {
					t.Errorf("%s with Idempotency-Key %q", q.method, q.header.Get("Idempotency-Key"))
				}
				switch {
				case tc.body != "":
					if ct := q.header.Get("Content-Type"); ct != "application/json" {
						t.Errorf("Content-Type %q", ct)
					}
					var got, want any
					if err := json.Unmarshal(q.body, &got); err != nil {
						t.Fatalf("body %q: %v", q.body, err)
					}
					json.Unmarshal([]byte(tc.body), &want)
					if !reflect.DeepEqual(got, want) {
						t.Errorf("body %s, want %s", q.body, tc.body)
					}
				case tc.raw != "":
					if ct := q.header.Get("Content-Type"); ct != tc.contentType || string(q.body) != tc.raw {
						t.Errorf("Evidence sent as %q: %q", ct, q.body)
					}
				default:
					if len(q.body) != 0 && string(q.body) != "{}" {
						t.Errorf("unexpected body %q", q.body)
					}
				}
			}
		})
	}
	if got, err := os.ReadFile(filepath.Join(dir, "out.png")); err != nil || string(got) != "\x89PNG" {
		t.Fatalf("evidence get -o saved %q, %v", got, err)
	}
}

// skipIfNotBuilt skips the rest of a test when the server answered an operation 501, as Phase 2
// operations do until they are built.
func skipIfNotBuilt(t *testing.T, res result) {
	t.Helper()
	if strings.Contains(res.stderr, "not_implemented") {
		t.Skipf("the server has not built this yet: %s", strings.TrimSpace(res.stderr))
	}
}

// try runs a command that must succeed, skipping the test when the server has not built it.
func try(t *testing.T, r *runner, args ...string) string {
	t.Helper()
	res := r.run(args...)
	skipIfNotBuilt(t, res)
	if res.code != 0 {
		t.Fatalf("darkory %s: exit %d\n%s%s", strings.Join(args, " "), res.code, res.stdout, res.stderr)
	}
	return res.stdout
}

func tryJSON(t *testing.T, r *runner, v any, args ...string) {
	t.Helper()
	out := try(t, r, append(args, "--json")...)
	if err := json.Unmarshal([]byte(out), v); err != nil {
		t.Fatalf("darkory %s --json printed %q: %v", strings.Join(args, " "), out, err)
	}
}

// The Phase 2 flow against the real server: Handover with Notes, Observations and Evidence, a
// question that blocks, block and unblock, take-back, rank, ownership, and shipping. Each step
// skips the test while the server answers it 501, so this runs in full once Phase 2 merges.
func TestPhase2Flow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		ada.ok("skill", "create", "review", "--kind", "generic", "--body", "Review it.")
		ada.ok("team", "add", "WEB", "ada")
		in.agent("rita", "WEB", "review")
		ada.ok("report-to", "bob", "ada")
		bob, rita := in.as("bob", "bob-1"), in.as("rita", "rita-1")
		bob.ok("feature", "create", "--team", "WEB", "--title", "Search")
		bob.ok("feature", "create", "--team", "WEB", "--title", "Later")
		bob.ok("file", "--feature", "WEB-1", "--skill", "build", "--title", "Build search")
		task := "WEB-5"
		bob.ok("claim", task, "--timeout", "60")

		try(t, bob, "note", task, "indexing", "done")
		try(t, bob, "observe", task, "--worked", "small commits")
		report := filepath.Join(t.TempDir(), "report.txt")
		os.WriteFile(report, []byte("all green\n"), 0o600)
		var ev client.Evidence
		tryJSON(t, bob, &ev, "attach", task, report)
		if ev.Filename != "report.txt" || ev.Size != 10 || deref(ev.TaskID) == "" {
			t.Fatalf("attach: %+v", ev)
		}
		out := filepath.Join(t.TempDir(), "back.txt")
		try(t, bob, "evidence", "get", ev.ID, "-o", out)
		if b, _ := os.ReadFile(out); string(b) != "all green\n" {
			t.Fatalf("downloaded %q", b)
		}

		// A question aimed at ada blocks the Task until it ends.
		var q client.TaskDetail
		tryJSON(t, bob, &q, "file", "--blocks", task, "--aim", "ada", "--title", "Which index?")
		var blocked client.TaskDetail
		bob.json(&blocked, "show", task)
		if !blocked.Task.Blocked || len(blocked.Blockers) != 1 {
			t.Fatalf("after the question: %+v", blocked.Task)
		}
		try(t, bob, "unblock", task, "--by", q.Task.Key)
		try(t, bob, "block", task, "--by", q.Task.Key)
		ada.ok("claim", q.Task.Key, "--timeout", "0")
		ada.ok("complete", q.Task.Key, "--note", "Use the trigram index.")

		var handed client.Task
		tryJSON(t, bob, &handed, "handover", task, "--skill", "review", "--note", "ready for review")
		if handed.Claim != nil {
			t.Fatalf("handover left a Claim: %+v", handed.Claim)
		}
		// No self-review: bob held it under build, so the review is rita's.
		bob.fails(ExitRefused, "claim", task, "--timeout", "60")
		rita.ok("claim", task, "--timeout", "60")
		var taken client.Task
		tryJSON(t, bob, &taken, "take-back", task, "--reason", "reassigning")
		rita.fails(ExitRefused, "heartbeat", task)
		rita.ok("claim", task, "--timeout", "60")
		rita.ok("complete", task)

		var ranked client.Feature
		tryJSON(t, bob, &ranked, "feature", "rank", "WEB-3", "1")
		if ranked.Rank != 1 {
			t.Fatalf("rank: %+v", ranked)
		}
		var passed client.Feature
		tryJSON(t, bob, &passed, "feature", "owner", "WEB-1", "ada")
		var obs client.ObservationList
		tryJSON(t, ada, &obs, "feature", "observations", "WEB-1", "--unreviewed")
		if len(obs.Items) != 1 || obs.Items[0].Body != "small commits" {
			t.Fatalf("observations: %+v", obs)
		}
		ada.ok("claim", "WEB-2", "--timeout", "0")
		ada.ok("complete", "WEB-2")
		var shipped client.FeatureDetail
		tryJSON(t, ada, &shipped, "feature", "ship", "WEB-1")
		if shipped.Feature.State != client.FeatureStateShipped {
			t.Fatalf("ship: %+v", shipped.Feature)
		}
		var dropped client.FeatureDetail
		tryJSON(t, bob, &dropped, "feature", "drop", "WEB-3")
		if dropped.Feature.State != client.FeatureStateDropped {
			t.Fatalf("drop: %+v", dropped.Feature)
		}
	})
}
