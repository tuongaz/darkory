package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/blob"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// harness is an initialised Install behind an httptest server, with a client for its first
// Member, the admin ada.
type harness struct {
	t     *testing.T
	srv   *Server
	ts    *httptest.Server
	admin *client.ClientWithResponses
	// adminSecret is ada's token.
	adminSecret string
	adminID     string
	// secrets holds the token of each agent the test made, by name.
	secrets map[string]string
}

func newHarness(t *testing.T, st *store.Store) *harness {
	t.Helper()
	return newHarnessWith(t, st, Options{})
}

func newHarnessWith(t *testing.T, st *store.Store, o Options) *harness {
	t.Helper()
	if o.KeepAlive == 0 {
		o.KeepAlive = 100 * time.Millisecond
	}
	if o.Blobs == nil {
		disk, err := blob.NewDisk(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		o.Blobs = disk
	}
	srv := New(st, o)
	init, err := srv.Core().Init(t.Context(), "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	h := &harness{t: t, srv: srv, ts: ts, adminSecret: init.Token.Secret, adminID: init.Member.ID, secrets: map[string]string{}}
	h.admin = h.client(init.Token.Secret, "ada-cli")
	return h
}

// client returns a generated client that sends secret and the Session id.
func (h *harness) client(secret, session string) *client.ClientWithResponses {
	h.t.Helper()
	c, err := client.NewClientWithResponses(h.ts.URL, client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		if secret != "" {
			req.Header.Set("Authorization", "Bearer "+secret)
		}
		if session != "" {
			req.Header.Set("Darkory-Session", session)
		}
		return nil
	}))
	if err != nil {
		h.t.Fatal(err)
	}
	return c
}

func newTestServer(t *testing.T) (*httptest.Server, *client.ClientWithResponses) {
	t.Helper()
	h := newHarness(t, storetest.Open(t, store.SQLite))
	return h.ts, h.admin
}

func TestHealthNeedsNoCredential(t *testing.T) {
	ts, _ := newTestServer(t)
	c, err := client.NewClientWithResponses(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
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

// A request without a credential is never a Member, though it comes from 127.0.0.1; a bearer
// token needs its Session id.
func TestCredentials(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		if !strings.HasPrefix(h.ts.URL, "http://127.0.0.1:") {
			t.Fatalf("the test server is not on localhost: %s", h.ts.URL)
		}
		for _, tc := range []struct {
			name, secret, session string
			code                  client.ErrorCode
		}{
			{"no credential", "", "", client.ErrorCodeUnauthenticated},
			{"no credential with a Session id", "", "s1", client.ErrorCodeUnauthenticated},
			{"unknown token", "dk_nothing", "s1", client.ErrorCodeUnauthenticated},
			{"token without a Session", h.adminSecret, "", client.ErrorCodeSessionRequired},
		} {
			res, err := h.client(tc.secret, tc.session).GetMeWithResponse(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode() != http.StatusUnauthorized || res.JSONDefault == nil || res.JSONDefault.Code != tc.code {
				t.Errorf("%s: status %d body %s, want 401 %s", tc.name, res.StatusCode(), res.Body, tc.code)
			}
		}
		me, err := h.admin.GetMeWithResponse(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if me.JSON200 == nil || me.JSON200.Member.Name != "ada" || !me.JSON200.Member.Admin ||
			me.JSON200.Session.ID != "ada-cli" || me.JSON200.Session.Kind != client.SessionKindToken {
			t.Fatalf("me: status %d body %s", me.StatusCode(), me.Body)
		}
	})
}

// The generated client sees an unbuilt operation's 501 as the Error body.
func TestUnbuiltOperationsAnswer501ThroughTheClient(t *testing.T) {
	_, c := newTestServer(t)
	res, err := c.RequestEmailSignInWithResponse(t.Context(), &client.RequestEmailSignInParams{}, client.EmailSignInBody{Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode() != http.StatusNotImplemented || res.JSONDefault == nil || res.JSONDefault.Code != client.ErrorCodeNotImplemented {
		t.Fatalf("requestEmailSignIn: status %d body %s", res.StatusCode(), res.Body)
	}
}

// unbuilt lists the operations still answering 501 from stubs.go.
var unbuilt = []string{"RequestEmailSignIn"}

// Every operation not yet built answers 501 with the Error body.
func TestEveryUnbuiltOperationAnswers501(t *testing.T) {
	srv := New(nil, Options{})
	iface := reflect.TypeFor[gen.ServerInterface]()
	for _, name := range unbuilt {
		m, ok := iface.MethodByName(name)
		if !ok {
			t.Fatalf("%s is not an operation", name)
		}
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/v1/"+name, nil)
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
