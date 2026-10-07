package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server/gen"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// component percent-encodes one value of a filter token as a browser's encodeURIComponent does.
func component(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "+", "%20") }

// getAs sends a GET with the admin's token and Session.
func (h *harness) getAs(path string) *http.Response {
	h.t.Helper()
	req, err := http.NewRequestWithContext(h.t.Context(), http.MethodGet, h.ts.URL+path, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+h.adminSecret)
	req.Header.Set("Darkory-Session", "ada-cli")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return res
}

// The filter parameter on the wire, on both engines: repeated, its values percent-encoded inside
// the token and the token query-encoded again, through the generated client and by hand; a bad
// token answers 400 invalid quoting it.
func TestFilterParameter(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.CreateSkillWithResponse(ctx, &client.CreateSkillParams{}, client.CreateSkillBody{Name: "build", Kind: client.Generic, Body: "b"})).
			want(t, http.StatusCreated)
		bob, bobID := h.member("bob", client.Agent, "WEB", "build")
		f := got(bob.FileFeatureWithResponse(ctx, &client.FileFeatureParams{}, client.FileFeatureBody{Team: "WEB", Title: "Checkout"})).
			want(t, http.StatusCreated).JSON201
		cart := got(bob.FileTaskWithResponse(ctx, &client.FileTaskParams{}, client.FileTaskBody{Feature: &f.Feature.Key, Title: "Cart page",
			Description: ptrStr("Totals, then tax: 10% + fees"), Skill: ptrStr("build")})).want(t, http.StatusCreated).JSON201
		got(bob.ClaimTaskWithResponse(ctx, cart.Task.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{ModelLabel: ptrStr("opus, fast: +1")})).
			want(t, http.StatusOK)

		listed := func(filters ...string) []string {
			t.Helper()
			res := got(ada.ListTasksWithResponse(ctx, &client.ListTasksParams{Filter: &filters})).want(t, http.StatusOK)
			var ks []string
			for _, tk := range res.JSON200.Items {
				ks = append(ks, tk.Key)
			}
			return ks
		}
		later := time.Now().Add(time.Hour).In(time.FixedZone("AEDT", 11*3600)).Format(time.RFC3339)
		for _, c := range []struct {
			filters []string
			want    string
		}{
			{[]string{"model:is:" + component("opus, fast: +1")}, "WEB-3"},
			{[]string{"holder:is:" + bobID, "q:contains:" + component("tax: 10% + f")}, "WEB-3"},
			{[]string{"holder:is:none"}, "WEB-2"},
			{[]string{"filed_at:before:" + component(later), "kind:is:breakdown"}, "WEB-2"},
			{[]string{"filed_at:after:" + component(later)}, ""},
		} {
			if ks := strings.Join(listed(c.filters...), " "); ks != c.want {
				t.Errorf("%q: %s, want %s", c.filters, ks, c.want)
			}
		}

		// By hand: two filter parameters, each token query-encoded once more.
		res := h.getAs("/v1/tasks?filter=" + url.QueryEscape("q:contains:"+component("10%")) + "&filter=" +
			url.QueryEscape("filed_at:lte:"+component(later)) + "&feature=WEB-1")
		var page gen.TaskList
		decode(t, res, &page)
		if res.StatusCode != http.StatusOK || len(page.Items) != 1 || page.Items[0].Key != "WEB-3" {
			t.Fatalf("by hand: %d %+v", res.StatusCode, page)
		}

		// An offset's + sent bare is a space once the query is decoded, which no time has.
		for _, raw := range []string{
			"filter=filed_at:before:" + later[:19] + "+11:00",
			"filter=" + url.QueryEscape("status:is:Todo"),
			"filter=" + url.QueryEscape("holder:is:none") + "&filter=" + url.QueryEscape("blocked:is:maybe"),
		} {
			res := h.getAs("/v1/tasks?" + raw)
			var body gen.Error
			decode(t, res, &body)
			if res.StatusCode != http.StatusBadRequest || body.Code != gen.ErrorCodeInvalid || !strings.Contains(body.Message, `filter "`) {
				t.Errorf("%s: %d %+v", raw, res.StatusCode, body)
			}
		}
		res = h.getAs("/v1/features?filter=" + url.QueryEscape("kind:is:work"))
		assertError(t, res, http.StatusBadRequest, gen.ErrorCodeInvalid)

		features := got(ada.ListFeaturesWithResponse(ctx, &client.ListFeaturesParams{Filter: &[]string{"state:is:open", "q:contains:check"}})).
			want(t, http.StatusOK).JSON200.Items
		if len(features) != 1 || features[0].Key != "WEB-1" {
			b, _ := json.Marshal(features)
			t.Fatalf("features: %s", b)
		}
	})
}
