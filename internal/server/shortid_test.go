package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// longID is the canonical 36-character text of a short id the API wrote, as an old link, the
// CLI's stored Session or an owner's notes from before short ids would spell it.
func longID(t *testing.T, short string) string {
	t.Helper()
	if !shortid.IsShort(short) {
		t.Fatalf("the API wrote %q, not a short id", short)
	}
	long, _ := shortid.Parse(short)
	return long
}

// noUUIDs fails when a reply spells any id as a UUID.
func noUUIDs(t *testing.T, what string, body []byte) {
	t.Helper()
	if m := uuidText.Find(body); m != nil {
		t.Fatalf("%s carries the UUID %s; ids are written short:\n%s", what, m, body)
	}
}

func (h *harness) send(method, path, body string) (int, []byte) {
	h.t.Helper()
	req, err := http.NewRequestWithContext(h.t.Context(), method, h.ts.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+h.adminSecret)
	req.Header.Set("Darkory-Session", "ada-cli")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// A name spelled as an id, in either form, is refused, so a reference by id or name stays
// unambiguous (decisions.md).
func TestNamesCannotBeSpelledAsShortIDs(t *testing.T) {
	h := newHarness(t, storetest.Open(t, store.SQLite))
	for _, name := range []string{"1CTuJUrXDEC71Dv55PHKrq", "0199c2a0-7b3e-7c41-9f12-842120d6a1b2"} {
		status, body := h.send(http.MethodPost, "/v1/members", `{"name":"`+name+`","kind":"agent"}`)
		if status != http.StatusBadRequest || !strings.Contains(string(body), "spelled as an id") {
			t.Errorf("a Member named %s: %d %s", name, status, body)
		}
	}
}

// Every reply writes ids short, and a 36-character id still works wherever an id is read: a read,
// a write's path and body, a filter (and a View keeping it), the Activity stream, and the Session
// header (ADR 0017).
func TestShortIDsOutAndBothFormsIn(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{},
			client.CreateProjectBody{Key: "WEB", Name: "Web", Members: &[]string{"ada"}})).want(t, http.StatusCreated)
		label := got(h.admin.CreateProjectLabelWithResponse(ctx, "WEB", &client.CreateProjectLabelParams{},
			client.CreateLabelBody{Name: "bug", Color: "#ff0000"})).want(t, http.StatusCreated).JSON201
		d := h.file(h.admin, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Short ids"})
		task, project := d.Task.ID, d.Task.ProjectID
		longTask, longLabel, longProject := longID(t, task), longID(t, label.ID), longID(t, project)

		// Read: the Task by its long id answers with its short one.
		status, body := h.send(http.MethodGet, "/v1/tasks/"+longTask, "")
		if status != http.StatusOK {
			t.Fatalf("GET by the long id: %d %s", status, body)
		}
		noUUIDs(t, "getTask", body)
		var read client.TaskDetail
		if err := json.Unmarshal(body, &read); err != nil || read.Task.ID != task {
			t.Fatalf("GET by the long id read %q, want %q (%v)", read.Task.ID, task, err)
		}

		// Write: a long id in the path and in the body.
		status, body = h.send(http.MethodPut, "/v1/tasks/"+longTask+"/labels", `{"labels":["`+longLabel+`"]}`)
		if status != http.StatusOK {
			t.Fatalf("set labels by long ids: %d %s", status, body)
		}
		noUUIDs(t, "setTaskLabels", body)
		var labelled client.Task
		if err := json.Unmarshal(body, &labelled); err != nil || labelled.Labels == nil || (*labelled.Labels)[0] != label.ID {
			t.Fatalf("labels after setting them by long ids: %s", body)
		}
		status, body = h.send(http.MethodPatch, "/v1/labels/"+longLabel, `{"name":"defect"}`)
		if status != http.StatusOK {
			t.Fatalf("PATCH a Label by its long id: %d %s", status, body)
		}

		// Filter: a long id in a filter token, in a query parameter, and in a View, which keeps
		// it and gives it back short.
		for _, q := range []string{
			"filter=" + url.QueryEscape("label:is:"+longLabel),
			"filter=" + url.QueryEscape("project:in:"+longProject+","+project),
			"project=" + longProject,
		} {
			status, body = h.send(http.MethodGet, "/v1/tasks?"+q, "")
			var page client.TaskList
			if status != http.StatusOK || json.Unmarshal(body, &page) != nil || len(page.Items) != 1 || page.Items[0].ID != task {
				t.Fatalf("listTasks?%s: %d %s", q, status, body)
			}
			noUUIDs(t, "listTasks", body)
		}
		status, body = h.send(http.MethodPost, "/v1/views", `{"entity":"tasks","name":"Bugs","filters":["label:in:`+longLabel+`","parent:in:`+longTask+`,none"]}`)
		if status != http.StatusCreated {
			t.Fatalf("create a View with a long id: %d %s", status, body)
		}
		noUUIDs(t, "createView", body)
		var view client.View
		_ = json.Unmarshal(body, &view)
		if want := "parent:in:" + task + ",none"; view.Filters[0] != "label:in:"+label.ID || view.Filters[1] != want {
			t.Fatalf("the View's filters are %q, want label:in:%s and %s", view.Filters, label.ID, want)
		}
		var kept string
		if err := st.QueryRow(ctx, `SELECT filters FROM views WHERE id = $1`, longID(t, view.ID)).Scan(&kept); err != nil || !strings.Contains(kept, longLabel) {
			t.Fatalf("the View is kept with %s (%v), want the canonical id", kept, err)
		}

		// Stream: the Activity of the Task, asked for by its long id, from the start; every id in
		// it short, its payloads' too.
		status, body = h.send(http.MethodGet, "/v1/activity?task="+longTask, "")
		if status != http.StatusOK || !strings.Contains(string(body), `"subject_id":"`+task+`"`) || !strings.Contains(string(body), label.ID) {
			t.Fatalf("listActivity?task=<long id>: %d %s", status, body)
		}
		noUUIDs(t, "listActivity", body)
		s := h.openStreamAs(t, h.adminSecret, "ada-stream", "")
		defer s.close()
		h.send(http.MethodPost, "/v1/tasks/"+longTask+"/notes", `{"body":"a Note, written by a long id"}`)
		for {
			line, err := s.r.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if data, ok := strings.CutPrefix(line, "data: "); ok {
				noUUIDs(t, "the stream", []byte(data))
				if !strings.Contains(data, `"subject_id":"`+task+`"`) || !strings.Contains(data, `"note_id":"`) {
					t.Fatalf("the stream sent %s", data)
				}
				break
			}
		}

		// The Session header: a Session chosen as a UUID is one Session in either form, and is
		// written short.
		chosen := longID(t, task) // any UUID will do
		long := h.client(h.adminSecret, chosen)
		short := h.client(h.adminSecret, shortid.Short(chosen))
		me1 := got(long.GetMeWithResponse(ctx)).want(t, http.StatusOK).JSON200
		me2 := got(short.GetMeWithResponse(ctx)).want(t, http.StatusOK).JSON200
		if me1.Session.ID != shortid.Short(chosen) || me2.Session.ID != me1.Session.ID {
			t.Fatalf("the Session chosen as %s is %s and %s", chosen, me1.Session.ID, me2.Session.ID)
		}
		got(h.admin.CloseSessionWithResponse(ctx, chosen, &client.CloseSessionParams{})).want(t, http.StatusOK)

		// A refusal names an id short too, whichever form the request used.
		const nothing = "0199c2a0-7b3e-7c41-9f12-842120d6a1b2"
		status, body = h.send(http.MethodPatch, "/v1/labels/"+nothing, `{"name":"x"}`)
		if status != http.StatusNotFound || !strings.Contains(string(body), shortid.Short(nothing)) {
			t.Fatalf("PATCH a Label that is not: %d %s", status, body)
		}
		noUUIDs(t, "a refusal", body)

		// Not ids: a Task title spelled as a UUID is kept as written, in the reply and in Activity.
		titled := h.file(h.admin, client.FileTaskBody{Project: ptrStr("WEB"), Title: longTask})
		if titled.Task.Title != longTask {
			t.Fatalf("a title spelled as a UUID came back as %q", titled.Task.Title)
		}
		_, body = h.send(http.MethodGet, "/v1/activity?task="+titled.Task.ID, "")
		if !strings.Contains(string(body), `"title":"`+longTask+`"`) {
			t.Fatalf("task.filed's title is not as written: %s", body)
		}
	})
}
