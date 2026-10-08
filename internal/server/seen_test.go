package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A Member's mark on a Project through the generated client on both engines: null fields until
// set, set under an Idempotency-Key and answered the same by a retry, kept when a lower seq comes,
// and refused with its codes and statuses.
func TestProjectSeenThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		got(ada.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "OPS", Name: "Ops"})).want(t, http.StatusCreated)
		bob, _ := h.member("bob", client.Human, "WEB")
		cat, _ := h.member("cat", client.Human, "OPS")
		newest := got(bob.ListActivityWithResponse(ctx, &client.ListActivityParams{Before: ptrInt64(9007199254740991)})).
			want(t, http.StatusOK).JSON200.LastSeq

		none := got(bob.GetProjectSeenWithResponse(ctx, "WEB")).want(t, http.StatusOK)
		if m := none.JSON200; m.Seq != nil || m.At != nil || !strings.Contains(string(none.Body), `"seq":null`) || !strings.Contains(string(none.Body), `"at":null`) {
			t.Fatalf("before any is set: %q", none.Body)
		}

		first := got(bob.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{IdempotencyKey: key("s-1")},
			client.SetProjectSeenBody{Seq: newest - 1})).want(t, http.StatusOK)
		if m := first.JSON200; m.Seq == nil || *m.Seq != newest-1 || m.At == nil {
			t.Fatalf("set: %s", first.Body)
		}
		got(bob.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{}, client.SetProjectSeenBody{Seq: newest})).want(t, http.StatusOK)
		again := got(bob.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{IdempotencyKey: key("s-1")},
			client.SetProjectSeenBody{Seq: newest - 1})).want(t, http.StatusOK)
		if string(again.Body) != string(first.Body) {
			t.Fatalf("the retry: %s, first %s", again.Body, first.Body)
		}
		// Behind the mark: the mark as kept comes back.
		kept := got(bob.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{}, client.SetProjectSeenBody{Seq: 1})).
			want(t, http.StatusOK).JSON200
		if kept.Seq == nil || *kept.Seq != newest {
			t.Fatalf("a lower seq moved the mark to %v", kept.Seq)
		}
		if m := got(bob.GetProjectSeenWithResponse(ctx, "WEB")).want(t, http.StatusOK).JSON200; m.Seq == nil || *m.Seq != newest {
			t.Fatalf("read back %v", m.Seq)
		}

		refused := func(status int, code client.ErrorCode, res interface{ StatusCode() int }, def *client.Error) {
			t.Helper()
			if res.StatusCode() != status || def == nil || def.Code != code {
				t.Fatalf("status %d %+v, want %d %s", res.StatusCode(), def, status, code)
			}
		}
		res, err := bob.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{}, client.SetProjectSeenBody{Seq: newest + 1})
		got(res, err)
		refused(http.StatusBadRequest, client.ErrorCodeInvalid, res, res.JSONDefault)
		res, err = cat.SetProjectSeenWithResponse(ctx, "WEB", &client.SetProjectSeenParams{}, client.SetProjectSeenBody{Seq: 1})
		got(res, err)
		refused(http.StatusForbidden, client.ErrorCodeForbidden, res, res.JSONDefault)
		get, err := cat.GetProjectSeenWithResponse(ctx, "WEB")
		got(get, err)
		refused(http.StatusForbidden, client.ErrorCodeForbidden, get, get.JSONDefault)
		get, err = bob.GetProjectSeenWithResponse(ctx, "NOPE")
		got(get, err)
		refused(http.StatusNotFound, client.ErrorCodeNotFound, get, get.JSONDefault)
	})
}

func ptrInt64(n int64) *int64 { return &n }
