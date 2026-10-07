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
	taskJSON     = `{"id":"t3","key":"WEB-3","feature_id":"f1","kind":"work","title":"Build","description":"","state":"open","status_id":"st3","blocked":false,"filed_by":"m1","waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z"}`
	statusesJSON = `{"id":"st1","name":"Backlog","kind":"backlog","position":1},{"id":"st2","name":"Todo","kind":"todo","position":2},` +
		`{"id":"st3","name":"In progress","kind":"in_progress","position":3},{"id":"st5","name":"Done","kind":"done","position":4},` +
		`{"id":"st6","name":"Dropped","kind":"dropped","position":5}`
	featureJSON  = `{"id":"f1","key":"WEB-1","team_id":"tm1","title":"Search","description":"","owner_id":"m1","state":"open","rank":2,"filed_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
	evidenceJSON = `{"id":"ev1","feature_id":"f1","filename":"shot.png","content_type":"image/png","size":4,"sha256":"x","attached_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
)

// The commands for operations Phase 2 builds form their requests as the contract says: method,
// path, query and JSON body, with the token, the Session and a fresh Idempotency-Key on writes.
// model v2: TestPhase2Flow, the Phase 2 commands end to end through Features, Handover and Ship,
// went with them; M2 rebuilds it on file --parent, advance, move and complete.

func TestPhase2CommandsFormTheirRequests(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "shot.png")
	report := filepath.Join(dir, "report")
	proposal := filepath.Join(dir, "proposal.md")
	// A list as `workflow --json` prints it, positions and all, with a move added.
	list := filepath.Join(dir, "statuses.json")
	for path, content := range map[string]string{png: "\x89PNG\r\n\x1a\n", report: "all green\n", proposal: "Test the edges.\n",
		list: `{"items":[` + statusesJSON + `],"moves":{"st9":"st2"}}`} {
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
		"POST /v1/tasks/WEB-3/status":           {200, taskJSON},
		"GET /v1/statuses":                      {200, `{"items":[` + statusesJSON + `]}`},
		"PUT /v1/statuses":                      {200, `{"items":[` + statusesJSON + `]}`},
		"GET /v1/tasks":                         {200, `{"items":[` + taskJSON + `]}`},
		"GET /v1/activity":                      {200, `{"items":[],"last_seq":0}`},
		"POST /v1/sign-in/email":                {202, ""},
		"GET /v1/skill-proposals/p1":            {200, `{"id":"p1","skill_id":"s1","task_id":"t9","based_on_version":3,"body":"x","author_id":"m1","state":"pending","created_at":"2026-10-06T00:00:00Z"}`},
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
		{name: "feature observations", args: []string{"feature", "observations", "WEB-1"},
			method: "GET", path: "/v1/features/WEB-1/observations"},
		{name: "feature observations, all", args: []string{"feature", "observations", "WEB-1", "--all"},
			method: "GET", path: "/v1/features/WEB-1/observations", query: "reviewed=true"},
		{name: "proposal show by id", args: []string{"proposal", "show", "p1"}, before: []string{"GET /v1/tasks/p1"},
			method: "GET", path: "/v1/skill-proposals/p1"},
		{name: "propose", args: []string{"propose", "WEB-9", "--skill", "qa-acme", "--base", "3", "--file", proposal},
			method: "POST", path: "/v1/tasks/WEB-9/skill-proposals", body: `{"skill":"qa-acme","based_on_version":3,"body":"Test the edges.\n"}`},
		{name: "file a question", args: []string{"file", "--blocks", "WEB-3", "--aim", "ada", "--title", "Which index?"},
			method: "POST", path: "/v1/tasks", body: `{"blocks":"WEB-3","aimed_at":"ada","title":"Which index?"}`},
		{name: "handover into a Status", args: []string{"handover", "WEB-3", "--skill", "review", "--status", "In review"},
			method: "POST", path: "/v1/tasks/WEB-3/handover", body: `{"skill":"review","status":"In review"}`},
		{name: "file into the Backlog", args: []string{"file", "--feature", "WEB-1", "--skill", "build", "--title", "Later", "--status", "Backlog"},
			method: "POST", path: "/v1/tasks", body: `{"feature":"WEB-1","skill":"build","title":"Later","status":"Backlog"}`},
		{name: "status", args: []string{"status", "WEB-3", "In review"},
			method: "POST", path: "/v1/tasks/WEB-3/status", body: `{"status":"In review"}`},
		{name: "workflow", args: []string{"workflow"}, method: "GET", path: "/v1/statuses"},
		{name: "workflow set", args: []string{"workflow", "set", "--file", list},
			method: "PUT", path: "/v1/statuses", body: `{"items":[{"id":"st1","name":"Backlog","kind":"backlog"},{"id":"st2","name":"Todo","kind":"todo"},` +
				`{"id":"st3","name":"In progress","kind":"in_progress"},{"id":"st5","name":"Done","kind":"done"},{"id":"st6","name":"Dropped","kind":"dropped"}],"moves":{"st9":"st2"}}`},
		{name: "tasks by Status", args: []string{"tasks", "--status", "Backlog"}, method: "GET", path: "/v1/tasks", query: "status=Backlog"},
		{name: "activity filtered", args: []string{"activity", "--member", "bob", "--kind", "task.claimed,task.lapsed", "--team", "WEB"},
			method: "GET", path: "/v1/activity", query: "before=9007199254740991&member=bob&kind=task.claimed&kind=task.lapsed&team=WEB"},
		{name: "login by email", args: []string{"login", "--email", "ada@example.com"},
			method: "POST", path: "/v1/sign-in/email", body: `{"email":"ada@example.com"}`},
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
