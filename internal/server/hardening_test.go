package server

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// webAndBuild creates the Team WEB and the Skill build, which agent needs.
func (h *harness) webAndBuild() {
	ctx := h.t.Context()
	got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(h.t, http.StatusCreated)
	got(h.admin.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: "build", Kind: client.Generic, Body: "Build it."})).want(h.t, http.StatusCreated)
}

// slowBody opens a connection, sends a request's headers announcing a 100-byte body, then one
// byte of it and no more, and returns what the server answered and how long it took to end the
// connection. It gives up after five seconds.
func slowBody(t *testing.T, h *harness, method, path string, headers map[string]string) (string, time.Duration) {
	t.Helper()
	conn, err := net.Dial("tcp", h.ts.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var req strings.Builder
	fmt.Fprintf(&req, "%s %s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\n",
		method, path, h.ts.Listener.Addr())
	for k, v := range headers {
		fmt.Fprintf(&req, "%s: %s\r\n", k, v)
	}
	req.WriteString("\r\n{")
	start := time.Now()
	if _, err := io.WriteString(conn, req.String()); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(start.Add(5 * time.Second))
	var status string
	if line, err := bufio.NewReader(io.TeeReader(conn, io.Discard)).ReadString('\n'); err == nil {
		status = strings.TrimSpace(line)
	}
	for {
		// Read until the server closes the connection, or the deadline above.
		if _, err := conn.Read(make([]byte, 512)); err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				return status, 5 * time.Second
			}
			return status, time.Since(start)
		}
	}
}

// A request body that trickles in is cut off after the body read timeout, whether the operation
// needs no credential, needs one and has it, or is refused for want of one (security review M2).
func TestSlowBodiesAreCutOff(t *testing.T) {
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{BodyReadTimeout: 300 * time.Millisecond})
	bearer := map[string]string{"Authorization": "Bearer " + h.adminSecret, "Darkory-Session": "ada-slow"}
	for _, c := range []struct {
		name, method, path string
		headers            map[string]string
		status             string
	}{
		{"email sign-in, no credential", http.MethodPost, "/v1/sign-in/email", nil, "400"},
		{"a JSON write", http.MethodPost, "/v1/teams", bearer, "400"},
		{"refused for want of a credential", http.MethodPost, "/v1/teams", nil, "401"},
		{"Evidence", http.MethodPost, "/v1/features/NOPE-1/evidence?filename=a.txt", bearer, "404"},
	} {
		status, took := slowBody(t, h, c.method, c.path, c.headers)
		if took > 3*time.Second || !strings.Contains(status, c.status) {
			t.Errorf("%s: answered %q and held the connection %v", c.name, status, took)
		}
	}
}

// Requests with no body set no deadline, so the Activity stream and a waiting `next`, which has a
// small body, outlive the body read timeout.
func TestLongRequestsOutliveTheBodyTimeout(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarnessWith(t, st, Options{BodyReadTimeout: 200 * time.Millisecond})
		ctx := t.Context()
		h.webAndBuild()
		stream := h.openStream(t, "")
		defer stream.close()
		agent, _ := h.agent("builder", nil, "build")
		start := time.Now()
		got(agent.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(1)})).want(t, http.StatusNoContent)
		if took := time.Since(start); took < time.Second {
			t.Fatalf("next answered after %v", took)
		}
		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "API", Name: "API"})).want(t, http.StatusCreated)
		// The stream sent the agent's creation entries meanwhile; read up to the new Team.
		for {
			res := stream.events(t, 1)
			page := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200
			if res[0] == page.LastSeq {
				break
			}
		}
	})
}

