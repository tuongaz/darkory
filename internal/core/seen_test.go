package core_test

import (
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A Member's mark of how far they have seen a Project's Activity, on both engines: none until
// set, set and read back, moved forward but never back, kept apart per Member and per Project,
// refused past the newest Activity entry, to a Member outside the Project, and for a Project that
// does not exist; a retry under the same key answers the same; and none of it written to Activity
// or numbered.
func TestProjectSeen(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("OPS")
		bob := f.member("bob", []string{"WEB", "OPS"}, nil)
		cat := f.member("cat", []string{"WEB"}, nil)
		dan := f.member("dan", []string{"OPS"}, nil)
		newest := int64(f.checkActivity())
		before := newest

		mark := func(m core.ProjectSeen, seq int64, at time.Time) {
			t.Helper()
			if m.Seq == nil || *m.Seq != seq || m.At == nil || !m.At.Equal(at) {
				t.Fatalf("mark %v at %v, want %d at %v", deref(m.Seq), m.At, seq, at)
			}
		}

		m, err := f.svc.GetProjectSeen(ctx, bob, "WEB")
		if err != nil || m.Seq != nil || m.At != nil {
			t.Fatalf("before any is set: %+v %v", m, err)
		}

		f.clock.Advance(time.Minute)
		set1 := f.clock.Now()
		m, err = f.svc.SetProjectSeen(ctx, bob, "WEB", newest-2, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		mark(m, newest-2, set1)
		m, err = f.svc.GetProjectSeen(ctx, bob, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		mark(m, newest-2, set1)

		// Behind or at the mark changes nothing, its time included.
		f.clock.Advance(time.Minute)
		for _, seq := range []int64{newest - 3, newest - 2, 0} {
			m, err = f.svc.SetProjectSeen(ctx, bob, "WEB", seq, core.Idem{})
			if err != nil {
				t.Fatal(err)
			}
			mark(m, newest-2, set1)
		}
		set2 := f.clock.Now()
		m, err = f.svc.SetProjectSeen(ctx, bob, "WEB", newest, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		mark(m, newest, set2)

		// Each Member and each Project has its own.
		if m, err := f.svc.GetProjectSeen(ctx, cat, "WEB"); err != nil || m.Seq != nil {
			t.Fatalf("cat's mark on WEB: %+v %v", m, err)
		}
		if m, err := f.svc.GetProjectSeen(ctx, bob, "OPS"); err != nil || m.Seq != nil {
			t.Fatalf("bob's mark on OPS: %+v %v", m, err)
		}
		m, err = f.svc.SetProjectSeen(ctx, cat, "WEB", 1, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		mark(m, 1, set2)
		m, _ = f.svc.GetProjectSeen(ctx, bob, "WEB")
		mark(m, newest, set2)

		_, err = f.svc.SetProjectSeen(ctx, bob, "WEB", newest+1, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.SetProjectSeen(ctx, bob, "WEB", -1, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.GetProjectSeen(ctx, dan, "WEB")
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.SetProjectSeen(ctx, dan, "WEB", 1, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.GetProjectSeen(ctx, bob, "NOPE")
		wantCode(t, err, core.CodeNotFound)
		_, err = f.svc.SetProjectSeen(ctx, bob, "NOPE", 1, core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		// A retry under the same key answers as the first did, though the mark has moved on since.
		set := func(key, hash string, seq int64) answer {
			t.Helper()
			idem := jsonIdem(key, hash)
			m, err := f.svc.SetProjectSeen(ctx, dan, "OPS", seq, idem)
			return answerOf(t, idem, m, err)
		}
		first := set("s1", "h1", 2)
		if _, err := f.svc.SetProjectSeen(ctx, dan, "OPS", 3, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if again := set("s1", "h1", 2); again.status != first.status || string(again.body) != string(first.body) {
			t.Fatalf("retry: %d %s, first %d %s", again.status, again.body, first.status, first.body)
		}
		m, _ = f.svc.GetProjectSeen(ctx, dan, "OPS")
		mark(m, 3, set2)

		// checkActivity also holds the counter to the entries: no sequence number was taken.
		if after := int64(f.checkActivity()); after != before {
			t.Errorf("marks wrote %d Activity entries", after-before)
		}
	})
}

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
