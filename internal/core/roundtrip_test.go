package core_test

import (
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// On Postgres each hot-path write — claim, next's claim, heartbeat, release, handover, complete,
// note, observe, and a review's complete that publishes a Skill version — sends its whole
// transaction in one round trip (plan invariant 4), so the Organisation's counter is held for one
// round trip. The reads before it are counted apart; they hold nothing.
func TestHotPathWritesAreOneRoundTripOnPostgres(t *testing.T) {
	var w storetest.Wire
	st := storetest.OpenWith(t, store.Postgres, store.WithMaxConns(1), w.Option())
	f := newFixture(t, st)
	ctx := t.Context()
	f.team("WEB")
	f.skill("build")
	f.skill("qa")
	if _, err := f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "qa-acme", Kind: "company", BaseSkill: ptrStr("qa"), Body: "v1"}, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	c := f.member("builder", []string{"WEB"}, []string{"build"})
	lead := f.member("lead", []string{"WEB"}, nil)
	reviewer := f.member("reviewer", []string{"WEB"}, []string{core.SkillSkillReview})
	feature := f.feature(lead, "WEB", "Round trips").Feature.ID

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
		{"handover", func(task core.Task) error {
			_, err := f.svc.Handover(ctx, c, task.ID, "build", nil, nil, jsonIdem("handover-"+task.ID, "h"))
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
			// Not measured: a new Task, written up for review by the builder.
			review := f.task(lead, feature, "Review "+task.Key, "build")
			// Only a Retrospective proposes; stand this one in for it rather than ship the Feature.
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
			if _, err := f.svc.Handover(ctx, c, review.ID, core.SkillSkillReview, nil, nil, core.Idem{}); err != nil {
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
		task := f.task(lead, feature, name("task", round), "build")
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
}
