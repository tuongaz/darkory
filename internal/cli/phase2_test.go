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
	taskJSON = `{"id":"t3","key":"WEB-3","project_id":"p1","parent_id":"t1","kind":"work","title":"Build","description":"","state":"open",` +
		`"owner_id":"m1","step_id":"st3","blocked":false,"breakdown":false,"auto_complete":false,"acceptance":false,"filed_by":"m1",` +
		`"waiting_since":"2026-10-06T00:00:00Z","created_at":"2026-10-06T00:00:00Z"}`
	workflowJSON = `{"project_id":"p1","steps":[{"id":"st1","name":"Backlog","position":1,"x":0,"y":0,"tasks":0,"working":0,"takers":[]},` +
		`{"id":"st3","name":"Build","skill_id":"s1","position":2,"x":448,"y":0,"tasks":1,"working":0,"takers":[]}],` +
		`"connectors":[{"id":"k1","from_step_id":"st1","to_step_id":"st3","name":"ready","position":1},{"id":"k2","from_step_id":"st3","name":"pass","position":1}]}`
	evidenceJSON = `{"id":"ev1","task_id":"t3","filename":"shot.png","content_type":"image/png","size":4,"sha256":"x","attached_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
	fileJSON     = `{"id":"f1","name":"shot.png","content_type":"image/png","size":4,"sha256":"x","purpose":"avatar","created_by":"m1","created_at":"2026-10-06T00:00:00Z"}`
	memberJSON   = `{"id":"m2","name":"qa","kind":"agent","admin":false,"avatar_file_id":"f1","created_at":"2026-10-06T00:00:00Z"}`
	labelJSON    = `{"id":"l1","name":"bug","color":"#ff0000","created_at":"2026-10-06T00:00:00Z"}`
	projectJSON  = `{"id":"p1","key":"WEB","name":"Web","auto_complete":false,"acceptance":false,"created_at":"2026-10-06T00:00:00Z"}`
)

// The commands form their requests as the contract says: method, path, query and JSON body, with
// the token, the Session and a fresh Idempotency-Key on writes.
func TestCommandsFormTheirRequests(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "shot.png")
	report := filepath.Join(dir, "report")
	proposal := filepath.Join(dir, "proposal.md")
	// A Workflow as `workflow show --body` prints it, with a move added.
	wf := filepath.Join(dir, "workflow.json")
	for path, content := range map[string]string{png: "\x89PNG\r\n\x1a\n", report: "all green\n", proposal: "Test the edges.\n",
		wf: `{"workflows":[{"id":"w1","name":"Work","position":1}],"steps":[{"id":"st1","workflow":"Work","name":"Backlog","position":1},{"workflow":"Work","name":"Build","skill":"engineer","position":2,"x":448,"y":0}],` +
			`"connectors":[{"from":"Backlog","to":"Build","name":"ready","position":1},{"from":"Build","name":"pass","position":1}],"moves":{"st9":"Build"}}`} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	detail := `{"task":` + taskJSON + `,"parent":{"id":"t1","key":"WEB-1","title":"Search"},"subtasks":[],"connectors":[],"labels":[],` +
		`"workspaces":[],"claims":[],"notes":[],"evidence":[],"blockers":[],"blocking":[],"observations":[],"proposals":[]}`
	rc := &recorder{answers: map[string]answer{
		"POST /v1/tasks/WEB-3/advance":          {200, taskJSON},
		"POST /v1/tasks/WEB-3/step":             {200, taskJSON},
		"POST /v1/tasks/WEB-3/complete":         {200, taskJSON},
		"POST /v1/tasks/WEB-3/drop":             {200, taskJSON},
		"POST /v1/tasks/WEB-3/take-back":        {200, taskJSON},
		"POST /v1/tasks/WEB-1/rank":             {200, taskJSON},
		"POST /v1/tasks/WEB-1/owner":            {200, taskJSON},
		"PUT /v1/tasks/WEB-3/labels":            {200, taskJSON},
		"POST /v1/tasks/WEB-3/notes":            {201, `{"id":"n1","task_id":"t3","author_id":"m1","body":"x","created_at":"2026-10-06T00:00:00Z"}`},
		"POST /v1/tasks/WEB-3/observations":     {201, `{"id":"o1","task_id":"t3","author_id":"m1","outcome":"didnt_work","body":"x","created_at":"2026-10-06T00:00:00Z"}`},
		"GET /v1/tasks/WEB-1/observations":      {200, `{"items":[]}`},
		"GET /v1/tasks/WEB-3":                   {200, detail},
		"POST /v1/tasks/WEB-3/evidence":         {201, evidenceJSON},
		"GET /v1/evidence/ev1":                  {200, evidenceJSON},
		"GET /v1/evidence/ev1/content":          {200, "\x89PNG"},
		"PUT /v1/tasks/WEB-3/blockers/WEB-4":    {204, ""},
		"POST /v1/files":                        {201, fileJSON},
		"GET /v1/files/f1":                      {200, fileJSON},
		"GET /v1/files/f1/content":              {200, "\x89PNG"},
		"DELETE /v1/files/f1":                   {204, ""},
		"PATCH /v1/members/qa":                  {200, memberJSON},
		"DELETE /v1/tasks/WEB-3/blockers/WEB-4": {204, ""},
		"POST /v1/tasks/WEB-9/skill-proposals":  {201, `{"id":"p1","skill_id":"s1","task_id":"t9","based_on_version":3,"body":"x","author_id":"m1","state":"pending","created_at":"2026-10-06T00:00:00Z"}`},
		"POST /v1/tasks":                        {201, detail},
		"GET /v1/tasks":                         {200, `{"items":[` + taskJSON + `]}`},
		"GET /v1/activity":                      {200, `{"items":[],"last_seq":0}`},
		"POST /v1/sign-in/email":                {202, ""},
		"GET /v1/skill-proposals/p1":            {200, `{"id":"p1","skill_id":"s1","task_id":"t9","based_on_version":3,"body":"x","author_id":"m1","state":"pending","created_at":"2026-10-06T00:00:00Z"}`},
		"POST /v1/projects":                     {201, `{"project":` + projectJSON + `,"members":[]}`},
		"GET /v1/projects":                      {200, `{"items":[` + projectJSON + `]}`},
		"GET /v1/projects/WEB":                  {200, `{"project":` + projectJSON + `,"members":[]}`},
		"PATCH /v1/projects/WEB":                {200, projectJSON},
		"PUT /v1/projects/WEB/members/bob":      {204, ""},
		"DELETE /v1/projects/WEB/members/bob":   {204, ""},
		"GET /v1/projects/WEB/workflow":         {200, workflowJSON},
		"GET /v1/projects/p1/workflow":          {200, workflowJSON},
		"PUT /v1/projects/WEB/workflow":         {200, workflowJSON},
		"GET /v1/labels":                        {200, `{"items":[` + labelJSON + `]}`},
		"POST /v1/labels":                       {201, labelJSON},
		"GET /v1/projects/WEB/labels":           {200, `{"items":[]}`},
		"POST /v1/projects/WEB/labels":          {201, labelJSON},
		"PATCH /v1/labels/l1":                   {200, labelJSON},
		"DELETE /v1/labels/l1":                  {204, ""},
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
		{name: "advance", args: []string{"advance", "WEB-3", "needs changes", "--note", "over to you"},
			method: "POST", path: "/v1/tasks/WEB-3/advance", body: `{"outcome":"needs changes","note":"over to you"}`},
		{name: "advance along the one way", args: []string{"advance", "WEB-3"},
			method: "POST", path: "/v1/tasks/WEB-3/advance", body: `{}`},
		{name: "move", args: []string{"move", "WEB-3", "Build", "--note", "ready now"},
			method: "POST", path: "/v1/tasks/WEB-3/step", body: `{"step":"Build","note":"ready now"}`},
		{name: "complete", args: []string{"complete", "WEB-3", "--note", "done"},
			method: "POST", path: "/v1/tasks/WEB-3/complete", body: `{"note":"done"}`},
		{name: "drop", args: []string{"drop", "WEB-3", "--reason", "duplicate"},
			method: "POST", path: "/v1/tasks/WEB-3/drop", body: `{"reason":"duplicate"}`},
		{name: "take-back", args: []string{"take-back", "WEB-3", "--reason", "stuck"},
			method: "POST", path: "/v1/tasks/WEB-3/take-back", body: `{"reason":"stuck"}`},
		{name: "rank", args: []string{"rank", "WEB-1", "2"}, method: "POST", path: "/v1/tasks/WEB-1/rank", body: `{"position":2}`},
		{name: "owner", args: []string{"owner", "WEB-1", "carol"}, method: "POST", path: "/v1/tasks/WEB-1/owner", body: `{"owner":"carol"}`},
		{name: "note", args: []string{"note", "WEB-3", "the", "index", "is", "built"},
			method: "POST", path: "/v1/tasks/WEB-3/notes", body: `{"body":"the index is built"}`},
		{name: "note from stdin", args: []string{"note", "WEB-3", "-"}, stdin: "line one\nline two\n",
			method: "POST", path: "/v1/tasks/WEB-3/notes", body: `{"body":"line one\nline two"}`},
		{name: "observe", args: []string{"observe", "WEB-3", "--didnt-work", "the fixture was flaky"},
			method: "POST", path: "/v1/tasks/WEB-3/observations", body: `{"outcome":"didnt_work","body":"the fixture was flaky"}`},
		{name: "observe worked", args: []string{"observe", "WEB-3", "--worked", "-"}, stdin: "small commits\n",
			method: "POST", path: "/v1/tasks/WEB-3/observations", body: `{"outcome":"worked","body":"small commits"}`},
		{name: "observations", args: []string{"observations", "WEB-1"}, method: "GET", path: "/v1/tasks/WEB-1/observations"},
		{name: "observations, all", args: []string{"observations", "WEB-1", "--all"},
			method: "GET", path: "/v1/tasks/WEB-1/observations", query: "reviewed=true"},
		{name: "attach", args: []string{"attach", "WEB-3", png},
			method: "POST", path: "/v1/tasks/WEB-3/evidence", query: "filename=shot.png", contentType: "image/png", raw: "\x89PNG\r\n\x1a\n"},
		{name: "attach sniffing the content", args: []string{"attach", "WEB-3", report, "--name", "report"},
			method: "POST", path: "/v1/tasks/WEB-3/evidence", query: "filename=report", contentType: "text/plain; charset=utf-8", raw: "all green\n"},
		{name: "evidence get", args: []string{"evidence", "get", "ev1"}, method: "GET", path: "/v1/evidence/ev1"},
		{name: "evidence download", args: []string{"evidence", "get", "ev1", "-o", filepath.Join(dir, "out.png")},
			method: "GET", path: "/v1/evidence/ev1/content"},
		{name: "files upload", args: []string{"files", "upload", report},
			method: "POST", path: "/v1/files", query: "name=report", contentType: "text/plain; charset=utf-8", raw: "all green\n"},
		{name: "files upload an avatar", args: []string{"files", "upload", png, "--avatar", "--name", "qa.png"},
			method: "POST", path: "/v1/files", query: "name=qa.png&purpose=avatar", contentType: "image/png", raw: "\x89PNG\r\n\x1a\n"},
		{name: "files get", args: []string{"files", "get", "f1"}, method: "GET", path: "/v1/files/f1"},
		{name: "files download", args: []string{"files", "get", "f1", "-o", filepath.Join(dir, "f1.png")},
			method: "GET", path: "/v1/files/f1/content"},
		{name: "files delete", args: []string{"files", "delete", "f1"}, method: "DELETE", path: "/v1/files/f1"},
		{name: "member update --avatar", args: []string{"member", "update", "qa", "--avatar", "f1"},
			method: "PATCH", path: "/v1/members/qa", body: `{"avatar_file_id":"f1"}`},
		{name: "member update --no-avatar", args: []string{"member", "update", "qa", "--no-avatar"},
			method: "PATCH", path: "/v1/members/qa", body: `{"avatar_file_id":""}`},
		{name: "block", args: []string{"block", "WEB-3", "--by", "WEB-4"}, method: "PUT", path: "/v1/tasks/WEB-3/blockers/WEB-4"},
		{name: "unblock", args: []string{"unblock", "WEB-3", "--by", "WEB-4"}, method: "DELETE", path: "/v1/tasks/WEB-3/blockers/WEB-4"},
		{name: "proposal show by id", args: []string{"proposal", "show", "p1"}, before: []string{"GET /v1/tasks/p1"},
			method: "GET", path: "/v1/skill-proposals/p1"},
		{name: "propose", args: []string{"propose", "WEB-9", "--skill", "qa-acme", "--base", "3", "--file", proposal},
			method: "POST", path: "/v1/tasks/WEB-9/skill-proposals", body: `{"skill":"qa-acme","based_on_version":3,"body":"Test the edges.\n"}`},
		{name: "file a question", args: []string{"file", "--blocks", "WEB-3", "--aim", "ada", "--title", "Which index?"},
			method: "POST", path: "/v1/tasks", body: `{"blocks":"WEB-3","aim":"ada","title":"Which index?"}`},
		{name: "file with everything", args: []string{"file", "--project", "WEB", "--title", "Search", "--breakdown", "--step", "Backlog",
			"--label", "bug,client-x", "--label", "ui", "--owner", "carol", "--auto-complete", "--acceptance=false", "--workspace", "shop", "--body", "Find things."},
			method: "POST", path: "/v1/tasks", body: `{"project":"WEB","title":"Search","breakdown":true,"step":"Backlog","labels":["bug","client-x","ui"],` +
				`"owner":"carol","auto_complete":true,"acceptance":false,"workspaces":["shop"],"description":"Find things."}`},
		{name: "file a Subtask, splitting", args: []string{"file", "--parent", "WEB-3", "--title", "Half", "--note", "split in two"},
			method: "POST", path: "/v1/tasks", body: `{"parent":"WEB-3","title":"Half","note":"split in two"}`},
		{name: "tasks at a Step", args: []string{"tasks", "--project", "WEB", "--step", "Backlog", "--parent", "WEB-1"},
			method: "GET", path: "/v1/tasks", query: "project=WEB&parent=WEB-1&step=Backlog"},
		{name: "tasks filtered", args: []string{"tasks", "--filter", "label:in:l1", "--filter", "top:is:true"},
			method: "GET", path: "/v1/tasks", query: "filter=label%3Ain%3Al1&filter=top%3Ais%3Atrue"},
		{name: "project create", args: []string{"project", "create", "WEB", "Web", "--copy-from", "MAIN", "--member", "bob", "--member", "carol", "--auto-complete"},
			method: "POST", path: "/v1/projects", body: `{"key":"WEB","name":"Web","workflow":"copy","copy_from":"MAIN","members":["bob","carol"],"auto_complete":true}`},
		{name: "project create empty", args: []string{"project", "create", "TAX", "Tax", "--workflow", "empty"},
			method: "POST", path: "/v1/projects", body: `{"key":"TAX","name":"Tax","workflow":"empty"}`},
		{name: "project list", args: []string{"project", "list"}, method: "GET", path: "/v1/projects"},
		{name: "project show", args: []string{"project", "show", "WEB"}, method: "GET", path: "/v1/projects/WEB"},
		{name: "project set", args: []string{"project", "set", "WEB", "--workspace", "", "--acceptance"},
			method: "PATCH", path: "/v1/projects/WEB", body: `{"default_workspace":"","acceptance":true}`},
		{name: "project add", args: []string{"project", "add", "WEB", "bob"}, method: "PUT", path: "/v1/projects/WEB/members/bob"},
		{name: "project remove", args: []string{"project", "remove", "WEB", "bob"}, method: "DELETE", path: "/v1/projects/WEB/members/bob"},
		{name: "workflow show", args: []string{"workflow", "show", "WEB"}, method: "GET", path: "/v1/projects/WEB/workflow"},
		{name: "workflow set", args: []string{"workflow", "set", "WEB", "--file", wf},
			method: "PUT", path: "/v1/projects/WEB/workflow", body: `{"workflows":[{"id":"w1","name":"Work","position":1}],"steps":[{"id":"st1","workflow":"Work","name":"Backlog","position":1},{"workflow":"Work","name":"Build","skill":"engineer","position":2,"x":448,"y":0}],` +
				`"connectors":[{"from":"Backlog","to":"Build","name":"ready","position":1},{"from":"Build","name":"pass","position":1}],"moves":{"st9":"Build"}}`},
		{name: "label create", args: []string{"label", "create", "bug", "--color", "#ff0000"},
			method: "POST", path: "/v1/labels", body: `{"name":"bug","color":"#ff0000"}`},
		{name: "label create in a Project", args: []string{"label", "create", "bug", "--color", "#ff0000", "--project", "WEB"},
			method: "POST", path: "/v1/projects/WEB/labels", body: `{"name":"bug","color":"#ff0000"}`},
		{name: "label list", args: []string{"label", "list", "--project", "WEB"}, before: []string{"GET /v1/labels"},
			method: "GET", path: "/v1/projects/WEB/labels"},
		{name: "label update by name", args: []string{"label", "update", "BUG", "--color", "#00ff00"}, before: []string{"GET /v1/labels"},
			method: "PATCH", path: "/v1/labels/l1", body: `{"color":"#00ff00"}`},
		{name: "label delete", args: []string{"label", "delete", "l1"}, before: []string{"GET /v1/labels"},
			method: "DELETE", path: "/v1/labels/l1"},
		{name: "label set", args: []string{"label", "set", "WEB-3", "bug, client-x"},
			method: "PUT", path: "/v1/tasks/WEB-3/labels", body: `{"labels":["bug","client-x"]}`},
		{name: "label set none", args: []string{"label", "set", "WEB-3", ""},
			method: "PUT", path: "/v1/tasks/WEB-3/labels", body: `{"labels":[]}`},
		{name: "activity filtered", args: []string{"activity", "--member", "bob", "--kind", "task.claimed,task.lapsed", "--project", "WEB"},
			method: "GET", path: "/v1/activity", query: "before=9007199254740991&member=bob&kind=task.claimed&kind=task.lapsed&project=WEB"},
		{name: "activity of a Task", args: []string{"activity", "--task", "WEB-1"},
			method: "GET", path: "/v1/activity", query: "before=9007199254740991&task=WEB-1"},
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

// The work commands end to end against a real server on both engines, on the default Workflow:
// Break down, Subtasks, Notes, Observations, Evidence, a question that blocks, advance along the
// outcomes (and the refusals naming them), take-back, Rank and ownership, the Owner completing
// the Parent, and its Retrospective proposing a Skill version that skill-review publishes.
func TestPhase2Flow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		ada.ok("skill", "create", "engineer-acme", "--kind", "company", "--base", "engineer", "--body", "Build it the Acme way.")
		in.agent("rita", "", "review", "skill-review")
		ada.ok("project", "create", "SHOP", "Shop", "--member", "ada", "--member", "bob", "--member", "rita")
		ada.ok("report-to", "bob", "ada")
		bob, rita := in.as("bob", "bob-1"), in.as("rita", "rita-1")

		// Break down: the Breakdown Subtask waits at Plan, and its Owner takes it, as nobody in SHOP
		// has breakdown; its holder files the Subtasks and advances it into Done.
		var parent client.TaskDetail
		bob.json(&parent, "file", "--project", "SHOP", "--title", "Search", "--breakdown")
		if parent.Task.Key != "SHOP-1" || len(parent.Subtasks) != 1 || parent.Subtasks[0].Kind != client.Breakdown {
			t.Fatalf("filed with Break down: %+v", parent)
		}
		plan := parent.Subtasks[0].Key
		bob.ok("claim", plan, "--timeout", "60")
		var built client.TaskDetail
		bob.json(&built, "file", "--parent", "SHOP-1", "--title", "Build search")
		task := built.Task.Key
		if built.Parent == nil || built.Parent.Key != "SHOP-1" || built.Step == nil || built.Step.Name != "Build" {
			t.Fatalf("the Subtask: %+v at %+v", built.Parent, built.Step)
		}
		if out := bob.ok("advance", plan, "--note", "one Subtask"); !strings.HasPrefix(out, "Completed "+plan+".\n") {
			t.Fatalf("advance along Plan's one way:\n%s", out)
		}

		bob.ok("claim", task, "--timeout", "60")
		bob.ok("note", task, "indexing", "done")
		bob.ok("observe", task, "--worked", "small commits")
		report := filepath.Join(t.TempDir(), "report.txt")
		os.WriteFile(report, []byte("all green\n"), 0o600)
		var ev client.Evidence
		bob.json(&ev, "attach", task, report)
		if ev.Filename != "report.txt" || ev.Size != 10 || ev.TaskID != built.Task.ID {
			t.Fatalf("attach: %+v", ev)
		}
		out := filepath.Join(t.TempDir(), "back.txt")
		bob.ok("evidence", "get", ev.ID, "-o", out)
		if b, _ := os.ReadFile(out); string(b) != "all green\n" {
			t.Fatalf("downloaded %q", b)
		}
		var onParent client.Evidence
		bob.json(&onParent, "attach", "SHOP-1", report, "--name", "plan.txt")
		if onParent.TaskID != parent.Task.ID || onParent.Filename != "plan.txt" {
			t.Fatalf("attach to the Parent: %+v", onParent)
		}

		// A question aimed at ada lands beside the Task, under its Parent, and blocks it until it
		// ends.
		var q client.TaskDetail
		bob.json(&q, "file", "--blocks", task, "--aim", "ada", "--title", "Which index?")
		if q.Parent == nil || q.Parent.Key != "SHOP-1" {
			t.Fatalf("the question's Parent: %+v", q.Parent)
		}
		var blocked client.TaskDetail
		bob.json(&blocked, "show", task)
		if !blocked.Task.Blocked || len(blocked.Blockers) != 1 || len(deref(blocked.Task.OpenBlockers)) != 1 {
			t.Fatalf("after the question: %+v", blocked.Task)
		}
		if out := bob.ok("tasks", "--parent", "SHOP-1"); !strings.Contains(out, "[blocked by "+q.Task.Key+"]") || !strings.Contains(out, "@ada") {
			t.Fatalf("tasks does not say what blocks %s:\n%s", task, out)
		}
		bob.ok("unblock", task, "--by", q.Task.Key)
		bob.ok("block", task, "--by", q.Task.Key)
		if res := bob.fails(ExitRefused, "block", q.Task.Key, "--by", task); !strings.Contains(res.stderr, "cycle") {
			t.Fatalf("a blocking loop: %q", res.stderr)
		}
		ada.ok("claim", q.Task.Key, "--timeout", "0")
		ada.ok("complete", q.Task.Key, "--note", "Use the trigram index.")

		// Build has no way into Done, and no outcome "ship it": both refused, naming the outcomes.
		if res := bob.fails(ExitRefused, "complete", task); !strings.Contains(res.stderr, "use_advance") || !strings.Contains(res.stderr, "pass") {
			t.Fatalf("complete at Build: %q", res.stderr)
		}
		res := bob.fails(ExitRefused, "advance", task, "ship it", "--json")
		var refused struct {
			Code    string
			Details struct{ Outcomes []string }
		}
		if err := json.Unmarshal([]byte(res.stderr), &refused); err != nil || refused.Code != "no_connector" || !slices.Equal(refused.Details.Outcomes, []string{"pass"}) {
			t.Fatalf("advance with no such outcome: %q", res.stderr)
		}
		if out := bob.ok("show", task); !strings.Contains(out, "\n  Step       Build (engineer) since ") || !strings.Contains(out, "\n  Advance    pass → Review\n") ||
			!strings.Contains(out, "\n  Parent     SHOP-1 Search\n") {
			t.Fatalf("show at Build:\n%s", out)
		}
		var handed client.Task
		bob.json(&handed, "advance", task, "PASS", "--note", "ready for review")
		if handed.Claim != nil || handed.StepID == nil {
			t.Fatalf("advance left %+v", handed)
		}

		// The review is rita's; the Owner takes it back, and rita claims it again and sends it back.
		bob.fails(ExitRefused, "claim", task, "--timeout", "60")
		rita.ok("claim", task, "--timeout", "60")
		bob.ok("take-back", task, "--reason", "reassigning")
		rita.fails(ExitRefused, "heartbeat", task)
		rita.ok("claim", task, "--timeout", "60")
		if out := rita.ok("show", task); !strings.Contains(out, "\n  Advance    pass → Done · needs changes → Build\n") {
			t.Fatalf("show at Review:\n%s", out)
		}
		rita.ok("advance", task, "needs changes", "--note", "name the index")
		bob.ok("claim", task, "--timeout", "60")
		bob.ok("advance", task, "pass")
		rita.ok("claim", task, "--timeout", "60")
		var completed client.Task
		rita.json(&completed, "advance", task, "pass")
		if completed.State != client.TaskStateDone || completed.StepID != nil {
			t.Fatalf("advanced into Done: %+v", completed)
		}

		// Rank and ownership are a top-level Task's; a Subtask takes both from its Parent.
		bob.ok("file", "--project", "SHOP", "--title", "Later")
		var ranked client.Task
		bob.json(&ranked, "rank", "SHOP-5", "1")
		if deref(ranked.Rank) != 1 {
			t.Fatalf("rank: %+v", ranked)
		}
		if res := bob.fails(ExitRefused, "rank", task, "1"); !strings.Contains(res.stderr, "use_parent") {
			t.Fatalf("ranking a Subtask: %q", res.stderr)
		}
		bob.fails(ExitRefused, "owner", task, "ada")
		var passed client.Task
		bob.json(&passed, "owner", "SHOP-1", "ada")
		if out := ada.ok("show", "SHOP-1"); !strings.Contains(out, "\n  Owner      ada, Rank 2\n") ||
			!strings.Contains(out, "\n  Subtasks   0 open (0 working), 3 done, 0 dropped\n") || !strings.Contains(out, "\nSubtasks:\n") ||
			!strings.Contains(out, "\n  Completes  by its Owner") {
			t.Fatalf("show the Parent:\n%s", out)
		}
		var parentDone client.Task
		ada.json(&parentDone, "complete", "SHOP-1")
		if parentDone.State != client.TaskStateDone {
			t.Fatalf("complete the Parent: %+v", parentDone)
		}
		var subtasks client.TaskList
		ada.json(&subtasks, "tasks", "--parent", "SHOP-1", "--state", "open")
		if len(subtasks.Items) != 1 || subtasks.Items[0].Kind != client.Retrospective {
			t.Fatalf("completing filed no Retrospective: %+v", subtasks.Items)
		}
		retro := subtasks.Items[0].Key

		// The Retrospective: the Owner takes it, as nobody in SHOP has retro, reads the
		// Observations, and proposes a new version of the company Skill for review.
		ada.ok("claim", retro, "--timeout", "0")
		var obs client.ObservationList
		ada.json(&obs, "observations", "SHOP-1")
		if len(obs.Items) != 1 || obs.Items[0].Body != "small commits" {
			t.Fatalf("observations: %+v", obs)
		}
		ada.stdin = "Build it the Acme way, in small commits.\n"
		var proposed client.SkillProposal
		ada.json(&proposed, "propose", retro, "--skill", "engineer-acme", "--base", "1", "--file", "-")
		ada.stdin = ""
		if proposed.State != client.Pending || proposed.BasedOnVersion != 1 {
			t.Fatalf("propose: %+v", proposed)
		}
		if res := ada.fails(ExitRefused, "propose", retro, "--skill", "engineer-acme", "--base", "9", "--file", report); !strings.Contains(res.stderr, "proposal_stale") {
			t.Fatalf("a proposal against a version that is not current: %q", res.stderr)
		}
		ada.ok("advance", retro, "propose")
		rita.ok("claim", retro, "--timeout", "60")
		var shown []client.SkillProposal
		rita.json(&shown, "proposal", "show", retro)
		if len(shown) != 1 || shown[0].ID != proposed.ID || shown[0].Body != "Build it the Acme way, in small commits.\n" {
			t.Fatalf("proposal show %s: %+v", retro, shown)
		}
		if out := rita.ok("proposal", "show", retro); !strings.Contains(out, "engineer-acme, written against v1") || !strings.Contains(out, "in small commits") {
			t.Fatalf("proposal show printed:\n%s", out)
		}
		rita.ok("advance", retro, "publish")
		var published client.SkillProposal
		rita.json(&published, "proposal", "show", proposed.ID)
		if published.State != client.Published || deref(published.PublishedVersion) != 2 {
			t.Fatalf("after the review: %+v", published)
		}
		var skill client.SkillDetail
		rita.json(&skill, "skill", "show", "engineer-acme")
		if skill.Current.Version != 2 || skill.Current.Body != "Build it the Acme way, in small commits.\n" {
			t.Fatalf("the published version: %+v", skill.Current)
		}
		ada.json(&obs, "observations", "SHOP-1")
		var everything client.ObservationList
		ada.json(&everything, "observations", "SHOP-1", "--all")
		if len(obs.Items) != 0 || len(everything.Items) != 1 || everything.Items[0].ReviewedAt == nil {
			t.Fatalf("after the Retrospective: unreviewed %+v, all %+v", obs.Items, everything.Items)
		}
		if res := rita.fails(ExitFailed, "proposal", "show", "SHOP-5"); !strings.Contains(res.stderr, "no Skill proposal") {
			t.Fatalf("proposal show of a Task with none: %q", res.stderr)
		}

		var dropped client.Task
		bob.json(&dropped, "drop", "SHOP-5")
		if dropped.State != client.TaskStateDropped {
			t.Fatalf("drop: %+v", dropped)
		}
	})
}

// Projects, Workflows, moves and Labels through the CLI against a real server on both engines:
// the Workflow shown and set from its own --body, filing into a hold, moving out of it, the Step
// in tasks and show, Labels set and listed, and the refusals exiting 3.
func TestWorkflowCommands(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada := in.as("ada", "ada-1")
		ada.ok("project", "add", "WEB", "ada")
		bob := in.as("bob", "bob-1")

		out := bob.ok("workflow", "show", "WEB")
		for _, want := range []string{"1   Plan             breakdown        0 waiting, 0 working  nobody holds its Skill\n      done → Done\n",
			"2   Build            engineer         0 waiting, 0 working  taken by bob (agent)\n      pass → Done\n"} {
			if !strings.Contains(out, want) {
				t.Fatalf("workflow show lacks %q:\n%s", want, out)
			}
		}
		// A Backlog hold before Plan, from the body workflow show --body prints.
		var body client.SetWorkflowBody
		bob.json(&body, "workflow", "show", "WEB", "--body")
		if len(body.Steps) != 2 || deref(body.Steps[1].Skill) != "engineer" || body.Connectors[1].From != "Build" || body.Connectors[1].To != nil {
			t.Fatalf("workflow show --body: %+v", body)
		}
		for i := range body.Steps {
			body.Steps[i].Position++
		}
		body.Steps = append(body.Steps, client.StepInput{Workflow: "Work", Name: "Backlog", Position: 1})
		body.Connectors = append(body.Connectors, client.ConnectorInput{From: "Backlog", To: ptr("Build"), Name: "ready", Position: 1})
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(t.TempDir(), "workflow.json")
		if err := os.WriteFile(file, b, 0o600); err != nil {
			t.Fatal(err)
		}
		bob.fails(ExitRefused, "workflow", "set", "WEB", "--file", file)
		out = ada.ok("workflow", "set", "WEB", "--file", file)
		if !strings.HasPrefix(out, "1   Backlog          hold             0 waiting, 0 working\n      ready → Build\n2   Plan ") {
			t.Fatalf("workflow set:\n%s", out)
		}

		ada.ok("file", "--project", "WEB", "--title", "Later", "--step", "backlog")
		out = bob.ok("tasks", "--project", "WEB", "--step", "Backlog")
		if !strings.Contains(out, "WEB-1     open          Backlog        -              Later") || strings.Count(out, "\n") != 1 {
			t.Fatalf("tasks at the Backlog:\n%s", out)
		}
		if res := bob.fails(ExitFailed, "tasks", "--filter", "kind:is:feature"); !strings.Contains(res.stderr, `"kind:is:feature"`) {
			t.Fatalf("tasks --filter with a bad kind: %s", res.stderr)
		}
		if res := bob.fails(ExitNothing, "next", "--wait", "0", "--timeout", "0"); res.stdout != "" {
			t.Fatalf("next offered the hold: %s", res.stdout)
		}
		if out := bob.ok("show", "WEB-1"); !strings.Contains(out, "\n  Step       Backlog (a hold: a person moves it on (darkory move)) since ") {
			t.Fatalf("show at the hold:\n%s", out)
		}
		if res := bob.fails(ExitFailed, "move", "WEB-1", "Nowhere"); !strings.Contains(res.stderr, "not_found") {
			t.Fatalf("move to no Step: %s", res.stderr)
		}
		out = bob.ok("move", "WEB-1", "build", "--note", "ready now")
		if !strings.HasPrefix(out, "Moved WEB-1.\nWEB-1     open          Build          engineer       Later") {
			t.Fatalf("move:\n%s", out)
		}
		out = bob.ok("next", "--wait", "0", "--timeout", "0")
		if !strings.Contains(out, "\n  Step       Build (engineer) since ") || !strings.Contains(out, "\n  Advance    pass → Done\n") {
			t.Fatalf("next does not show the Step:\n%s", out)
		}

		// Labels: the Organisation's and the Project's, set on a Task by name, listed by name.
		ada.ok("label", "create", "client-x", "--color", "#00AA00")
		bob.ok("label", "create", "bug", "--color", "#ff0000", "--project", "WEB")
		if res := bob.fails(ExitRefused, "label", "create", "BUG", "--color", "#ff0000"); !strings.Contains(res.stderr, "forbidden") && !strings.Contains(res.stderr, "conflict") {
			t.Fatalf("an Organisation Label by a non-admin: %s", res.stderr)
		}
		out = bob.ok("label", "list", "--project", "WEB")
		if !strings.Contains(out, "client-x             #00aa00  Organisation") || !strings.Contains(out, "bug                  #ff0000  WEB") {
			t.Fatalf("label list:\n%s", out)
		}
		var labelled client.Task
		bob.json(&labelled, "label", "set", "WEB-1", "bug,Client-X")
		if len(deref(labelled.Labels)) != 2 {
			t.Fatalf("label set: %+v", labelled)
		}
		if out := bob.ok("tasks", "--project", "WEB"); !strings.Contains(out, "[bug, client-x]") {
			t.Fatalf("tasks with Labels:\n%s", out)
		}
		if out := bob.ok("show", "WEB-1"); !strings.Contains(out, "\n  Labels     bug, client-x\n") {
			t.Fatalf("show with Labels:\n%s", out)
		}
		ada.ok("label", "update", "client-x", "--name", "client-y")
		bob.ok("label", "delete", "bug", "--project", "WEB")
		if out := bob.ok("show", "WEB-1"); !strings.Contains(out, "\n  Labels     client-y\n") {
			t.Fatalf("show after the Labels changed:\n%s", out)
		}
		bob.ok("label", "set", "WEB-1", "")
		if out := bob.ok("show", "WEB-1"); strings.Contains(out, "Labels") {
			t.Fatalf("show after the Labels were cleared:\n%s", out)
		}
	})
}
