package core_test

import (
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// On Postgres each hot-path write — claim, next's claim, heartbeat, release, advance, complete,
// note, observe, and a review's complete that publishes a Skill version — sends its whole
// transaction in one round trip (plan invariant 4), so the Organisation's counter is held for one
// round trip. So does a complete that files a Parent's Acceptance, or completes the Parent and
// files its Retrospective. The reads before it are counted apart; they hold nothing.
func TestHotPathWritesAreOneRoundTripOnPostgres(t *testing.T) {
	var w storetest.Wire
	st := storetest.OpenWith(t, store.Postgres, store.WithMaxConns(1), w.Option())
	f := newFixture(t, st)
	ctx := t.Context()
	f.project("WEB")
	f.skill("build")
	f.skill("qa")
	if _, err := f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "qa-acme", Kind: "company", BaseSkill: ptrStr("qa"), Body: "v1"}, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", core.WorkflowsInput{
		Steps: []core.StepInput{{Name: "Plan", Skill: ptrStr(core.SkillBreakdown)}, {Name: "Build", Skill: ptrStr("build")},
			{Name: "Acceptance", Skill: ptrStr(core.SkillAcceptance)}, {Name: "Retro", Skill: ptrStr(core.SkillRetro)},
			{Name: "Skill review", Skill: ptrStr(core.SkillSkillReview)}},
		Connectors: []core.ConnectorInput{
			{From: "Plan", Name: "done"},
			{From: "Build", Name: "pass"}, {From: "Build", To: ptrStr("Build"), Name: "again"},
			{From: "Acceptance", Name: "pass"},
			{From: "Retro", Name: "done"}, {From: "Retro", To: ptrStr("Skill review"), Name: "propose"},
			{From: "Skill review", Name: "publish"},
		},
	}, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	c := f.member("builder", []string{"WEB"}, []string{"build", core.SkillRetro})
	lead := f.member("lead", []string{"WEB"}, nil)
	reviewer := f.member("reviewer", []string{"WEB"}, []string{core.SkillSkillReview})

	var reviews []string
	ops := []struct {
		name string
		run  func(task core.Task) error
	}{
		{"claim", func(task core.Task) error {
			_, err := f.svc.Claim(ctx, c, task.ID, timeout(time.Minute), jsonIdem("claim-"+task.ID, "h"))
			return err
		}},
		{"heartbeat", func(task core.Task) error {
			hb, err := f.svc.Heartbeat(ctx, c, task.ID)
			if err == nil && hb.Status != "ok" {
				t.Fatalf("heartbeat %+v", hb)
			}
			return err
		}},
		{"note", func(task core.Task) error {
			_, err := f.svc.AddNote(ctx, c, task.ID, "a note", jsonIdem("note-"+task.ID, "h"))
			return err
		}},
		{"observe", func(task core.Task) error {
			_, err := f.svc.Observe(ctx, c, task.ID, "worked", "an Observation", jsonIdem("observe-"+task.ID, "h"))
			return err
		}},
		{"release", func(task core.Task) error {
			_, err := f.svc.Release(ctx, c, task.ID, nil, jsonIdem("release-"+task.ID, "h"))
			return err
		}},
		{"next", func(task core.Task) error {
			d, ok, err := f.svc.Next(ctx, c, 0, timeout(time.Minute), jsonIdem("next-"+task.ID, "h"))
			if err == nil && (!ok || d.Task.ID != task.ID) {
				t.Fatalf("next claimed %v %v", d.Task.Key, ok)
			}
			return err
		}},
		{"advance", func(task core.Task) error {
			_, err := f.svc.Advance(ctx, c, task.ID, "again", nil, jsonIdem("advance-"+task.ID, "h"))
			return err
		}},
		{"claim", func(task core.Task) error {
			_, err := f.svc.Claim(ctx, c, task.ID, timeout(time.Minute), jsonIdem("claim-again-"+task.ID, "h"))
			return err
		}},
		{"complete", func(task core.Task) error {
			_, err := f.svc.Complete(ctx, c, task.ID, nil, jsonIdem("complete-"+task.ID, "h"))
			return err
		}},
		{"propose", func(task core.Task) error {
			// Not measured: a Retrospective, written up for review by the builder.
			review := f.task(lead, "WEB", "Review "+task.Key, "Retro")
			// Only a Retrospective proposes; stand this one in for it rather than end a Parent.
			f.exec(`UPDATE tasks SET kind = 'retrospective' WHERE id = $1`, review.ID)
			if _, err := f.svc.Claim(ctx, c, review.ID, noTimeout, core.Idem{}); err != nil {
				return err
			}
			current, err := f.svc.GetSkill(ctx, c, "qa-acme")
			if err != nil {
				return err
			}
			if _, err := f.svc.ProposeSkillVersion(ctx, c, review.ID, "qa-acme", current.Skill.CurrentVersion, "next", core.Idem{}); err != nil {
				return err
			}
			if _, err := f.svc.Advance(ctx, c, review.ID, "propose", nil, core.Idem{}); err != nil {
				return err
			}
			_, err = f.svc.Claim(ctx, reviewer, review.ID, noTimeout, core.Idem{})
			reviews = append(reviews, review.ID)
			return err
		}},
		{"complete (publishing)", func(core.Task) error {
			_, err := f.svc.Complete(ctx, reviewer, reviews[len(reviews)-1], nil, jsonIdem("publish-"+reviews[len(reviews)-1], "h"))
			return err
		}},
	}
	// The first round prepares every statement on the one connection; the second is measured.
	for round := range 2 {
		task := f.task(lead, "WEB", name("task", round), "Build")
		for _, op := range ops {
			before := w.Snapshot()
			if err := op.run(task); err != nil {
				t.Fatalf("%s: %v", op.name, err)
			}
			got := w.Since(before)
			if round == 0 || op.name == "propose" {
				continue
			}
			t.Logf("%-9s write: %d batch in %d round trip; whole call: %d round trips", op.name, got.Batches, got.BatchRoundTrips, got.RoundTrips)
			if got.Batches != 1 || got.BatchRoundTrips != 1 {
				t.Errorf("%s: the write took %d batches in %d round trips, want 1 in 1", op.name, got.Batches, got.BatchRoundTrips)
			}
		}
	}

	// A complete that files its Parent's Acceptance, and one that completes its Parent and files
	// the Retrospective, are still one batch. The lead owns each Parent and takes its Breakdown,
	// which no one in WEB could.
	for _, rule := range []string{"acceptance", "auto-complete"} {
		for round := range 2 {
			nt := core.NewTask{Project: ptrStr("WEB"), Title: name(rule, round), Breakdown: true,
				AutoComplete: ptrBool(rule == "auto-complete"), Acceptance: ptrBool(rule == "acceptance")}
			d := f.fileTask(lead, nt)
			breakdown := d.Subtasks[0].ID
			if _, err := f.svc.Claim(ctx, lead, breakdown, noTimeout, core.Idem{}); err != nil {
				t.Fatal(err)
			}
			before := w.Snapshot()
			if _, err := f.svc.Complete(ctx, lead, breakdown, nil, jsonIdem(rule+"-"+breakdown, "h")); err != nil {
				t.Fatal(err)
			}
			got := w.Since(before)
			after := f.get(d.Task.ID)
			kinds := map[string]string{}
			for _, sub := range after.Subtasks {
				kinds[sub.Kind] = sub.State
			}
			switch {
			case rule == "acceptance" && (after.Task.State != "open" || kinds["acceptance"] != "open"):
				t.Fatalf("the Parent after its last Subtask: %s, Subtasks %v", after.Task.State, kinds)
			case rule == "auto-complete" && (after.Task.State != "done" || kinds["retrospective"] != "open"):
				t.Fatalf("the Parent after its last Subtask: %s, Subtasks %v", after.Task.State, kinds)
			}
			if round == 0 {
				continue
			}
			t.Logf("complete (%s) write: %d batch in %d round trip; whole call: %d round trips", rule, got.Batches, got.BatchRoundTrips, got.RoundTrips)
			if got.Batches != 1 || got.BatchRoundTrips != 1 {
				t.Errorf("complete (%s): the write took %d batches in %d round trips, want 1 in 1", rule, got.Batches, got.BatchRoundTrips)
			}
		}
	}
}
