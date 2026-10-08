package core_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A Project keeps the colour it is given: the first twelve of an Organisation each take a hue of
// their own, farthest from those taken, in the order migration 0005 gave the Projects already
// there; the thirteenth starts round again; a colour named on create or change is kept.
func TestProjectsTakeDistinctColours(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		ps, err := f.svc.ListProjects(ctx, f.admin)
		if err != nil {
			t.Fatal(err)
		}
		colors := []int{}
		for _, p := range ps { // any init made
			colors = append(colors, p.Color)
		}
		for i := 0; len(colors) < 13; i++ {
			d, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: fmt.Sprintf("P%02d", i), Name: fmt.Sprintf("Project %d", i)}, core.Idem{})
			if err != nil {
				t.Fatal(err)
			}
			colors = append(colors, d.Project.Color)
		}
		if want := []int{0, 6, 3, 9, 1, 2, 4, 5, 7, 8, 10, 11, 0}; !slices.Equal(colors, want) {
			t.Fatalf("colours %v, want %v", colors, want)
		}

		seven := 7
		d, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "NAMED", Name: "Named", Color: &seven}, core.Idem{})
		if err != nil || d.Project.Color != 7 {
			t.Fatalf("named colour: %+v, %v", d.Project, err)
		}
		two := 2
		p, err := f.svc.UpdateProject(ctx, f.admin, "NAMED", core.ProjectChange{Color: &two}, core.Idem{})
		if err != nil || p.Color != 2 {
			t.Fatalf("changed colour: %+v, %v", p, err)
		}
		if got, _ := f.svc.GetProject(ctx, f.admin, "NAMED"); got.Project.Color != 2 {
			t.Fatalf("read back colour %d, want 2", got.Project.Color)
		}
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'project.changed' AND payload LIKE '%"color":2%'`); n != 1 {
			t.Fatalf("project.changed with the colour recorded %d times, want 1", n)
		}
		for _, bad := range []int{-1, 12} {
			_, err = f.svc.UpdateProject(ctx, f.admin, "NAMED", core.ProjectChange{Color: &bad}, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
			_, err = f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "BAD", Name: "Bad", Color: &bad}, core.Idem{})
			wantCode(t, err, core.CodeInvalid)
		}
	})
}