// Every response carries the security headers: no framing, no sniffing, no Referer to another
// origin, and a Content-Security-Policy for the web app or for /v1 (security review M3).
func TestSecurityHeaders(t *testing.T) {
	h := newHarness(t, storetest.Open(t, store.SQLite))
	for path, csp := range map[string]string{
		"/":                 appCSP,
		"/admin/members":    appCSP,
		"/missing.js":       appCSP,
		"/v1/health":        apiCSP,
		"/v1/me":            apiCSP,
		"/v1/no-such-thing": apiCSP,
	} {
		res, err := http.Get(h.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		hd := res.Header
		if hd.Get("X-Frame-Options") != "DENY" || hd.Get("X-Content-Type-Options") != "nosniff" ||
			hd.Get("Referrer-Policy") != "same-origin" || hd.Get("Content-Security-Policy") != csp {
			t.Errorf("%s (%d): %v", path, res.StatusCode, hd)
		}
	}
	if !strings.Contains(appCSP, "frame-ancestors 'none'") || !strings.Contains(apiCSP, "frame-ancestors 'none'") {
		t.Fatal("a policy lets the Install be framed")
	}
}

// An Idempotency-Key is 1 to 255 printable ASCII characters; anything else is refused before the
// operation runs, so nothing is stored under it (security review L3).
func TestIdempotencyKeyIsBounded(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		send := func(path, key, body string, bearer bool) int {
			req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, h.ts.URL+path, strings.NewReader(body))
			if bearer {
				req.Header.Set("Authorization", "Bearer "+h.adminSecret)
				req.Header.Set("Darkory-Session", "ada-keys")
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", key)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			return res.StatusCode
		}
		for i, bad := range []string{strings.Repeat("k", 256), strings.Repeat("k", 500_000), "with space", "tab\tkey", "é"} {
			if code := send("/v1/teams", bad, fmt.Sprintf(`{"key":"T%c","name":"t%d"}`, 'A'+i, i), true); code != http.StatusBadRequest {
				t.Errorf("key %.20q: %d", bad, code)
			}
		}
		if code := send("/v1/sign-in/email", strings.Repeat("k", 256), `{"email":"a@example.com"}`, false); code != http.StatusBadRequest {
			t.Errorf("a long key on email sign-in: %d", code)
		}
		var n int
		if err := st.QueryRow(t.Context(), `SELECT COUNT(*) FROM idempotency_keys`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%d keys stored, %v", n, err)
		}
		if code := send("/v1/teams", strings.Repeat("k", 255), `{"key":"OK","name":"ok"}`, true); code != http.StatusCreated {
			t.Fatalf("a 255-character key: %d", code)
		}
	})
}

