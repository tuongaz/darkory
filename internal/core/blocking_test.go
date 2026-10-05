package core_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// A blocked Task is not takeable until every Task blocking it has ended, done or dropped. Edges
// may cross Features; one that would close a loop is refused.
func TestBlocking(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.team("API")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB", "API"}, []string{"build"})
		outsider := f.member("outsider", []string{"API"}, nil)
		web := f.feature(owner, "WEB", "Sign-up").Feature.ID
		api := f.feature(outsider, "API", "Accounts").Feature.ID
		a := f.task(owner, web, "A", "build")
		b := f.task(owner, web, "B", "build")
		c := f.task(outsider, api, "C in another Feature", "build")

		// A Team Member and the Feature's owner may shape a Task nobody holds; others may not.
		err := f.svc.AddBlocker(ctx, outsider, a.Key, b.Key, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if err := f.svc.AddBlocker(ctx, builder, a.Key, b.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddBlocker(ctx, owner, a.Key, c.Key, core.Idem{}); err != nil {
			t.Fatalf("a blocker in another Feature: %v", err)
		}
		before := f.checkActivity()
		if err := f.svc.AddBlocker(ctx, owner, a.Key, b.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.checkActivity() != before {
			t.Fatal("adding an edge twice wrote Activity")
		}

		// Loops, direct, through another Task and onto itself, are refused.
		wantCode(t, f.svc.AddBlocker(ctx, owner, b.Key, a.Key, core.Idem{}), core.CodeCycle)
		d := f.task(owner, web, "D", "build")
		if err := f.svc.AddBlocker(ctx, owner, b.Key, d.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.svc.AddBlocker(ctx, owner, d.Key, a.Key, core.Idem{}), core.CodeCycle)
		wantCode(t, f.svc.AddBlocker(ctx, owner, d.Key, d.Key, core.Idem{}), core.CodeCycle)

		got := f.get(a.Key)
		if !got.Task.Blocked || len(got.Task.OpenBlockers) != 2 || got.Task.OpenBlockers[0].Key != b.Key || got.Task.OpenBlockers[1].Key != c.Key {
			t.Fatalf("A's open blockers %+v", got.Task.OpenBlockers)
		}
		if len(got.Blockers) != 2 {
			t.Fatalf("A's blockers %+v", got.Blockers)
		}
		fd, err := f.svc.GetFeature(ctx, owner, web)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range fd.Tasks {
			if task.ID == a.ID && len(task.OpenBlockers) != 2 {
				t.Fatalf("the Feature names A's blockers as %+v", task.OpenBlockers)
			}
		}

		// A stays blocked until both its blockers end, one done and one dropped.
		if f.takeable(builder)[a.ID] {
			t.Fatal("a blocked Task is takeable")
		}
		f.claim(builder, c.Key, noTimeout)
		f.complete(builder, c.Key)
		if _, err := f.svc.DropTask(ctx, owner, d.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.claim(builder, b.Key, noTimeout)
		if f.takeable(builder)[a.ID] {
			t.Fatal("A is takeable while B is open")
		}
		// While B is held, only its holder may change what blocks it.
		wantCode(t, f.svc.AddBlocker(ctx, owner, b.Key, c.Key, core.Idem{}), core.CodeNotHolder)
		f.complete(builder, b.Key)
		if !f.takeable(builder)[a.ID] {
			t.Fatal("A is still blocked after its blockers ended")
		}
		if got := f.get(a.Key); got.Task.Blocked || got.Task.OpenBlockers != nil {
			t.Fatalf("A %+v", got.Task)
		}

		// Removing an edge needs the same authority.
		e := f.task(owner, web, "E", "build")
		if err := f.svc.AddBlocker(ctx, owner, e.Key, a.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.svc.RemoveBlocker(ctx, outsider, e.Key, a.Key, core.Idem{}), core.CodeForbidden)
		if err := f.svc.RemoveBlocker(ctx, owner, e.Key, a.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if !f.takeable(builder)[e.ID] {
			t.Fatal("E is blocked after its blocker was removed")
		}
		wantCode(t, f.svc.AddBlocker(ctx, owner, b.Key, e.Key, core.Idem{}), core.CodeEnded)
		if got := f.kinds(e.ID); got != "task.filed task.blocker_added task.blocker_removed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// A stuck Member files a question aimed at someone above them, in another Team, and lets it block
// their Task: the question joins the Task's Feature, the asker keeps their Claim, and the Member
// asked takes it from their own Team.
func TestQuestionsAndEscalations(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.team("OPS")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		boss := f.member("boss", []string{"OPS"}, nil)
		other := f.member("other", []string{"WEB"}, []string{"build"})
		f.manager("builder", "boss")
		web := f.feature(owner, "WEB", "Payments").Feature.ID
		task := f.task(owner, web, "Charge the card", "build")
		f.claim(builder, task.Key, timeout(time.Minute))

		// Only the holder may let a question block a held Task.
		_, err := f.svc.FileTask(ctx, other, core.NewTask{Title: "Why?", AimedAt: ptrStr("boss"), Blocks: &task.Key}, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		q, err := f.svc.FileTask(ctx, builder, core.NewTask{Title: "Which provider?", AimedAt: ptrStr("boss"), Blocks: &task.Key}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if q.Task.FeatureID != web || q.Task.AimedAtID == nil || *q.Task.AimedAtID != boss.MemberID ||
			len(q.Blocking) != 1 || q.Blocking[0].ID != task.ID {
			t.Fatalf("question %+v blocking %+v", q.Task, q.Blocking)
		}
		held := f.get(task.Key)
		if !held.Task.Blocked || held.Task.Claim == nil || held.Task.Claim.HolderID != builder.MemberID {
			t.Fatalf("the asker's Task %+v", held.Task)
		}
		if hb, err := f.svc.Heartbeat(ctx, builder, task.Key); err != nil || hb.Status != "ok" {
			t.Fatalf("the asker's Heartbeat: %+v, %v", hb, err)
		}
		if !f.takeable(boss)[q.Task.ID] {
			t.Fatal("the Member asked cannot take the question from another Team")
		}
		f.claim(boss, q.Task.Key, noTimeout)
		f.complete(boss, q.Task.Key)
		if f.get(task.Key).Task.Blocked {
			t.Fatal("the Task is still blocked after its question was answered")
		}

		// A question names the Feature of the Task it blocks, or none; it blocks open Tasks only.
		_, err = f.svc.FileTask(ctx, builder, core.NewTask{Feature: ptrStr(f.feature(owner, "WEB", "Elsewhere").Feature.Key),
			Title: "Q", Skill: ptrStr("build"), Blocks: &task.Key}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.FileTask(ctx, builder, core.NewTask{Title: "Q", Skill: ptrStr("build"), Blocks: &q.Task.Key}, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.blocker_added" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// A question on an ended Feature stays open only while it blocks an open Task (ADR 0010): removing
// its last such edge is refused with ended, and the question is completed or dropped instead. While
// it still blocks another open Task, or once it has ended, its edges come off as any other.
func TestUnblockingAQuestionOnAnEndedFeature(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown, "build"})
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		f.member("builder", []string{"WEB"}, []string{"build"})
		fd := f.feature(owner, "WEB", "Search")
		f.claim(owner, fd.Tasks[0].Key, noTimeout)
		f.complete(owner, fd.Tasks[0].Key)
		shipped, err := f.svc.ShipFeature(ctx, owner, fd.Feature.Key, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		r := shipped.Tasks[len(shipped.Tasks)-1]
		f.claim(retro, r.Key, noTimeout)
		q, err := f.svc.FileTask(ctx, retro, core.NewTask{Title: "Why was search slow?", AimedAt: ptrStr("builder"), Blocks: &r.Key}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}

		// The question's one edge: removing it would leave an open Task on a shipped Feature that
		// blocks nothing.
		err = f.svc.RemoveBlocker(ctx, retro, r.Key, q.Task.Key, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		if !strings.Contains(err.Error(), "complete or drop "+q.Task.Key) {
			t.Fatalf("the refusal does not say what to do instead: %v", err)
		}
		if got := f.get(r.Key); !got.Task.Blocked || len(got.Blockers) != 1 {
			t.Fatalf("the refused unblock changed the Retrospective: %+v", got.Task)
		}

		// While it also blocks an open Task elsewhere, the edge to the Retrospective comes off; the
		// last one does not.
		other := f.task(owner, f.feature(owner, "WEB", "Next").Feature.ID, "Other", "build")
		if err := f.svc.AddBlocker(ctx, owner, other.Key, q.Task.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.RemoveBlocker(ctx, retro, r.Key, q.Task.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.svc.RemoveBlocker(ctx, owner, other.Key, q.Task.Key, core.Idem{}), core.CodeEnded)

		// Once the question has ended, its edges come off freely.
		if _, err := f.svc.DropTask(ctx, owner, q.Task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.RemoveBlocker(ctx, owner, other.Key, q.Task.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.kinds(q.Task.ID); got != "task.filed task.dropped" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Two opposite edges added at the same moment never both land: the cycle check runs after the
// counter, so the second sees the first (ADR 0011). Run with -count=20.
func TestRaceOppositeBlockEdges(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.team("WEB")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, nil)
		mates := []*auth.Caller{owner}
		for i := range 5 {
			mates = append(mates, f.member(name("mate", i), []string{"WEB"}, nil))
		}
		feature := f.feature(owner, "WEB", "Race").Feature.ID
		type edge struct{ task, blocker string }
		key := func(prefix string, i int) string { return f.task(owner, feature, name(prefix, i), "build").Key }
		// Each group would close a loop: two opposite edges, and the three edges of a triangle.
		var edges [][]edge
		for i := range 10 {
			a, b := key("a", i), key("b", i)
			x, y, z := key("x", i), key("y", i), key("z", i)
			edges = append(edges, []edge{{a, b}, {b, a}}, []edge{{x, y}, {y, z}, {z, x}})
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		results := make([][]error, len(edges))
		for i, group := range edges {
			results[i] = make([]error, len(group))
			for j, e := range group {
				c := mates[(i+j)%len(mates)]
				wg.Go(func() {
					<-start
					results[i][j] = f.svc.AddBlocker(t.Context(), c, e.task, e.blocker, core.Idem{})
				})
			}
		}
		close(start)
		wg.Wait()
		for i, group := range edges {
			landed := 0
			for _, err := range results[i] {
				switch {
				case err == nil:
					landed++
				case codeOf(err) == core.CodeCycle:
				default:
					t.Errorf("add blocker: %v", err)
				}
			}
			if landed != len(group)-1 {
				t.Errorf("%d of %d edges of a loop landed, want %d", landed, len(group), len(group)-1)
			}
		}
		// No loop anywhere in the edges that landed.
		if n := f.count(`WITH RECURSIVE up(start, id) AS (
	SELECT task_id, blocker_task_id FROM blocks
	UNION
	SELECT up.start, b.blocker_task_id FROM blocks b JOIN up ON b.task_id = up.id
) SELECT COUNT(*) FROM up WHERE start = id`); n != 0 {
			t.Fatalf("%d Tasks block themselves", n)
		}
		f.checkActivity()
	})
}
