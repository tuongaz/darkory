package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server/gen"
)

func newTestServer(t *testing.T) (*httptest.Server, *client.ClientWithResponses) {
	t.Helper()
	ts := httptest.NewServer(New(nil).Handler())
	t.Cleanup(ts.Close)
	c, err := client.NewClientWithResponses(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	return ts, c
}

func TestHealthNeedsNoCredential(t *testing.T) {
	_, c := newTestServer(t)
	res, err := c.GetHealthWithResponse(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode() != http.StatusOK || res.JSON200 == nil || res.JSON200.Status != client.HealthStatusOk {
		t.Fatalf("status %d body %s", res.StatusCode(), res.Body)
	}
	if res.JSON200.Version == "" {
		t.Fatal("no version")
	}
}

// The generated client sees an unbuilt operation's 501 as the Error body.
func TestUnbuiltOperationsAnswer501ThroughTheClient(t *testing.T) {
	_, c := newTestServer(t)
	teams, err := c.ListTeamsWithResponse(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if teams.StatusCode() != http.StatusNotImplemented || teams.JSONDefault == nil || teams.JSONDefault.Code != client.ErrorCodeNotImplemented {
		t.Fatalf("listTeams: status %d body %s", teams.StatusCode(), teams.Body)
	}
	title := "Fix the login page"
	filed, err := c.FileTaskWithResponse(t.Context(), &client.FileTaskParams{}, client.FileTaskBody{Title: title})
	if err != nil {
		t.Fatal(err)
	}
	if filed.StatusCode() != http.StatusNotImplemented || filed.JSONDefault == nil || filed.JSONDefault.Code != client.ErrorCodeNotImplemented {
		t.Fatalf("fileTask: status %d body %s", filed.StatusCode(), filed.Body)
	}
}

// Every operation in the spec except health answers 501 with the Error body until it is built.
func TestEveryUnbuiltOperationAnswers501(t *testing.T) {
	srv := New(nil)
	iface := reflect.TypeFor[gen.ServerInterface]()
	for i := range iface.NumMethod() {
		m := iface.Method(i)
		if m.Name == "GetHealth" {
			continue
		}
		t.Run(m.Name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/"+m.Name, nil)
			args := []reflect.Value{reflect.ValueOf(rec), reflect.ValueOf(req)}
			for j := 2; j < m.Type.NumIn(); j++ {
				args = append(args, reflect.Zero(m.Type.In(j)))
			}
			reflect.ValueOf(srv).MethodByName(m.Name).Call(args)
			assertError(t, rec.Result(), http.StatusNotImplemented, gen.ErrorCodeNotImplemented)
		})
	}
}

func TestUnknownAPIPathsAnswerJSON404(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, req := range []struct{ method, path string }{
		{http.MethodGet, "/v1/nothing-here"},
		{http.MethodDelete, "/v1/health"},
	} {
		r, _ := http.NewRequest(req.method, ts.URL+req.path, nil)
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		assertError(t, res, http.StatusNotFound, gen.ErrorCodeNotFound)
	}
}

func TestBadParametersAnswerInvalid(t *testing.T) {
	ts, _ := newTestServer(t)
	res, err := http.Get(ts.URL + "/v1/activity?after=not-a-number")
	if err != nil {
		t.Fatal(err)
	}
	assertError(t, res, http.StatusBadRequest, gen.ErrorCodeInvalid)
}

func TestWebAppIsServedAtRoot(t *testing.T) {
	ts, _ := newTestServer(t)
	for path, want := range map[string]int{
		"/":                    http.StatusOK,
		"/index.html":          http.StatusOK, // redirected to /
		"/features/WEB-1":      http.StatusOK, // the app's own routes
		"/teams/WEB/features/": http.StatusOK,
		"/assets/missing.js":   http.StatusNotFound,
	} {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("GET %s: status %d, want %d", path, res.StatusCode, want)
		}
		if want == http.StatusOK && !strings.Contains(string(body), "<title>Darkory</title>") {
			t.Errorf("GET %s: not the web app: %.80s", path, body)
		}
	}
}

func assertError(t *testing.T, res *http.Response, status int, code gen.ErrorCode) {
	t.Helper()
	defer res.Body.Close()
	if res.StatusCode != status {
		t.Fatalf("status %d, want %d", res.StatusCode, status)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q", ct)
	}
	var body gen.Error
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != code || body.Message == "" {
		t.Fatalf("body %+v, want code %s and a message", body, code)
	}
}
