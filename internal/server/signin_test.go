package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

const publicURL = "https://darkory.example.com"

var emailedLink = regexp.MustCompile(`https://darkory\.example\.com(/v1/login-links/[A-Za-z0-9_-]+)`)

// askByEmail posts an email sign-in request with no credential and returns its status.
func askByEmail(t *testing.T, ts *httptest.Server, body string, headers map[string]string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/sign-in/email", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

// redeem opens a login link's path in a browser that does not follow redirects.
func redeem(t *testing.T, ts *httptest.Server, path string) *http.Response {
	t.Helper()
	browser := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := browser.Get(ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func countLinks(t *testing.T, st *store.Store) int {
	t.Helper()
	var n int
	if err := st.QueryRow(t.Context(), `SELECT COUNT(*) FROM login_links`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A Member who asks by email gets a one-time link built on the public URL, which signs a browser
// in once and expires like a printed link; the reply is 202 whether or not the address belongs to
// a Member.
func TestEmailSignIn(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		fake := mail.NewFake()
		clk := clock.NewFake(time.Now())
		h := newHarnessWith(t, st, Options{Mail: fake, PublicURL: publicURL, Clock: clk})
		ctx := t.Context()
		email := "Bob@Example.com"
		got(h.admin.CreateMemberWithResponse(ctx, &client.CreateMemberParams{},
			client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
		if modes := h.srv.SignInModes(); !slices.Equal(modes, []string{"printed_link", "email_link"}) {
			t.Fatalf("sign-in modes %v", modes)
		}

		since := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200.LastSeq

		// Matched without regard to case, sent to the address the Member has.
		if s := askByEmail(t, h.ts, `{"email":"bob@example.com"}`, nil); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
		m, ok := fake.Next(5 * time.Second)
		if !ok {
			t.Fatal("no email sent")
		}
		link := emailedLink.FindStringSubmatch(m.Text)
		if m.To != email || link == nil || !strings.Contains(m.Text, "bob") || !strings.Contains(m.Text, "Acme") {
			t.Fatalf("sent %+v", m)
		}
		res := redeem(t, h.ts, link[1])
		if res.StatusCode != http.StatusSeeOther || len(res.Cookies()) != 1 {
			t.Fatalf("redeeming: %d %v", res.StatusCode, res.Cookies())
		}
		req, _ := http.NewRequest(http.MethodGet, h.ts.URL+"/v1/me", nil)
		req.AddCookie(res.Cookies()[0])
		me, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body gen.Me
		decode(t, me, &body)
		if body.Member.Name != "bob" {
			t.Fatalf("signed in as %+v", body.Member)
		}
		if res := redeem(t, h.ts, link[1]); res.StatusCode != http.StatusNotFound {
			t.Fatalf("a second use: %d", res.StatusCode)
		}

		// Expires after 15 minutes, as a printed link does.
		askByEmail(t, h.ts, `{"email":"bob@example.com"}`, nil)
		m, ok = fake.Next(5 * time.Second)
		if !ok {
			t.Fatal("no second email")
		}
		clk.Advance(15*time.Minute + time.Second)
		if res := redeem(t, h.ts, emailedLink.FindStringSubmatch(m.Text)[1]); res.StatusCode != http.StatusNotFound {
			t.Fatalf("an expired link: %d", res.StatusCode)
		}

		// Each issue is recorded in Activity with no actor.
		page := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{After: &since})).want(t, http.StatusOK).JSON200
		var issued int
		for _, a := range page.Items {
			if a.Kind == "login_link.issued" && a.ActorID == nil {
				issued++
			}
		}
		if issued != 2 {
			t.Fatalf("%d login_link.issued entries without an actor, want 2", issued)
		}

		// An address no Member has: the same reply, no link, no email.
		before := countLinks(t, st)
		if s := askByEmail(t, h.ts, `{"email":"nobody@example.com"}`, nil); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
		if m, ok := fake.Next(300 * time.Millisecond); ok {
			t.Fatalf("sent %+v", m)
		}
		if countLinks(t, st) != before {
			t.Fatal("issued a link for an unknown address")
		}
	})
}

// The reply does not wait for the email: it comes back while the send is held.
func TestEmailSignInAnswersBeforeSending(t *testing.T) {
	fake := mail.NewFake()
	fake.Block = make(chan struct{})
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: fake, PublicURL: publicURL})
	email := "bob@example.com"
	got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
		client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	done := make(chan int, 1)
	go func() { done <- askByEmail(t, h.ts, `{"email":"bob@example.com"}`, nil) }()
	select {
	case s := <-done:
		if s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the reply waited for the email")
	}
	close(fake.Block)
	if _, ok := fake.Next(5 * time.Second); !ok {
		t.Fatal("no email once released")
	}
}

// Each address, and each client address, is limited; over a limit the reply is the same and
// nothing is sent.
func TestEmailSignInIsRateLimited(t *testing.T) {
	fake := mail.NewFake()
	clk := clock.NewFake(time.Now())
	st := storetest.Open(t, store.SQLite)
	// Behind one proxy, so the test can ask from two clients.
	h := newHarnessWith(t, st, Options{Mail: fake, PublicURL: publicURL, Clock: clk, ProxyHops: 1})
	for _, name := range []string{"bob", "carol"} {
		email := name + "@example.com"
		got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
			client.CreateMemberBody{Name: name, Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	}
	ask := func(from, email string) {
		t.Helper()
		if s := askByEmail(t, h.ts, `{"email":"`+email+`"}`, map[string]string{"X-Forwarded-For": from}); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
	}
	sent := func() int {
		t.Helper()
		var n int
		for {
			if _, ok := fake.Next(time.Second); !ok {
				return n
			}
			n++
		}
	}
	const a, b = "198.51.100.1", "198.51.100.2"

	for range 4 {
		ask(a, "BOB@example.com")
	}
	if n := sent(); n != 3 {
		t.Fatalf("sent %d of 4 asks for one address, want 3", n)
	}
	clk.Advance(5 * time.Minute)
	ask(a, "bob@example.com")
	if n := sent(); n != 1 {
		t.Fatalf("sent %d after five minutes, want 1", n)
	}

	// Client a's burst of ten is back to nine; nine asks for other addresses use it up.
	for i := range 9 {
		ask(a, "nobody"+string(rune('a'+i))+"@example.com")
	}
	ask(a, "carol@example.com")
	if n := sent(); n != 0 {
		t.Fatalf("sent %d over the client's limit", n)
	}
	ask(b, "carol@example.com")
	if n := sent(); n != 1 {
		t.Fatalf("another client: sent %d, want 1", n)
	}
	clk.Advance(time.Minute)
	ask(a, "carol@example.com")
	if n := sent(); n != 1 {
		t.Fatalf("sent %d a minute later, want 1", n)
	}
}

// Without email set up, the request is answered the same and does nothing.
func TestEmailSignInWithoutEmail(t *testing.T) {
	for name, o := range map[string]Options{"no mailer": {}, "no public URL": {Mail: mail.NewFake()}} {
		t.Run(name, func(t *testing.T) {
			st := storetest.Open(t, store.SQLite)
			h := newHarnessWith(t, st, o)
			email := "bob@example.com"
			got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
				client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
			before := countLinks(t, st)
			if s := askByEmail(t, h.ts, `{"email":"bob@example.com"}`, nil); s != http.StatusAccepted {
				t.Fatalf("status %d", s)
			}
			time.Sleep(200 * time.Millisecond)
			if countLinks(t, st) != before {
				t.Fatal("issued a link without email set up")
			}
			if modes := h.srv.SignInModes(); !slices.Equal(modes, []string{"printed_link"}) {
				t.Fatalf("sign-in modes %v", modes)
			}
		})
	}
}

func TestEmailSignInRefusesABadBody(t *testing.T) {
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: mail.NewFake(), PublicURL: publicURL})
	for _, body := range []string{`{}`, `{"email":"not an address"}`, `not json`,
		`{"email":"` + strings.Repeat("a", 250) + `@example.com"}`} {
		req, _ := http.NewRequest(http.MethodPost, h.ts.URL+"/v1/sign-in/email", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		assertError(t, res, http.StatusBadRequest, gen.ErrorCodeInvalid)
	}
	req, _ := http.NewRequest(http.MethodPost, h.ts.URL+"/v1/sign-in/email", strings.NewReader(`{"email":"bob@example.com"}`))
	req.Header.Set("Content-Type", "text/plain")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	assertError(t, res, http.StatusBadRequest, gen.ErrorCodeInvalid)
	// The reply's body is empty and says nothing.
	req, _ = http.NewRequest(http.MethodPost, h.ts.URL+"/v1/sign-in/email", strings.NewReader(`{"email":"bob@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	if res, err = http.DefaultClient.Do(req); err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.NewDecoder(res.Body).Decode(&v); err == nil || res.StatusCode != http.StatusAccepted {
		t.Fatalf("status %d body %v", res.StatusCode, v)
	}
	res.Body.Close()
}

func TestClientAddress(t *testing.T) {
	for _, c := range []struct {
		remote string
		xff    []string
		hops   int
		want   string
	}{
		{"203.0.113.7:5000", nil, 0, "203.0.113.7"},
		{"203.0.113.7:5000", []string{"198.51.100.1"}, 0, "203.0.113.7"}, // not trusted without hops
		{"10.0.0.2:5000", []string{"198.51.100.1"}, 1, "198.51.100.1"},
		{"10.0.0.2:5000", []string{"6.6.6.6, 198.51.100.1"}, 1, "198.51.100.1"}, // a forged first entry is ignored
		{"10.0.0.2:5000", []string{"6.6.6.6", "198.51.100.1, 10.0.0.1"}, 2, "198.51.100.1"},
		{"10.0.0.2:5000", nil, 1, "10.0.0.2"},
		{"[2001:db8:1:2:3:4:5:6]:5000", nil, 0, "2001:db8:1:2::/64"},
		{"[::ffff:203.0.113.7]:5000", nil, 0, "203.0.113.7"},
	} {
		r := httptest.NewRequest(http.MethodPost, "/v1/sign-in/email", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := clientAddress(r, c.hops); got != c.want {
			t.Errorf("%s %v hops %d: got %s, want %s", c.remote, c.xff, c.hops, got, c.want)
		}
	}
}
