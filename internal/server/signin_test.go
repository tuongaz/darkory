package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
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
		t.Fatalf("sent %d of 4 asks for one Member, want 3", n)
	}
	clk.Advance(5 * time.Minute)
	ask(a, "bob@example.com")
	if n := sent(); n != 1 {
		t.Fatalf("sent %d after five minutes, want 1", n)
	}

	// Client a's burst of ten is back to nine; nine asks for addresses no Member has use it up.
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

// Addresses no Member has, from many clients, spend only those clients' tokens: no Member's limit
// gets a key and the cap on emails sent loses nothing.
func TestEmailSignInSpendsNothingOnUnknownAddresses(t *testing.T) {
	fake := mail.NewFake()
	st := storetest.Open(t, store.SQLite)
	h := newHarnessWith(t, st, Options{Mail: fake, PublicURL: publicURL, MailPerHour: 2})
	for _, name := range []string{"bob", "carol"} {
		email := name + "@example.com"
		got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
			client.CreateMemberBody{Name: name, Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	}
	e := h.srv.signIn
	links := countLinks(t, st)
	const flood = 10000
	for i := range flood {
		// Wait for a free lookup slot, so every address is looked up rather than turned away.
		for len(e.inFlight) == cap(e.inFlight) {
			time.Sleep(time.Millisecond)
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/sign-in/email",
			strings.NewReader(`{"email":"x`+strconv.Itoa(i)+`@example.org"}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = fmt.Sprintf("[2001:db8:%x:%x::1]:4000", i>>16, i&0xffff)
		rec := httptest.NewRecorder()
		h.srv.RequestEmailSignIn(rec, req, gen.RequestEmailSignInParams{})
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status %d", rec.Code)
		}
	}
	waitFor(t, func() bool { return len(e.inFlight) == 0 })
	if n := e.byClient.Len(); n != flood {
		t.Fatalf("the client limiter holds %d keys, want one per /64: %d", n, flood)
	}
	if n := e.byMember.Len(); n != 0 {
		t.Fatalf("the Member limiter holds %d keys after addresses no Member has", n)
	}
	if m, ok := fake.Next(100 * time.Millisecond); ok {
		t.Fatalf("sent %+v", m)
	}
	if countLinks(t, st) != links {
		t.Fatal("issued links for addresses no Member has")
	}
	// The cap of two is whole.
	for _, email := range []string{"bob@example.com", "carol@example.com"} {
		if s := askByEmail(t, h.ts, `{"email":"`+email+`"}`, nil); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
		if _, ok := fake.Next(5 * time.Second); !ok {
			t.Fatalf("no email to %s after the flood", email)
		}
	}
}

// A Member's address asked for from many clients is held to the Member's limit.
func TestEmailSignInHoldsAMemberToTheirLimitFromManyClients(t *testing.T) {
	fake := mail.NewFake()
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: fake, PublicURL: publicURL, ProxyHops: 1})
	email := "bob@example.com"
	got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
		client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	for i := range 20 {
		from := fmt.Sprintf("2001:db8:%x::1", i+1)
		if s := askByEmail(t, h.ts, `{"email":"BOB@example.com"}`, map[string]string{"X-Forwarded-For": from}); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
	}
	var n int
	for {
		if _, ok := fake.Next(time.Second); !ok {
			break
		}
		n++
	}
	if n != signInPerMember {
		t.Fatalf("sent %d emails to one Member asked for from 20 clients, want %d", n, signInPerMember)
	}
}

// Two IPv6 addresses in one /64 are one client, sharing a bucket; another /64 is another client.
func TestEmailSignInLimitsAnIPv6ClientByItsNetwork(t *testing.T) {
	fake := mail.NewFake()
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{Mail: fake, PublicURL: publicURL, ProxyHops: 1})
	email := "bob@example.com"
	got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
		client.CreateMemberBody{Name: "bob", Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	ask := func(from, email string) {
		t.Helper()
		if s := askByEmail(t, h.ts, `{"email":"`+email+`"}`, map[string]string{"X-Forwarded-For": from}); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
	}
	for i := range signInPerClient {
		ask("2001:db8:1:2::"+strconv.Itoa(i+1), "nobody"+strconv.Itoa(i)+"@example.com")
	}
	ask("2001:db8:1:2:ffff:ffff:ffff:ffff", email)
	if m, ok := fake.Next(time.Second); ok {
		t.Fatalf("another address in the same /64 got past its limit: %+v", m)
	}
	ask("2001:db8:1:3::1", email)
	if _, ok := fake.Next(5 * time.Second); !ok {
		t.Fatal("a client in another /64 was limited")
	}
}

// Past the cap on emails sent, across many Members each within their own limit, requests still
// answer 202, nothing is sent or issued, and the warning is logged once a minute; the cap
// refills over the hour.
func TestEmailSignInCapsEmailsSent(t *testing.T) {
	fake := mail.NewFake()
	clk := clock.NewFake(time.Now())
	st := storetest.Open(t, store.SQLite)
	var logs syncBuffer
	h := newHarnessWith(t, st, Options{Mail: fake, PublicURL: publicURL, Clock: clk, ProxyHops: 1, MailPerHour: 3,
		Log: slog.New(slog.NewTextHandler(&logs, nil))})
	names := []string{"bob", "carol", "dave", "erin", "fay", "gus"}
	for _, name := range names {
		email := name + "@example.com"
		got(h.admin.CreateMemberWithResponse(t.Context(), &client.CreateMemberParams{},
			client.CreateMemberBody{Name: name, Kind: client.Human, Email: (*openapi_types.Email)(&email)})).want(t, http.StatusCreated)
	}
	// Each from its own client, so only the cap on sending can stop them.
	ask := func(i int) {
		t.Helper()
		from := "198.51.100." + strconv.Itoa(i+1)
		if s := askByEmail(t, h.ts, `{"email":"`+names[i]+`@example.com"}`, map[string]string{"X-Forwarded-For": from}); s != http.StatusAccepted {
			t.Fatalf("status %d", s)
		}
	}
	for i := range 3 {
		ask(i)
		if _, ok := fake.Next(5 * time.Second); !ok {
			t.Fatalf("email %d within the cap was not sent", i+1)
		}
	}
	links := countLinks(t, st)
	for i := 3; i < len(names); i++ {
		ask(i)
	}
	if m, ok := fake.Next(time.Second); ok {
		t.Fatalf("sent past the cap: %+v", m)
	}
	if countLinks(t, st) != links {
		t.Fatal("issued a link past the cap")
	}
	if n := strings.Count(logs.String(), "sent its cap of emails"); n != 1 {
		t.Fatalf("the cap's warning was logged %d times, want once a minute", n)
	}
	// Three an hour refill one each twenty minutes.
	clk.Advance(20 * time.Minute)
	ask(3)
	if m, ok := fake.Next(5 * time.Second); !ok || m.To != "erin@example.com" {
		t.Fatalf("after twenty minutes: %+v, %v", m, ok)
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
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
		// Shorter than the hops: the client reached the server past a proxy and wrote it all.
		{"203.0.113.7:5000", []string{"6.6.6.6"}, 2, "203.0.113.7"},
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

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
