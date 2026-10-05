package core_test

import (
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

func (f *fixture) ranks(team string) []string {
	f.t.Helper()
	p, err := f.svc.ListFeatures(f.t.Context(), f.admin, core.FeatureFilter{Team: &team})
	if err != nil {
		f.t.Fatal(err)
	}
	var out []string
	for i, ft := range p.Items {
		if ft.Rank != int64(i+1) {
			f.t.Fatalf("%s has rank %d at position %d", ft.Title, ft.Rank, i+1)
		}
		out = append(out, ft.Title)
	}
	return out
}

func joined(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += " "
		}
		out += s
	}
	return out
}

// A Feature moves to any position in its Team's Rank; ended Features keep their places.
func TestRankFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.team("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		outsider := f.member("outsider", []string{"API"}, nil)
		var keys []string
		for _, title := range []string{"A", "B", "C", "D"} {
			keys = append(keys, f.feature(lead, "WEB", title).Feature.Key)
		}
		_, err := f.svc.RankFeature(ctx, outsider, keys[3], 1, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.RankFeature(ctx, lead, keys[3], 0, core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		moved, err := f.svc.RankFeature(ctx, lead, keys[3], 1, core.Idem{})
		if err != nil || moved.Rank != 1 {
			t.Fatalf("moved %+v, %v", moved, err)
		}
		if got := joined(f.ranks("WEB")); got != "D A B C" {
			t.Fatalf("Rank %s", got)
		}
		// B is dropped and keeps its place; moving past the end moves last.
		if _, err := f.svc.DropFeature(ctx, lead, keys[1], core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.RankFeature(ctx, lead, keys[3], 99, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := joined(f.ranks("WEB")); got != "A B C D" {
			t.Fatalf("Rank %s", got)
		}
		if _, err := f.svc.RankFeature(ctx, lead, keys[2], 2, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := joined(f.ranks("WEB")); got != "A C B D" {
			t.Fatalf("Rank %s", got)
		}
		before := f.checkActivity()
		if _, err := f.svc.RankFeature(ctx, lead, keys[2], 2, core.Idem{}); err != nil || f.checkActivity() != before {
			t.Fatalf("a move to the same place wrote Activity: %v", err)
		}
		if got := f.kinds(moved.ID); got != "feature.filed feature.ranked feature.ranked" {
			t.Fatalf("Activity: %s", got)
		}
	})
}

// Shipping needs every Task ended and the owner; it files the Retrospective. An ended Feature
// takes no new Task but its questions.
func TestShipFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		fd := f.feature(owner, "WEB", "Search")
		task := f.task(owner, fd.Feature.ID, "Index", "build")

		_, err := f.svc.ShipFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		wantCode(t, err, core.CodeTasksOpen)
		f.claim(owner, fd.Tasks[0].Key, noTimeout)
		f.complete(owner, fd.Tasks[0].Key)
		f.claim(builder, task.Key, noTimeout)
		f.complete(builder, task.Key)
		_, err = f.svc.ShipFeature(ctx, builder, fd.Feature.Key, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		shipped, err := f.svc.ShipFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if shipped.Feature.State != "shipped" || shipped.Feature.EndedAt == nil || len(shipped.Tasks) != 3 {
			t.Fatalf("shipped %+v with %d Tasks", shipped.Feature, len(shipped.Tasks))
		}
		r := shipped.Tasks[2]
		if r.Kind != "retrospective" || r.Title != "Retrospective: Search" || r.State != "open" || r.SkillID == nil || *r.SkillID != f.skillID(core.SkillRetro) {
			t.Fatalf("Retrospective %+v", r)
		}
		if c := shipped.Feature.TaskCounts; c.Open != 1 || c.Done != 2 || c.Dropped != 0 || c.Claimed != 0 {
			t.Fatalf("counts %+v", c)
		}
		_, err = f.svc.ShipFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		_, err = f.svc.DropFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		wantCode(t, err, core.CodeEnded)

		// Only the Retrospective and questions blocking a Task may be open on an ended Feature.
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Feature: &fd.Feature.Key, Title: "More work", Skill: ptrStr("build")}, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		f.claim(retro, r.Key, noTimeout)
		q, err := f.svc.FileTask(ctx, retro, core.NewTask{Title: "Why was search slow?", AimedAt: ptrStr("builder"), Blocks: &r.Key}, core.Idem{})
		if err != nil || q.Task.FeatureID != fd.Feature.ID {
			t.Fatalf("a question on an ended Feature: %+v, %v", q.Task, err)
		}
		if got := f.kinds(fd.Feature.ID); got != "feature.filed feature.shipped" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Dropping a Feature drops its open Tasks and ends their Claims; a late holder's Heartbeat says
// the Claim ended. The Retrospective is filed all the same.
func TestDropFeatureCascades(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		fd := f.feature(owner, "WEB", "Chat")
		held := f.task(owner, fd.Feature.ID, "Held", "build")
		lapsing := f.task(owner, fd.Feature.ID, "Lapsing", "build")
		done := f.task(owner, fd.Feature.ID, "Done", "build")
		f.claim(builder, done.Key, noTimeout)
		f.complete(builder, done.Key)
		f.claim(builder, lapsing.Key, timeout(time.Minute))
		f.clock.Advance(2 * time.Minute)
		f.claim(builder, held.Key, timeout(time.Minute))

		dropped, err := f.svc.DropFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if dropped.Feature.State != "dropped" {
			t.Fatalf("feature %+v", dropped.Feature)
		}
		states := map[string]string{}
		for _, task := range dropped.Tasks {
			states[task.Title] = task.State
			if task.Claim != nil {
				t.Errorf("%s still has a Claim", task.Title)
			}
		}
		if states["Held"] != "dropped" || states["Lapsing"] != "dropped" || states["Done"] != "done" ||
			states["Break down: Chat"] != "dropped" || states["Retrospective: Chat"] != "open" {
			t.Fatalf("states %v", states)
		}
		if hb, err := f.svc.Heartbeat(ctx, builder, held.Key); err != nil || hb.Status != "ended" {
			t.Fatalf("late heartbeat: %+v, %v", hb, err)
		}
		if how := *f.get(held.Key).Claims[0].HowEnded; how != "dropped" {
			t.Fatalf("held Claim ended %s", how)
		}
		if how := *f.get(lapsing.Key).Claims[0].HowEnded; how != "lapsed" {
			t.Fatalf("lapsed Claim ended %s", how)
		}
		if got := f.kinds(held.ID); got != "task.filed task.claimed task.dropped" {
			t.Fatalf("Activity: %s", got)
		}
		if got := f.kinds(lapsing.ID); got != "task.filed task.claimed task.lapsed task.dropped" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Ship and filing a Task race through the counter: either the Task lands first and the ship is
// refused, or the ship lands first and the filing is refused. Never a shipped Feature with an open
// Task beside its Retrospective.
func TestRaceShipAgainstFilingATask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown})
		filer := f.member("filer", []string{"WEB"}, nil)
		outcomes := map[string]int{}
		for i := range 10 {
			fd := f.feature(owner, "WEB", name("race", i))
			f.claim(owner, fd.Tasks[0].Key, noTimeout)
			f.complete(owner, fd.Tasks[0].Key)
			var shipErr, fileErr error
			var wg sync.WaitGroup
			start := make(chan struct{})
			wg.Go(func() {
				<-start
				_, shipErr = f.svc.ShipFeature(ctx, owner, fd.Feature.Key, core.Idem{})
			})
			wg.Go(func() {
				<-start
				_, fileErr = f.svc.FileTask(ctx, filer, core.NewTask{Feature: &fd.Feature.Key, Title: "Late", Skill: ptrStr("build")}, core.Idem{})
			})
			close(start)
			wg.Wait()
			switch {
			case shipErr == nil && codeOf(fileErr) == core.CodeEnded:
				outcomes["shipped first"]++
			case fileErr == nil && codeOf(shipErr) == core.CodeTasksOpen:
				outcomes["filed first"]++
			default:
				t.Fatalf("ship: %v; file: %v", shipErr, fileErr)
			}
		}
		if n := f.count(`SELECT COUNT(*) FROM tasks t JOIN features fe ON fe.id = t.feature_id
WHERE fe.state <> 'open' AND t.state = 'open' AND t.kind <> 'retrospective'`); n != 0 {
			t.Fatalf("%d open Tasks on ended Features", n)
		}
		t.Logf("outcomes %v", outcomes)
		f.checkActivity()
	})
}

