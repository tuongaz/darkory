package core_test

import (
	"slices"
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Labels: a Project's are defined by its Members, the Organisation's by admins; a name is unique
// among a Project's Labels and the Organisation's taken together, ignoring case, so it always
// names one Label, though two Projects may each have one; colours are #rrggbb. A Task carries its
// Project's Labels and the Organisation's, named by id or name, set by any Member of its Project
// or its Owner whoever holds it; a Label renamed, recoloured or deleted changes what its Tasks
// carry. A Project's Activity covers its own Labels.
func TestLabels(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		outsider := f.member("outsider", []string{"API"}, nil)

		bug, err := f.svc.CreateLabel(ctx, lead, core.NewLabel{Project: ptrStr("WEB"), Name: " bug ", Color: "#FF0000"}, core.Idem{})
		if err != nil || bug.Name != "bug" || bug.Color != "#ff0000" || bug.ProjectID == nil {
			t.Fatalf("a Project's Label %+v, %v", bug, err)
		}
		client, err := f.svc.CreateLabel(ctx, f.admin, core.NewLabel{Name: "client-x", Color: "#00aa00"}, core.Idem{})
		if err != nil || client.ProjectID != nil {
			t.Fatalf("the Organisation's Label %+v, %v", client, err)
		}
		apiOnly, err := f.svc.CreateLabel(ctx, outsider, core.NewLabel{Project: ptrStr("API"), Name: "bug", Color: "#0000ff"}, core.Idem{})
		if err != nil {
			t.Fatalf("the same name in another Project: %v", err)
		}
		for _, c := range []struct {
			by   string
			nl   core.NewLabel
			code core.Code
		}{
			{"lead", core.NewLabel{Name: "org-wide", Color: "#000000"}, core.CodeForbidden},
			{"outsider", core.NewLabel{Project: ptrStr("WEB"), Name: "x", Color: "#000000"}, core.CodeForbidden},
			{"lead", core.NewLabel{Project: ptrStr("WEB"), Name: "BUG", Color: "#000000"}, core.CodeConflict},
			{"ada", core.NewLabel{Name: "CLIENT-X", Color: "#000000"}, core.CodeConflict},
			// Across the two scopes, both ways.
			{"lead", core.NewLabel{Project: ptrStr("WEB"), Name: "Client-X", Color: "#000000"}, core.CodeConflict},
			{"ada", core.NewLabel{Name: "Bug", Color: "#000000"}, core.CodeConflict},
			{"lead", core.NewLabel{Project: ptrStr("WEB"), Name: "red", Color: "red"}, core.CodeInvalid},
			{"lead", core.NewLabel{Project: ptrStr("WEB"), Name: "  ", Color: "#000000"}, core.CodeInvalid},
			{"lead", core.NewLabel{Project: ptrStr("NOPE"), Name: "x", Color: "#000000"}, core.CodeNotFound},
		} {
			caller := map[string]*auth.Caller{"lead": lead, "outsider": outsider, "ada": f.admin}[c.by]
			_, err := f.svc.CreateLabel(ctx, caller, c.nl, core.Idem{})
			if codeOf(err) != c.code {
				t.Errorf("%s creates %+v: %v, want %s", c.by, c.nl, err, c.code)
			}
		}
		if ls, err := f.svc.ListLabels(ctx, outsider, ptrStr("WEB")); err != nil || len(ls) != 1 || ls[0].ID != bug.ID {
			t.Fatalf("WEB's Labels %+v, %v", ls, err)
		}
		if ls, err := f.svc.ListLabels(ctx, outsider, nil); err != nil || len(ls) != 1 || ls[0].ID != client.ID {
			t.Fatalf("the Organisation's Labels %+v, %v", ls, err)
		}

		// Set on a Task, held or not, by a Member of its Project; another Project's Label is refused.
		task := f.task(lead, "WEB", "Checkout", "Build")
		f.claim(builder, task.Key, noTimeout)
		_, err = f.svc.SetTaskLabels(ctx, outsider, task.Key, []string{bug.ID}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.SetTaskLabels(ctx, lead, task.Key, []string{apiOnly.ID}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.SetTaskLabels(ctx, lead, task.Key, []string{"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		_, err = f.svc.SetTaskLabels(ctx, lead, task.Key, []string{"feature"}, core.Idem{})
		wantCode(t, err, core.CodeNotFound)
		// By id or by name in any case; WEB's bug, not API's.
		out, err := f.svc.SetTaskLabels(ctx, lead, task.Key, []string{"CLIENT-X", "Bug", client.ID}, core.Idem{})
		if err != nil || !slices.Equal(out.Labels, []string{bug.ID, client.ID}) || out.Claim == nil {
			t.Fatalf("labelled %+v, %v", out, err)
		}
		before := f.checkActivity()
		if _, err := f.svc.SetTaskLabels(ctx, builder, task.Key, []string{bug.ID, client.ID}, core.Idem{}); err != nil || f.checkActivity() != before {
			t.Fatalf("setting the same Labels wrote Activity: %v", err)
		}
		if out, err = f.svc.SetTaskLabels(ctx, builder, task.Key, []string{client.ID}, core.Idem{}); err != nil || !slices.Equal(out.Labels, []string{client.ID}) {
			t.Fatalf("relabelled %+v, %v", out.Labels, err)
		}
		set := f.activity("task.labels_set")
		if len(set) != 2 || set[1].Payload["removed"].([]any)[0] != bug.ID || len(set[1].Payload["added"].([]any)) != 0 {
			t.Fatalf("task.labels_set %+v", set)
		}
		if d := f.get(task.Key); len(d.Labels) != 1 || d.Labels[0].Name != "client-x" {
			t.Fatalf("the Task carries %+v", d.Labels)
		}

		// Renamed, recoloured, deleted: by the authority that defines it.
		_, err = f.svc.UpdateLabel(ctx, lead, client.ID, core.LabelChange{Name: ptrStr("client-y")}, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		renamed, err := f.svc.UpdateLabel(ctx, f.admin, client.ID, core.LabelChange{Name: ptrStr("client-y"), Color: ptrStr("#ABCDEF")}, core.Idem{})
		if err != nil || renamed.Name != "client-y" || renamed.Color != "#abcdef" {
			t.Fatalf("renamed %+v, %v", renamed, err)
		}
		_, err = f.svc.UpdateLabel(ctx, lead, bug.ID, core.LabelChange{Color: ptrStr("blue")}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.UpdateLabel(ctx, lead, bug.ID, core.LabelChange{Name: ptrStr("CLIENT-Y")}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.UpdateLabel(ctx, f.admin, client.ID, core.LabelChange{Name: ptrStr("BUG")}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		wantCode(t, f.svc.DeleteLabel(ctx, lead, client.ID, core.Idem{}), core.CodeForbidden)
		if err := f.svc.DeleteLabel(ctx, f.admin, client.ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if d := f.get(task.Key); len(d.Task.Labels) != 0 || len(d.Labels) != 0 {
			t.Fatalf("a deleted Label is still carried: %+v", d.Task.Labels)
		}
		if got := f.kinds(client.ID); got != "label.created label.changed label.deleted" {
			t.Fatalf("Activity: %s", got)
		}

		// WEB's Activity has its own Labels, a deleted one's entries included, and not API's or the
		// Organisation's.
		temp, err := f.svc.CreateLabel(ctx, lead, core.NewLabel{Project: ptrStr("WEB"), Name: "temp", Color: "#123456"}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.UpdateLabel(ctx, lead, temp.ID, core.LabelChange{Name: ptrStr("tmp")}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.DeleteLabel(ctx, lead, temp.ID, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		page, err := f.svc.ListActivity(ctx, lead, core.ActivityQuery{Project: "WEB", Kinds: []string{"label.created", "label.changed", "label.deleted"}})
		var got []string
		for _, a := range page.Items {
			got = append(got, a.Kind+" "+a.SubjectID)
		}
		if want := []string{"label.created " + bug.ID, "label.created " + temp.ID, "label.changed " + temp.ID, "label.deleted " + temp.ID}; err != nil ||
			!slices.Equal(got, want) {
			t.Fatalf("WEB's Label Activity %q, want %q (%v)", got, want, err)
		}
		f.checkActivity()
	})
}