// An Evidence filename may not hold format characters such as a bidi override, which make a
// name read other than it is; a name that is not ASCII downloads under filename* (security
// review L5).
func TestEvidenceFilenamesShowAsTheyAre(t *testing.T) {
	h := newHarness(t, storetest.Open(t, store.SQLite))
	ctx := t.Context()
	h.webAndBuild()
	builder, _ := h.agent("builder", nil, "build")
	f := got(builder.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Docs"})).want(t, http.StatusCreated).JSON201
	task := got(builder.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Write", Skill: ptrStr("build")})).want(t, http.StatusCreated).JSON201.Task
	for _, bad := range []string{"report‮fdp.exe", "a⁦b.txt", "zero​width.txt", "line sep.txt"} {
		if res := attach(t, builder, task.Key, bad, "text/plain", []byte("x"), nil); res.StatusCode() != http.StatusBadRequest {
			t.Errorf("filename %q: %d", bad, res.StatusCode())
		}
	}
	ev := attach(t, builder, task.Key, `résumé "final".pdf`, "application/pdf", []byte("%PDF"), nil).JSON201
	dl := got(builder.DownloadEvidenceWithResponse(ctx, ev.ID)).want(t, http.StatusOK)
	want := `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`
	if got := dl.HTTPResponse.Header.Get("Content-Disposition"); got != want || !bytes.Equal(dl.Body, []byte("%PDF")) {
		t.Fatalf("Content-Disposition %s", got)
	}
	if csp := dl.HTTPResponse.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("download CSP %q", csp)
	}
}

// Opening a login link signs nobody in: it shows a page naming whom it signs in as, and only the
// page's own button, posting from this Install's origin, redeems it. A page elsewhere sending a
// browser to mallory's link — the review's login CSRF — leaves the browser signed in as before
// (security review L1).
func TestLoginLinkSignsInOnlyFromItsPage(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		got(h.admin.CreateMemberWithResponse(ctx, &client.CreateMemberParams{}, client.CreateMemberBody{Name: "<b>mallory</b>", Kind: client.Human})).want(t, http.StatusCreated)
		link := got(h.admin.IssueLoginLinkWithResponse(ctx, "<b>mallory</b>", &client.IssueLoginLinkParams{})).want(t, http.StatusCreated).JSON201
		path := strings.TrimPrefix(link.URL, h.ts.URL)

		res, err := http.Get(link.URL)
		if err != nil {
			t.Fatal(err)
		}
		page, _ := io.ReadAll(res.Body)
		res.Body.Close()
		hd := res.Header
		if res.StatusCode != http.StatusOK || len(res.Cookies()) != 0 || !strings.Contains(string(page), "Sign in as &lt;b&gt;mallory&lt;/b&gt;") ||
			!strings.Contains(string(page), "Acme") || !strings.Contains(string(page), `<form method="post">`) ||
			hd.Get("Content-Security-Policy") != loginCSP || hd.Get("X-Frame-Options") != "DENY" || hd.Get("Cache-Control") != "no-store" {
			t.Fatalf("the sign-in page: %d %v\n%s", res.StatusCode, hd, page)
		}

		ada := h.signIn(t, "ada")
		post := func(headers map[string]string) *http.Response {
			req, _ := http.NewRequest(http.MethodPost, link.URL, nil)
			req.AddCookie(ada)
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			res, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			return res
		}
		for name, headers := range map[string]map[string]string{
			"a sibling port":       {"Origin": "http://127.0.0.1:18080", "Sec-Fetch-Site": "same-site"},
			"another site":         {"Origin": "http://localhost:18080", "Sec-Fetch-Site": "cross-site"},
			"a cross-site referer": {"Referer": "http://localhost:18080/attack.html"},
			"no origin at all":     nil,
		} {
			if res := post(headers); res.StatusCode != http.StatusForbidden || len(res.Cookies()) != 0 {
				t.Errorf("%s: %d %v", name, res.StatusCode, res.Cookies())
			}
		}
		me := h.browserRequest(t, ada, http.MethodGet, "/v1/me", "", nil)
		var body client.Me
		decode(t, me, &body)
		if body.Member.Name != "ada" {
			t.Fatalf("the browser is signed in as %q", body.Member.Name)
		}

		// From the page itself it signs in, and the Session of the cookie the browser held ends.
		res = redeem(t, h.ts, path, ada)
		if res.StatusCode != http.StatusSeeOther || len(res.Cookies()) != 1 {
			t.Fatalf("from the page: %d %v", res.StatusCode, res.Cookies())
		}
		if me := h.browserRequest(t, ada, http.MethodGet, "/v1/me", "", nil); me.StatusCode != http.StatusUnauthorized {
			t.Fatalf("the replaced cookie answers %d", me.StatusCode)
		}
	})
}

