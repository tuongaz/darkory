package server

import (
	"net/http"
	"slices"
	"testing"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Views through the generated client on both engines: saved under an Idempotency-Key and saved
// again by a retry with the same answer, listed by list and Team, changed, refused with their
// codes and statuses, another Member's not found, and deleted.
func TestViewsThroughTheClient(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		h := newHarness(t, st)
		ctx := t.Context()
		ada := h.admin
		got(ada.CreateTeamWithResponse(ctx, &client.CreateTeamParams{}, client.CreateTeamBody{Key: "WEB", Name: "Web"})).want(t, http.StatusCreated)
		bob, _ := h.member("bob", client.Human, "WEB")

		body := client.CreateViewBody{Entity: client.ViewEntityTasks, Team: ptrStr("WEB"), Name: "Unheld",
			Filters: &[]string{"holder:is:none", "filed_at:last:7d"}, Sort: ptrStr("rank"), Display: &map[string]any{"layout": "board"}}
		first := got(bob.CreateViewWithResponse(ctx, &client.CreateViewParams{IdempotencyKey: key("v-1")}, body)).want(t, http.StatusCreated)
		again := got(bob.CreateViewWithResponse(ctx, &client.CreateViewParams{IdempotencyKey: key("v-1")}, body)).want(t, http.StatusCreated)
		v := first.JSON201
		if again.JSON201.ID != v.ID || string(again.Body) != string(first.Body) {
			t.Fatalf("the retry: %s, first %s", again.Body, first.Body)
		}
		if v.Entity != client.ViewEntityTasks || v.TeamID == nil || v.Name != "Unheld" || !slices.Equal(v.Filters, []string{"holder:is:none", "filed_at:last:7d"}) ||
			*v.Sort != "rank" || (*v.Display)["layout"] != "board" {
			t.Fatalf("saved %s", first.Body)
		}
		got(bob.CreateViewWithResponse(ctx, &client.CreateViewParams{}, client.CreateViewBody{Entity: client.ViewEntityFeatures, Name: "Quick",
			Filters: &[]string{"quick:is:true"}})).want(t, http.StatusCreated)

		list := got(bob.ListViewsWithResponse(ctx, &client.ListViewsParams{})).want(t, http.StatusOK).JSON200.Items
		if len(list) != 2 || list[0].ID != v.ID || list[1].Name != "Quick" || list[1].TeamID != nil || list[1].Sort != nil || list[1].Display != nil {
			t.Fatalf("bob's Views: %+v", list)
		}
		entity := client.ViewEntityFeatures
		list = got(bob.ListViewsWithResponse(ctx, &client.ListViewsParams{Entity: &entity})).want(t, http.StatusOK).JSON200.Items
		if len(list) != 1 || list[0].Name != "Quick" {
			t.Fatalf("bob's feature Views: %+v", list)
		}
		list = got(bob.ListViewsWithResponse(ctx, &client.ListViewsParams{Team: ptrStr("WEB")})).want(t, http.StatusOK).JSON200.Items
		if len(list) != 1 || list[0].ID != v.ID {
			t.Fatalf("bob's Views of WEB: %+v", list)
		}
		if list := got(ada.ListViewsWithResponse(ctx, &client.ListViewsParams{})).want(t, http.StatusOK).JSON200.Items; len(list) != 0 {
			t.Fatalf("ada sees %+v", list)
		}

		changed := got(bob.UpdateViewWithResponse(ctx, v.ID, &client.UpdateViewParams{IdempotencyKey: key("v-2")},
			client.UpdateViewBody{Filters: &[]string{"claim:is:unheld"}, Sort: ptrStr("")})).want(t, http.StatusOK).JSON200
		if changed.Name != "Unheld" || !slices.Equal(changed.Filters, []string{"claim:is:unheld"}) || changed.Sort != nil || (*changed.Display)["layout"] != "board" {
			t.Fatalf("changed %+v", changed)
		}

		refused := func(status int, code client.ErrorCode, res interface {
			StatusCode() int
		}, def *client.Error) {
			t.Helper()
			if res.StatusCode() != status || def == nil || def.Code != code {
				t.Fatalf("status %d %+v, want %d %s", res.StatusCode(), def, status, code)
			}
		}
		res, err := bob.CreateViewWithResponse(ctx, &client.CreateViewParams{}, client.CreateViewBody{Entity: client.ViewEntityTasks, Team: ptrStr("WEB"), Name: "UNHELD"})
		got(res, err)
		refused(http.StatusConflict, client.ErrorCodeConflict, res, res.JSONDefault)
		res, err = bob.CreateViewWithResponse(ctx, &client.CreateViewParams{}, client.CreateViewBody{Entity: client.ViewEntityTasks, Name: "x",
			Filters: &[]string{"status:is:Todo"}})
		got(res, err)
		refused(http.StatusBadRequest, client.ErrorCodeInvalid, res, res.JSONDefault)
		res, err = bob.CreateViewWithResponse(ctx, &client.CreateViewParams{}, client.CreateViewBody{Entity: client.ViewEntityTasks, Team: ptrStr("NOPE"), Name: "x"})
		got(res, err)
		refused(http.StatusNotFound, client.ErrorCodeNotFound, res, res.JSONDefault)
		up, err := ada.UpdateViewWithResponse(ctx, v.ID, &client.UpdateViewParams{}, client.UpdateViewBody{Name: ptrStr("Mine")})
		got(up, err)
		refused(http.StatusNotFound, client.ErrorCodeNotFound, up, up.JSONDefault)
		del, err := ada.DeleteViewWithResponse(ctx, v.ID, &client.DeleteViewParams{})
		got(del, err)
		refused(http.StatusNotFound, client.ErrorCodeNotFound, del, del.JSONDefault)

		got(bob.DeleteViewWithResponse(ctx, v.ID, &client.DeleteViewParams{IdempotencyKey: key("v-3")})).want(t, http.StatusNoContent)
		got(bob.DeleteViewWithResponse(ctx, v.ID, &client.DeleteViewParams{IdempotencyKey: key("v-3")})).want(t, http.StatusNoContent)
		del, err = bob.DeleteViewWithResponse(ctx, v.ID, &client.DeleteViewParams{})
		got(del, err)
		refused(http.StatusNotFound, client.ErrorCodeNotFound, del, del.JSONDefault)
	})
}
