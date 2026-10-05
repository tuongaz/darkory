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