// A browser Session's cookie stops working on the server after the Session's lifetime, though
// the browser would still send it; the review's proof found it working a year on (security
// review M4). An admin lists a Member's Sessions and deactivates the Member, which ends their
// Activity stream at once; the Member cannot do either to others.
func TestBrowserSessionsEndAndMembersDeactivate(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		fake := clock.NewFake(time.Now())
		h := newHarnessWith(t, st, Options{Clock: fake})
		ctx := t.Context()
		ck := h.signIn(t, "ada")
		fake.Advance(365 * 24 * time.Hour)
		if res := h.browserRequest(t, ck, http.MethodGet, "/v1/me", "", nil); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("a year later the cookie answers %d", res.StatusCode)
		}

		got(h.admin.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bob, _ := h.agent("bob", nil)
		got(bob.GetMeWithResponse(ctx)).want(t, http.StatusOK)
		sessions := got(h.admin.ListSessionsWithResponse(ctx, "bob", &client.ListSessionsParams{})).want(t, http.StatusOK).JSON200
		if len(sessions.Items) != 1 || sessions.Items[0].ID != "bob-1" || sessions.Items[0].Kind != client.SessionKindToken {
			t.Fatalf("bob's Sessions %+v", sessions.Items)
		}
		got(bob.ListSessionsWithResponse(ctx, "ada", &client.ListSessionsParams{})).want(t, http.StatusForbidden)
		got(bob.DeactivateMemberWithResponse(ctx, "ada", &client.DeactivateMemberParams{})).want(t, http.StatusForbidden)

		stream := h.openStreamAs(t, h.secrets["bob"], "bob-stream", "")
		m := got(h.admin.DeactivateMemberWithResponse(ctx, "bob", &client.DeactivateMemberParams{})).want(t, http.StatusOK).JSON200
		if m.DeactivatedAt == nil {
			t.Fatalf("deactivated %+v", m)
		}
		if ids := stream.rest(t); len(ids) != 0 {
			t.Fatalf("the stream sent %v after the deactivation", ids)
		}
		got(bob.GetMeWithResponse(ctx)).want(t, http.StatusUnauthorized)
		got(h.admin.IssueTokenWithResponse(ctx, "bob", &client.IssueTokenParams{}, client.IssueTokenBody{Name: "again"})).want(t, http.StatusConflict)
		got(h.admin.ReactivateMemberWithResponse(ctx, "bob", &client.ReactivateMemberParams{})).want(t, http.StatusOK)
		got(h.admin.IssueTokenWithResponse(ctx, "bob", &client.IssueTokenParams{}, client.IssueTokenBody{Name: "again"})).want(t, http.StatusCreated)
	})
}

// builder0 is the key the builder's long requests are counted under.
func builder0(t *testing.T, h *harness) string {
	me := got(h.client(h.secrets["builder"], "builder-1").GetMeWithResponse(t.Context())).want(t, http.StatusOK).JSON200
	return me.Organisation.ID + "/" + me.Member.ID
}

// A Member may hold only so many Activity streams and waiting `next` calls at once; one more is
// refused with too_many_requests, and ending one makes room (security review L4).
func TestLongRequestsAreCappedPerMember(t *testing.T) {
	h := newHarnessWith(t, storetest.Open(t, store.SQLite), Options{MaxWaiting: 2})
	ctx := t.Context()
	h.webAndBuild()
	streams := []*sseStream{h.openStream(t, ""), h.openStreamAs(t, h.adminSecret, "ada-other", "")}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.ts.URL+"/v1/activity/stream", nil)
	req.Header.Set("Authorization", "Bearer "+h.adminSecret)
	req.Header.Set("Darkory-Session", "ada-third")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	assertError(t, res, http.StatusTooManyRequests, "too_many_requests")
	// Another Member is not counted against ada.
	builder, _ := h.agent("builder", nil, "build")
	h.openStreamAs(t, h.secrets["builder"], "builder-stream", "").close()
	streams[0].close()
	waitFor(t, func() bool {
		s, err := http.DefaultClient.Do(req.Clone(ctx))
		if err != nil {
			t.Fatal(err)
		}
		s.Body.Close()
		return s.StatusCode == http.StatusOK
	})
	streams[1].close()

	key := builder0(t, h)
	waiting := make(chan int, 2)
	for range 2 {
		go func() {
			res, err := builder.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(2)})
			if err != nil {
				waiting <- 0
				return
			}
			waiting <- res.StatusCode()
		}()
	}
	waitFor(t, func() bool {
		h.srv.nexts.mu.Lock()
		defer h.srv.nexts.mu.Unlock()
		return h.srv.nexts.open[key] == 2
	})
	got(builder.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(0)})).want(t, http.StatusTooManyRequests)
	for range 2 {
		if code := <-waiting; code != http.StatusNoContent {
			t.Fatalf("a waiting next answered %d", code)
		}
	}
	got(builder.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(0)})).want(t, http.StatusNoContent)
}

