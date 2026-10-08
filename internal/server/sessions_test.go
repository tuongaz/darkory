package server

import (
	"net/http"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A token Session nothing comes through for the Install's idle limit is listed as ended, with when
// it ended, and its id starts a new Session; each page counts both.
func TestIdleTokenSessionsListAsEnded(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		fake := clock.NewFake(time.Now())
		h := newHarnessWith(t, st, Options{Clock: fake})
		ctx := t.Context()
		got(h.admin.CreateProjectWithResponse(ctx, &client.CreateProjectParams{}, client.CreateProjectBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bob, _ := h.agent("bob", nil)
		got(bob.GetMeWithResponse(ctx)).want(t, http.StatusOK)
		seen := fake.Now()

		fake.Advance(16 * time.Minute)
		open := got(h.admin.ListSessionsWithResponse(ctx, "bob", &client.ListSessionsParams{})).want(t, http.StatusOK).JSON200
		if len(open.Items) != 0 || open.Open != 0 || open.Ended != 1 {
			t.Fatalf("open after the idle limit: %+v", open)
		}
		ended := client.SessionEnded
		list := got(h.admin.ListSessionsWithResponse(ctx, "bob", &client.ListSessionsParams{State: &ended})).want(t, http.StatusOK).JSON200
		if len(list.Items) != 1 || list.Items[0].ID != "bob-1" || list.Items[0].EndedAt == nil ||
			!list.Items[0].EndedAt.Equal(seen.Add(15*time.Minute).Truncate(time.Millisecond)) || list.Items[0].ClosedAt != nil {
			t.Fatalf("ended: %+v", list.Items)
		}

		got(bob.GetMeWithResponse(ctx)).want(t, http.StatusOK)
		open = got(h.admin.ListSessionsWithResponse(ctx, "bob", &client.ListSessionsParams{})).want(t, http.StatusOK).JSON200
		if len(open.Items) != 1 || open.Items[0].ID != "bob-1" || open.Items[0].EndedAt != nil || open.Open != 1 || open.Ended != 1 {
			t.Fatalf("after the id came back: %+v", open)
		}
		bad := client.SessionState("closed")
		got(h.admin.ListSessionsWithResponse(ctx, "bob", &client.ListSessionsParams{State: &bad})).want(t, http.StatusBadRequest)
	})
}