// Ownership passes by the owner or by someone above them on their Reporting line.
func TestPassFeatureOwnership(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		boss := f.member("boss", nil, nil)
		peer := f.member("peer", []string{"WEB"}, nil)
		f.manager("owner", "boss")
		fd := f.feature(owner, "WEB", "Billing")
		_, err := f.svc.PassFeatureOwnership(ctx, peer, fd.Feature.Key, "peer", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		got, err := f.svc.PassFeatureOwnership(ctx, owner, fd.Feature.Key, "peer", core.Idem{})
		if err != nil || got.OwnerID != peer.MemberID {
			t.Fatalf("passed %+v, %v", got, err)
		}
		// boss is no longer above the owner, so cannot take it back; the new owner passes it on.
		_, err = f.svc.PassFeatureOwnership(ctx, boss, fd.Feature.Key, "boss", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		f.manager("peer", "boss")
		got, err = f.svc.PassFeatureOwnership(ctx, boss, fd.Feature.Key, "owner", core.Idem{})
		if err != nil || got.OwnerID != owner.MemberID {
			t.Fatalf("taken back up the line %+v, %v", got, err)
		}
		_, err = f.svc.ShipFeature(ctx, peer, fd.Feature.Key, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if got := f.kinds(fd.Feature.ID); got != "feature.filed feature.owner_passed feature.owner_passed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// When nobody in the Team has breakdown or retro, the Feature owner takes the Break down and the
// Retrospective (ADR 0010).
func TestOwnerFallbackForBreakdownAndRetrospective(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.team("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		mate := f.member("mate", []string{"WEB"}, nil)
		fd := f.feature(owner, "WEB", "Docs")
		breakdown := fd.Tasks[0]
		if !f.takeable(owner)[breakdown.ID] || f.takeable(mate)[breakdown.ID] {
			t.Fatal("the Break down does not fall to the owner alone")
		}
		f.claim(owner, breakdown.Key, noTimeout)
		f.complete(owner, breakdown.Key)
		shipped, err := f.svc.ShipFeature(t.Context(), owner, fd.Feature.Key, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		retro := shipped.Tasks[1]
		if !f.takeable(owner)[retro.ID] || f.takeable(mate)[retro.ID] {
			t.Fatal("the Retrospective does not fall to the owner alone")
		}
		// Once a Member of the Team has retro, the fallback ends.
		if err := f.svc.GrantSkill(t.Context(), f.admin, "mate", core.SkillRetro, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.takeable(owner)[retro.ID] || !f.takeable(mate)[retro.ID] {
			t.Fatal("the fallback holds while the Team has the Skill")
		}
	})
}

// An ended Feature keeps its Rank, and `next` offers its Retrospective by it, ahead of a
// Retrospective filed earlier on a Feature ranked lower.
func TestRetrospectiveSortsByTheEndedFeaturesRank(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		first := f.feature(owner, "WEB", "First")
		second := f.feature(owner, "WEB", "Second")
		if _, err := f.svc.DropFeature(ctx, owner, second.Feature.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		if _, err := f.svc.DropFeature(ctx, owner, first.Feature.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := joined(f.ranks("WEB")); got != "First Second" {
			t.Fatalf("Rank %s", got)
		}
		got, _ := f.svc.ListTakeable(ctx, retro, 0)
		if len(got) != 2 || got[0].Title != "Retrospective: First" {
			t.Fatalf("takeable %v", keys(got))
		}
		if _, err := f.svc.RankFeature(ctx, owner, second.Feature.Key, 1, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, ok, err := f.svc.Next(ctx, retro, 0, noTimeout, core.Idem{})
		if err != nil || !ok || d.Task.Title != "Retrospective: Second" {
			t.Fatalf("next %+v %v %v", d.Task, ok, err)
		}
	})
}