// The web app's static files are served without listing a directory (security review, Info).
func TestNoDirectoryListing(t *testing.T) {
	h := newHarness(t, storetest.Open(t, store.SQLite))
	for _, path := range []string{"/assets/", "/assets"} {
		res, err := http.Get(h.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if strings.Contains(string(body), "<pre>") || (res.StatusCode != http.StatusNotFound && !strings.Contains(string(body), "<!doctype html>")) {
			t.Errorf("%s: %d\n%s", path, res.StatusCode, body)
		}
	}
}

// Deactivating a Member ends at once everything they have open — an Activity stream and a waiting
// `next` within a keep-alive tick (100 ms here), their cookie at its next request — and
// reactivating them revives none of it: the old token, cookie and login link stay refused.
func TestDeactivationEndsEverythingAndReactivationRevivesNothing(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		h.webAndBuild()
		bob, _ := h.agent("bob", nil, "build")
		cookie := h.signIn(t, "bob")
		link := got(h.admin.IssueLoginLinkWithResponse(ctx, "bob", &client.IssueLoginLinkParams{})).want(t, http.StatusCreated).JSON201
		key := func() string {
			me := got(bob.GetMeWithResponse(ctx)).want(t, http.StatusOK).JSON200
			return me.Organisation.ID + "/" + me.Member.ID
		}()
		stream := h.openStreamAs(t, h.secrets["bob"], "bob-stream", "")
		waiting := make(chan int, 1)
		go func() {
			res, err := bob.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptrInt(30)})
			if err != nil {
				waiting <- 0
				return
			}
			waiting <- res.StatusCode()
		}()
		waitFor(t, func() bool {
			h.srv.nexts.mu.Lock()
			defer h.srv.nexts.mu.Unlock()
			return h.srv.nexts.open[key] == 1
		})

		start := time.Now()
		got(h.admin.DeactivateMemberWithResponse(ctx, "bob", &client.DeactivateMemberParams{})).want(t, http.StatusOK)
		select {
		case code := <-waiting:
			if code != http.StatusUnauthorized {
				t.Fatalf("the waiting next answered %d", code)
			}
		case <-time.After(time.Second):
			t.Fatal("the waiting next is still waiting a second after the deactivation")
		}
		if ids := stream.rest(t); len(ids) != 0 {
			t.Fatalf("the stream sent %v after the deactivation", ids)
		}
		if took := time.Since(start); took > time.Second {
			t.Fatalf("the stream and next ended %v after the deactivation", took)
		}
		if res := h.browserRequest(t, cookie, http.MethodGet, "/v1/me", "", nil); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("the cookie after deactivation answers %d", res.StatusCode)
		}

		got(h.admin.ReactivateMemberWithResponse(ctx, "bob", &client.ReactivateMemberParams{})).want(t, http.StatusOK)
		got(bob.GetMeWithResponse(ctx)).want(t, http.StatusUnauthorized)
		if res := h.browserRequest(t, cookie, http.MethodGet, "/v1/me", "", nil); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("the cookie after reactivation answers %d", res.StatusCode)
		}
		if res := redeem(t, h.ts, strings.TrimPrefix(link.URL, h.ts.URL)); res.StatusCode != http.StatusNotFound || len(res.Cookies()) != 0 {
			t.Fatalf("the link issued before the deactivation: %d %v", res.StatusCode, res.Cookies())
		}
		// A new token works.
		tok := got(h.admin.IssueTokenWithResponse(ctx, "bob", &client.IssueTokenParams{}, client.IssueTokenBody{Name: "again"})).want(t, http.StatusCreated).JSON201
		got(h.client(tok.Secret, "bob-again").GetMeWithResponse(ctx)).want(t, http.StatusOK)
	})
}
