package core_test

import (
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Views on both engines: saved, listed by list and Project, changed field by field, deleted; their
// filters checked by the list's grammar; names unique per list ignoring case; another Member's
// Views neither listed nor changed nor deleted, an admin's request included; and none of it
// written to Activity or numbered.
func TestViews(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		web := f.project("WEB")
		ops := f.project("OPS")
		bob := f.member("bob", []string{"WEB"}, nil)
		ada := f.admin
		before := f.checkActivity()

		mine, err := f.svc.CreateView(ctx, bob, core.NewView{Entity: core.EntityTasks, Project: ptrStr("WEB"), Name: "Unheld this week",
			Filters: []string{"holder:is:none", "filed_at:last:7d"}, Sort: ptrStr("updated_at:desc"),
			Display: map[string]any{"layout": "board", "show_done": false}}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if mine.Entity != "tasks" || mine.ProjectID == nil || *mine.ProjectID != web || mine.Name != "Unheld this week" ||
			!slices.Equal(mine.Filters, []string{"holder:is:none", "filed_at:last:7d"}) || mine.Sort == nil || *mine.Sort != "updated_at:desc" ||
			mine.Display["layout"] != "board" || mine.Display["show_done"] != false || !mine.CreatedAt.Equal(epoch) || !mine.UpdatedAt.Equal(epoch) {
			t.Fatalf("saved %+v", mine)
		}
		across, err := f.svc.CreateView(ctx, bob, core.NewView{Entity: core.EntityTasks, Name: "unheld THIS week"}, core.Idem{})
		if err != nil {
			t.Fatalf("the same name on the list across Projects: %v", err)
		}
		if across.ProjectID != nil || across.Filters == nil || len(across.Filters) != 0 || across.Sort != nil || across.Display != nil {
			t.Fatalf("a View with nothing but a name: %+v", across)
		}
		f.clock.Advance(time.Minute)
		opsView, err := f.svc.CreateView(ctx, bob, core.NewView{Entity: core.EntityTasks, Project: ptrStr(ops), Name: "Unheld this week",
			Filters: []string{"top:is:true"}}, core.Idem{})
		if err != nil {
			t.Fatalf("the same name on another Project's list: %v", err)
		}
		if _, err := f.svc.CreateView(ctx, ada, core.NewView{Entity: core.EntityTasks, Project: ptrStr("WEB"), Name: "Unheld this week"}, core.Idem{}); err != nil {
			t.Fatalf("another Member's name: %v", err)
		}

		keyOf := map[string]string{web: "WEB", ops: "OPS"}
		names := func(entity, project *string) []string {
			t.Helper()
			vs, err := f.svc.ListViews(ctx, bob, entity, project)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, v := range vs {
				where := "-"
				if v.ProjectID != nil {
					where = keyOf[*v.ProjectID]
				}
				out = append(out, v.Name+"@"+where)
			}
			return out
		}
		if got := names(nil, nil); !slices.Equal(got, []string{"Unheld this week@WEB", "unheld THIS week@-", "Unheld this week@OPS"}) {
			t.Errorf("bob's Views: %q", got)
		}
		if got := names(ptrStr("tasks"), ptrStr("WEB")); !slices.Equal(got, []string{"Unheld this week@WEB"}) {
			t.Errorf("bob's task Views of WEB: %q", got)
		}
		if got := names(nil, ptrStr("OPS")); !slices.Equal(got, []string{"Unheld this week@OPS"}) {
			t.Errorf("bob's Views of OPS: %q", got)
		}
		_, err = f.svc.ListViews(ctx, bob, ptrStr("features"), nil)
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.ListViews(ctx, bob, ptrStr("members"), nil)
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.ListViews(ctx, bob, nil, ptrStr("NOPE"))
		wantCode(t, err, core.CodeNotFound)

		// Refused: a name taken on the same list, ignoring case; filters the list does not take;
		// a bad entity, name, sort or display; an unknown Project; the Features list, which is gone.
		for _, c := range []struct {
			nv   core.NewView
			code core.Code
		}{
			{core.NewView{Entity: "tasks", Project: ptrStr("WEB"), Name: "UNHELD this WEEK"}, core.CodeConflict},
			{core.NewView{Entity: "features", Project: ptrStr("WEB"), Name: "x", Filters: []string{"holder:is:none"}}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: "x", Filters: []string{"status:is:Todo"}}, core.CodeInvalid},
			{core.NewView{Entity: "members", Name: "x"}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: "  "}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: strings.Repeat("x", 101)}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: "two\nlines"}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: "x", Sort: ptrStr(strings.Repeat("s", 201))}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Name: "x", Display: map[string]any{"big": strings.Repeat("d", 16<<10)}}, core.CodeInvalid},
			{core.NewView{Entity: "tasks", Project: ptrStr("NOPE"), Name: "x"}, core.CodeNotFound},
		} {
			_, err := f.svc.CreateView(ctx, bob, c.nv, core.Idem{})
			if codeOf(err) != c.code {
				t.Errorf("%+v: %v, want %s", c.nv, err, c.code)
			}
		}

		// Changes replace the fields given and keep the others; sort "" clears it.
		f.clock.Advance(time.Minute)
		changed, err := f.svc.UpdateView(ctx, bob, mine.ID, core.ViewChange{Name: ptrStr("Unheld"), Filters: &[]string{"claim:is:unheld"}}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if changed.Name != "Unheld" || !slices.Equal(changed.Filters, []string{"claim:is:unheld"}) || *changed.Sort != "updated_at:desc" ||
			changed.Display["layout"] != "board" || !changed.CreatedAt.Equal(epoch) || !changed.UpdatedAt.Equal(epoch.Add(2*time.Minute)) {
			t.Fatalf("changed %+v", changed)
		}
		changed, err = f.svc.UpdateView(ctx, bob, mine.ID, core.ViewChange{Sort: ptrStr(""), Display: map[string]any{"layout": "list"}}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if changed.Name != "Unheld" || changed.Sort != nil || len(changed.Display) != 1 || changed.Display["layout"] != "list" {
			t.Fatalf("changed again %+v", changed)
		}
		// Its own name, in another case, is free to it; another View's of the same list is not, and
		// one of another list is.
		if _, err := f.svc.UpdateView(ctx, bob, mine.ID, core.ViewChange{Name: ptrStr("UNHELD")}, core.Idem{}); err != nil {
			t.Errorf("renamed in another case: %v", err)
		}
		other, err := f.svc.CreateView(ctx, bob, core.NewView{Entity: core.EntityTasks, Project: ptrStr("WEB"), Name: "Other"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.UpdateView(ctx, bob, other.ID, core.ViewChange{Name: ptrStr("unheld")}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		if _, err := f.svc.UpdateView(ctx, bob, across.ID, core.ViewChange{Name: ptrStr("unheld")}, core.Idem{}); err != nil {
			t.Errorf("a name taken on another list: %v", err)
		}
		_, err = f.svc.UpdateView(ctx, bob, opsView.ID, core.ViewChange{Filters: &[]string{"status:is:" + ops}}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.UpdateView(ctx, bob, mine.ID, core.ViewChange{Name: ptrStr("")}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		// Another Member's Views are not there for ada, an admin, nor for bob.
		adas, err := f.svc.ListViews(ctx, ada, nil, nil)
		if err != nil || len(adas) != 1 || adas[0].Name != "Unheld this week" {
			t.Fatalf("ada's Views: %+v %v", adas, err)
		}
		_, err = f.svc.UpdateView(ctx, ada, mine.ID, core.ViewChange{Name: ptrStr("Mine now")}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		wantCode(t, f.svc.DeleteView(ctx, ada, mine.ID, core.Idem{}), core.CodeNotFound)
		_, err = f.svc.UpdateView(ctx, bob, adas[0].ID, core.ViewChange{Name: ptrStr("Mine now")}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		_, err = f.svc.UpdateView(ctx, bob, "no-such-view", core.ViewChange{}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		if err := f.svc.DeleteView(ctx, bob, mine.ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.svc.DeleteView(ctx, bob, mine.ID, core.Idem{}), core.CodeNotFound)
		if got := names(nil, nil); !slices.Equal(got, []string{"unheld@-", "Unheld this week@OPS", "Other@WEB"}) {
			t.Errorf("bob's Views after the delete: %q", got)
		}
		if after := f.checkActivity(); after != before {
			t.Errorf("Views wrote %d Activity entries", after-before)
		}
	})
}

// A View's writes keep their responses under an Idempotency-Key, as every write does: a retry
// answers with the first response and saves nothing twice; a refusal of a rule's is kept too; and a
// key reused for another request is refused.
func TestViewIdempotency(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		ada := f.admin
		before := f.checkActivity()
		create := func(key, hash, name string) answer {
			t.Helper()
			idem := jsonIdem(key, hash)
			v, err := f.svc.CreateView(ctx, ada, core.NewView{Entity: "tasks", Name: name}, idem)
			return answerOf(t, idem, v, err)
		}
		first := create("k1", "h1", "Mine")
		f.clock.Advance(time.Second)
		if again := create("k1", "h1", "Mine"); again.status != first.status || string(again.body) != string(first.body) {
			t.Fatalf("retry: %d %s, first %d %s", again.status, again.body, first.status, first.body)
		}
		vs, err := f.svc.ListViews(ctx, ada, nil, nil)
		if err != nil || len(vs) != 1 {
			t.Fatalf("Views after a retry: %+v %v", vs, err)
		}
		// The name is taken now: the refusal is kept under its key and repeated.
		taken := create("k2", "h2", "MINE")
		if taken.status != 409 || !strings.Contains(string(taken.body), "conflict") {
			t.Fatalf("a taken name: %d %s", taken.status, taken.body)
		}
		if err := f.svc.DeleteView(ctx, ada, vs[0].ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if again := create("k2", "h2", "MINE"); string(again.body) != string(taken.body) {
			t.Fatalf("the kept refusal: %d %s", again.status, again.body)
		}
		_, err = f.svc.CreateView(ctx, ada, core.NewView{Entity: "tasks", Name: "Other"}, jsonIdem("k1", "h3"))
		wantCode(t, err, core.CodeIdempotencyKeyReused)
		if after := f.checkActivity(); after != before {
			t.Errorf("Views wrote %d Activity entries", after-before)
		}
	})
}

// Requests under one key at once save one View, and each answers with its response: on Postgres
// a View's write does not queue behind the Organisation's writes, so the keys' table decides.
func TestViewKeyRace(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		idem := jsonIdem("same", "h")
		answers := make([]answer, 8)
		var wg sync.WaitGroup
		for i := range answers {
			wg.Go(func() {
				v, err := f.svc.CreateView(ctx, f.admin, core.NewView{Entity: "tasks", Name: "Mine"}, idem)
				answers[i] = answerOf(t, idem, v, err)
			})
		}
		wg.Wait()
		for _, a := range answers[1:] {
			if a.status != answers[0].status || string(a.body) != string(answers[0].body) {
				t.Fatalf("answers differ: %d %s and %d %s", a.status, a.body, answers[0].status, answers[0].body)
			}
		}
		if n := f.count(`SELECT COUNT(*) FROM views WHERE org_id = $1`, f.admin.OrgID); n != 1 {
			t.Fatalf("%d Views saved", n)
		}
	})
}
