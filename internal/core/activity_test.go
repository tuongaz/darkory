package core_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Activity about one Task: a Task's own entries, by id or key; a Parent's with its Subtasks';
// never another Task's, even one that names it, such as a blocker added to that Task; and the
// Task filter composes with the Project, Member and kind filters and with paging.
func TestActivityAboutATask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB", "API"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})

		pd := f.parent(lead, "WEB", "Checkout")
		parent, breakdown := pd.Task, pd.Subtasks[0]
		sub := f.subtask(lead, parent.Key, "Pay", "Build")
		other := f.task(lead, "WEB", "Search", "Build")
		f.task(lead, "API", "Rate limit", "Backlog")
		f.claim(builder, sub.Key, core.ClaimOptions{})
		f.advance(builder, sub.Key, "pass")
		if err := f.svc.AddBlocker(ctx, lead, other.Key, sub.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}

		read := func(c *auth.Caller, q core.ActivityQuery) []string {
			t.Helper()
			page, err := f.svc.ListActivity(ctx, c, q)
			if err != nil {
				t.Fatalf("%+v: %v", q, err)
			}
			names := map[string]string{parent.ID: "parent", breakdown.ID: "breakdown", sub.ID: "sub", other.ID: "other"}
			var got []string
			for _, a := range page.Items {
				got = append(got, a.Kind+" "+names[a.SubjectID])
			}
			return got
		}

		// A Parent's own entries and its Subtasks', by key or by id alike.
		all := read(lead, core.ActivityQuery{Task: parent.Key})
		if byID := read(lead, core.ActivityQuery{Task: parent.ID}); !slices.Equal(all, byID) {
			t.Fatalf("by key %q, by id %q", all, byID)
		}
		for _, want := range []string{"task.filed parent", "task.filed breakdown", "task.filed sub", "task.claimed sub", "task.advanced sub"} {
			if !slices.Contains(all, want) {
				t.Fatalf("the Parent's Activity %q lacks %q", all, want)
			}
		}
		for _, e := range all {
			if !strings.HasSuffix(e, " parent") && !strings.HasSuffix(e, " breakdown") && !strings.HasSuffix(e, " sub") {
				t.Fatalf("the Parent's Activity holds %q", e)
			}
		}

		// A Subtask's are its own: not its Parent's or its sibling's.
		for _, e := range read(lead, core.ActivityQuery{Task: sub.Key}) {
			if !strings.HasSuffix(e, " sub") {
				t.Fatalf("the Subtask's Activity holds %q", e)
			}
		}
		// The blocker added to another Task names sub, but is about that Task.
		if got := read(lead, core.ActivityQuery{Task: other.Key}); !slices.Equal(got, []string{"task.filed other", "task.blocker_added other"}) {
			t.Fatalf("the other Task's Activity %q", got)
		}

		// Composed with the kind, Member and Project filters.
		if got := read(lead, core.ActivityQuery{Task: parent.Key, Kinds: []string{"task.claimed", "task.advanced"}}); !slices.Equal(got, []string{"task.claimed sub", "task.advanced sub"}) {
			t.Fatalf("with kinds %q", got)
		}
		if got := read(lead, core.ActivityQuery{Task: parent.Key, Member: "builder"}); !slices.Equal(got, []string{"task.claimed sub", "task.advanced sub"}) {
			t.Fatalf("with a Member %q", got)
		}
		if got := read(lead, core.ActivityQuery{Task: parent.Key, Project: "WEB"}); !slices.Equal(got, all) {
			t.Fatalf("with its Project %q", got)
		}
		if got := read(lead, core.ActivityQuery{Task: parent.Key, Project: "API"}); len(got) != 0 {
			t.Fatalf("with another Project %q", got)
		}

		// Paged backwards: the matching entries just below before, in sequence order.
		if got := read(lead, core.ActivityQuery{Task: parent.Key, Before: 1 << 53, Limit: 2}); !slices.Equal(got, all[len(all)-2:]) {
			t.Fatalf("the latest two %q, of %q", got, all)
		}

		// A Task that is not there is refused.
		_, err := f.svc.ListActivity(ctx, lead, core.ActivityQuery{Task: "WEB-999"})
		wantCode(t, err, core.CodeNotFound)
	})
}
