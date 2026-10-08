package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// signIn redeems a login link for member and returns the browser cookie it sets.
func (h *harness) signIn(t *testing.T, member string) *http.Cookie {
	t.Helper()
	link := got(h.admin.IssueLoginLinkWithResponse(t.Context(), member, &client.IssueLoginLinkParams{})).want(t, http.StatusCreated).JSON201
	// The link names the public URL; the test server is reached at its own address.
	res := redeem(t, h.ts, link.URL[strings.Index(link.URL, "/v1/"):])
	for _, ck := range res.Cookies() {
		if ck.Name == "darkory_session" {
			return ck
		}
	}
	t.Fatalf("redeeming the link set no cookie: %d", res.StatusCode)
	return nil
}

// browserRequest sends what a browser holding cookie would: the JSON body, and headers.
func (h *harness) browserRequest(t *testing.T, cookie *http.Cookie, method, path, body string, headers map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, h.ts.URL+path, strings.NewReader(body))
	req.AddCookie(cookie)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// A write signed in by the browser cookie must come from the Install's own pages: a page on
// another origin — a sibling port on the same host included, which SameSite=Lax lets through —
// cannot make one. Bearer requests carry no ambient credential and need no Origin.
func TestCookieWritesMustComeFromThisOrigin(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarnessWith(t, st, Options{PublicURL: "https://dk.example.com"})
		cookie := h.signIn(t, "ada")
		port := h.ts.URL[strings.LastIndex(h.ts.URL, ":")+1:]
		cases := []struct {
			name    string
			headers map[string]string
			want    int
		}{
			{"another origin", map[string]string{"Origin": "https://evil.example"}, http.StatusForbidden},
			{"a sibling port on the same host", map[string]string{"Origin": "http://127.0.0.1:1"}, http.StatusForbidden},
			{"another scheme", map[string]string{"Origin": "https://127.0.0.1:" + port}, http.StatusForbidden},
			{"no Origin and no Referer", nil, http.StatusForbidden},
			{"the opaque Origin null", map[string]string{"Origin": "null"}, http.StatusForbidden},
			{"a Referer from another origin", map[string]string{"Referer": "https://evil.example/page"}, http.StatusForbidden},
			{"this origin, but Sec-Fetch-Site says same-site", map[string]string{"Origin": h.ts.URL, "Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
			{"this origin, but Sec-Fetch-Site says cross-site", map[string]string{"Origin": h.ts.URL, "Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
			{"this origin", map[string]string{"Origin": h.ts.URL, "Sec-Fetch-Site": "same-origin"}, http.StatusCreated},
			{"a page of this origin as Referer", map[string]string{"Referer": h.ts.URL + "/teams"}, http.StatusCreated},
			{"the configured public URL", map[string]string{"Origin": "https://DK.example.com:443"}, http.StatusCreated},
		}
		for i, tc := range cases {
			key := "T" + string(rune('A'+i))
			res := h.browserRequest(t, cookie, http.MethodPost, "/v1/projects", `{"key":"`+key+`","name":"`+key+`"}`, tc.headers)
			res.Body.Close()
			if res.StatusCode != tc.want {
				t.Errorf("%s: status %d, want %d", tc.name, res.StatusCode, tc.want)
			}
		}
		// A refused write wrote nothing.
		projects := got(h.admin.ListProjectsWithResponse(t.Context())).want(t, http.StatusOK).JSON200
		if len(projects.Items) != 3 {
			t.Fatalf("%d Projects after three allowed writes", len(projects.Items))
		}
		// Reads are not writes: a page elsewhere still cannot read the reply, and reading changes nothing.
		res := h.browserRequest(t, cookie, http.MethodGet, "/v1/me", "", map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("a cookie read with another Origin: %d", res.StatusCode)
		}
		// The refusal is 403 forbidden with the Error body.
		assertError(t, h.browserRequest(t, cookie, http.MethodPost, "/v1/logout", "", nil), http.StatusForbidden, "forbidden")
		// A bearer write sends no Origin, and needs none.
		got(h.admin.CreateProjectWithResponse(t.Context(), &client.CreateProjectParams{}, client.CreateProjectBody{Key: "BEAR", Name: "Bearer"})).want(t, http.StatusCreated)
	})
}

// A JSON operation takes its body only as application/json, so a form a browser posts as
// text/plain is refused.
func TestJSONBodiesNeedTheJSONContentType(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		post := func(contentType, key string) *http.Response {
			req, _ := http.NewRequest(http.MethodPost, h.ts.URL+"/v1/projects", strings.NewReader(`{"key":"`+key+`","name":"`+key+`"}`))
			req.Header.Set("Authorization", "Bearer "+h.adminSecret)
			req.Header.Set("Darkory-Session", "ada-cli")
			if contentType != "" {
				req.Header.Set("Content-Type", contentType)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			return res
		}
		for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""} {
			assertError(t, post(ct, "WEB"), http.StatusBadRequest, "invalid")
		}
		res := post("application/json; charset=utf-8", "WEB")
		res.Body.Close()
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("application/json with a charset: %d", res.StatusCode)
		}
	})
}

// The Activity stream checks its credential again before it sends anything: once the token is
// revoked or the Session closed, it ends without delivering what came after.
func TestStreamEndsWhenItsCredentialEnds(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		for _, end := range []string{"revoke the token", "close the Session", "keep-alive after a close"} {
			name := "watcher" + strings.ReplaceAll(strings.Fields(end)[0], "-", "")
			_, _ = h.agent(name, nil)
			tokens := got(h.admin.ListTokensWithResponse(ctx, name)).want(t, http.StatusOK).JSON200
			secret := h.secretOf(t, name)
			before := got(h.admin.ListActivityWithResponse(ctx, &client.ListActivityParams{})).want(t, http.StatusOK).JSON200.LastSeq
			stream := h.openStreamAs(t, secret, name+"-1", "0")
			if ids := stream.events(t, int(before)); ids[len(ids)-1] != before {
				t.Fatalf("%s: the stream began with %v", end, ids)
			}
			switch end {
			case "revoke the token":
				got(h.admin.RevokeTokenWithResponse(ctx, tokens.Items[0].ID, &client.RevokeTokenParams{})).want(t, http.StatusOK)
				got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "AFTER", Name: "After"})).want(t, http.StatusCreated)
			case "close the Session":
				got(h.admin.CloseSessionWithResponse(ctx, name+"-1", &client.CloseSessionParams{Member: &name})).want(t, http.StatusOK)
				got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "LATER", Name: "Later"})).want(t, http.StatusCreated)
			case "keep-alive after a close":
				// Closed behind the stream's back, with no write to wake it: the keep-alive tick checks too.
				if err := st.WriteBatchNoSeq(ctx, store.Stmt{SQL: `UPDATE sessions SET closed_at = 1 WHERE chosen_id = $1`, Args: []any{name + "-1"}}); err != nil {
					t.Fatal(err)
				}
			}
			if ids := stream.rest(t); len(ids) > 0 {
				t.Fatalf("%s: the stream sent %v after its credential ended", end, ids)
			}
		}
	})
}
