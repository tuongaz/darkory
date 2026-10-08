package server

import (
	"net/http"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The Runner records a nudge through the generated client on both engines: 204 for the Session
// holding the Claim, again 204 for a retry under the same key, an entry with no actor, and
// refusals with their codes and statuses.
func TestRecordNudgeThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bob, bobID := h.member("bob", client.Agent, "WEB", "engineer")
		f := h.file(bob, client.FileTaskBody{Project: ptrStr("WEB"), Title: "Checkout", Breakdown: ptrBool(true)})
		cart := h.file(bob, client.FileTaskBody{Parent: &f.Task.Key, Title: "Cart page", Step: ptrStr("Build")})

		refused := func(status int, code client.ErrorCode, r result[*client.RecordNudgeResponse]) {
			t.Helper()
			res := r.res
			if r.err != nil {
				t.Fatal(r.err)
			}
			if res.StatusCode() != status || res.JSONDefault == nil || res.JSONDefault.Code != code {
				t.Fatalf("status %d %s, want %d %s", res.StatusCode(), res.Body, status, code)
			}
		}
		refused(http.StatusConflict, client.ErrorCodeNotHolder,
			got(bob.RecordNudgeWithResponse(ctx, cart.Task.Key, &client.RecordNudgeParams{}, client.RecordNudgeBody{Nudge: 1})))

		got(bob.ClaimTaskWithResponse(ctx, cart.Task.Key, &client.ClaimTaskParams{}, client.ClaimTaskBody{})).want(t, http.StatusOK)
		for range 2 {
			got(bob.RecordNudgeWithResponse(ctx, cart.Task.Key, &client.RecordNudgeParams{IdempotencyKey: key("n-1")}, client.RecordNudgeBody{Nudge: 1})).
				want(t, http.StatusNoContent)
		}
		refused(http.StatusBadRequest, client.ErrorCodeInvalid,
			got(bob.RecordNudgeWithResponse(ctx, cart.Task.Key, &client.RecordNudgeParams{}, client.RecordNudgeBody{Nudge: 3})))
		refused(http.StatusConflict, client.ErrorCodeNotHolder,
			got(ada.RecordNudgeWithResponse(ctx, cart.Task.Key, &client.RecordNudgeParams{}, client.RecordNudgeBody{Nudge: 1})))

		kinds := []client.ActivityKind{client.ActivityKindTaskNudged}
		page := got(ada.ListActivityWithResponse(ctx, &client.ListActivityParams{Kind: &kinds})).want(t, http.StatusOK).JSON200
		if len(page.Items) != 1 || page.Items[0].ActorID != nil || page.Items[0].SubjectID != cart.Task.ID ||
			page.Items[0].Payload["holder_id"] != bobID || page.Items[0].Payload["nudge"] != float64(1) {
			t.Fatalf("the nudges: %+v", page.Items)
		}
	})
}
