package core_test

import (
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// On Postgres each hot-path write — claim, next's claim, heartbeat, release, complete — sends its
// whole transaction in one round trip (plan invariant 4), so the Organisation's counter is held
// for one round trip. The reads before it are counted apart; they hold nothing.
func TestHotPathWritesAreOneRoundTripOnPostgres(t *testing.T) {
	var w storetest.Wire
	st := storetest.OpenWith(t, store.Postgres, store.WithMaxConns(1), w.Option())
	f := newFixture(t, st)
	ctx := t.Context()
	f.team("WEB")
	f.skill("build")
	c := f.member("builder", []string{"WEB"}, []string{"build"})
	lead := f.member("lead", []string{"WEB"}, nil)
	feature := f.feature(lead, "WEB", "Round trips").Feature.ID

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
		{"complete", func(task core.Task) error {
			_, err := f.svc.Complete(ctx, c, task.ID, nil, jsonIdem("complete-"+task.ID, "h"))
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
			if round == 0 {
				continue
			}
			t.Logf("%-9s write: %d batch in %d round trip; whole call: %d round trips", op.name, got.Batches, got.BatchRoundTrips, got.RoundTrips)
			if got.Batches != 1 || got.BatchRoundTrips != 1 {
				t.Errorf("%s: the write took %d batches in %d round trips, want 1 in 1", op.name, got.Batches, got.BatchRoundTrips)
			}
		}
	}
}
