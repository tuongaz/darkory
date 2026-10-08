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
// may cross Parents and Projects; one that would close a loop is refused, and a Parent neither
// blocks nor is blocked.
func TestBlocking(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		f.skill("build")
		f.chain("WEB", [2]string{"Build", "build"})
		f.chain("API", [2]string{"Build", "build"})
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB", "API"}, []string{"build"})
		outsider := f.member("outsider", []string{"API"}, nil)
		a := f.task(owner, "WEB", "A", "Build")
		b := f.task(owner, "WEB", "B", "Build")
		c := f.task(outsider, "API", "C in another Project", "Build")

		// A Project Member and the Task's Owner may shape a Task nobody holds; others may not.
		err := f.svc.AddBlocker(ctx, outsider, a.Key, b.Key, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if err := f.svc.AddBlocker(ctx, builder, a.Key, b.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddBlocker(ctx, owner, a.Key, c.Key, core.Idem{}); err != nil {
			t.Fatalf("a blocker in another Project: %v", err)
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
		d := f.task(owner, "WEB", "D", "Build")
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
		list, err := f.svc.ListTasks(ctx, owner, core.TaskFilter{Project: ptrStr("WEB")})
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range list.Items {
			if task.ID == a.ID && len(task.OpenBlockers) != 2 {
				t.Fatalf("the list names A's blockers as %+v", task.OpenBlockers)
			}
		}

		// A Parent neither blocks nor is blocked; nor does a Task in a Blocking become one.
		p := f.task(owner, "WEB", "P", "Build")
		f.subtask(owner, p.ID, "P's part", "Build")
		wantCode(t, f.svc.AddBlocker(ctx, owner, p.Key, b.Key, core.Idem{}), core.CodeConflict)
		wantCode(t, f.svc.AddBlocker(ctx, owner, b.Key, p.Key, core.Idem{}), core.CodeConflict)
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Parent: &a.Key, Title: "A's part", Step: ptrStr("Build")}, core.Idem{})
		wantCode(t, err, core.CodeConflict)

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
		e := f.task(owner, "WEB", "E", "Build")
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

// A stuck Member files a question aimed at someone above them, in another Project, and lets it
// block their Task: the question joins the Task's Parent, or stands alone in its Project beside a
// Task that has none; the asker keeps their Claim, and the Member asked takes it from their own
// Project.
func TestQuestionsAndEscalations(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("OPS")
		f.skill("build")
		f.chain("WEB", [2]string{"Build", "build"})
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		boss := f.member("boss", []string{"OPS"}, nil)
		other := f.member("other", []string{"WEB"}, []string{"build"})
		f.manager("builder", "boss")
		p := f.task(owner, "WEB", "Payments", "Build")
		task := f.subtask(owner, p.ID, "Charge the card", "Build")
		f.claim(builder, task.Key, timeout(time.Minute))

		// Only the holder may let a question block a held Task.
		_, err := f.svc.FileTask(ctx, other, core.NewTask{Title: "Why?", AimedAt: ptrStr("boss"), Blocks: &task.Key}, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		q, err := f.svc.FileTask(ctx, builder, core.NewTask{Title: "Which provider?", AimedAt: ptrStr("boss"), Blocks: &task.Key}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if q.Task.ParentID == nil || *q.Task.ParentID != p.ID || q.Task.StepID != nil || q.Task.AimedAtID == nil ||
			*q.Task.AimedAtID != boss.MemberID || q.Task.OwnerID != owner.MemberID || len(q.Blocking) != 1 || q.Blocking[0].ID != task.ID {
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
			t.Fatal("the Member asked cannot take the question from another Project")
		}
		f.claim(boss, q.Task.Key, noTimeout)
		f.complete(boss, q.Task.Key)
		if f.get(task.Key).Task.Blocked {
			t.Fatal("the Task is still blocked after its question was answered")
		}

		// Beside a Task with no Parent, the question stands alone in its Project.
		alone := f.task(owner, "WEB", "Refunds", "Build")
		f.claim(builder, alone.Key, noTimeout)
		q2, err := f.svc.FileTask(ctx, builder, core.NewTask{Title: "Partial refunds?", AimedAt: ptrStr("boss"), Blocks: &alone.Key}, core.Idem{})
		if err != nil || q2.Task.ParentID != nil || q2.Task.ProjectID != alone.ProjectID || q2.Task.Rank == nil || q2.Task.OwnerID != builder.MemberID {
			t.Fatalf("the question beside a Task with no Parent: %+v, %v", q2.Task, err)
		}

		// A question names the Parent of the Task it blocks, or none; it blocks open Tasks only.
		elsewhere := f.task(owner, "WEB", "Elsewhere", "Build")
		f.subtask(owner, elsewhere.ID, "Elsewhere's part", "Build")
		_, err = f.svc.FileTask(ctx, builder, core.NewTask{Parent: &elsewhere.Key, Title: "Q", Blocks: &task.Key}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.FileTask(ctx, builder, core.NewTask{Title: "Q", Blocks: &q.Task.Key}, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.blocker_added" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// A question under an ended Parent stays open only while it blocks an open Task (ADR 0010):
// removing its last such edge is refused with ended, and the question is completed or dropped
// instead. While it still blocks another open Task, or once it has ended, its edges come off as
// any other.
func TestUnblockingAQuestionUnderAnEndedParent(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown, core.SkillEngineer})
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		pd := f.parent(owner, "WEB", "Search")
		f.claim(owner, pd.Subtasks[0].Key, noTimeout)
		f.complete(owner, pd.Subtasks[0].Key)
		f.complete(owner, pd.Task.Key)
		subs := f.get(pd.Task.Key).Subtasks
		r := subs[len(subs)-1]
		f.claim(retro, r.Key, noTimeout)
		q, err := f.svc.FileTask(ctx, retro, core.NewTask{Title: "Why was search slow?", AimedAt: ptrStr("builder"), Blocks: &r.Key}, core.Idem{})
		if err != nil || q.Task.ParentID == nil || *q.Task.ParentID != pd.Task.ID {
			t.Fatalf("the question %+v, %v", q.Task, err)
		}

		// The question's one edge: removing it would leave an open Task under a done Parent that
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
		other := f.task(owner, "WEB", "Other", "Build")
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
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		mates := []*auth.Caller{owner}
		for i := range 5 {
			mates = append(mates, f.member(name("mate", i), []string{"WEB"}, nil))
		}
		type edge struct{ task, blocker string }
		key := func(prefix string, i int) string { return f.task(owner, "WEB", name(prefix, i), "Build").Key }
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

// A Task filed with blocked_by is blocked from its first moment, in the filing's write, so it is
// never takeable before its blockers end; a Parent cannot block or be filed blocked, and a blocker
// that the new Task would itself block, directly or through others, is refused as a loop.
func TestFileBlocked(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.skill("build")
		f.chain("WEB", [2]string{"Backlog", ""}, [2]string{"Build", "build"})
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		p := f.task(owner, "WEB", "Checkout", "Build")
		design := f.subtask(owner, p.ID, "Design", "Build")
		keys := f.subtask(owner, p.ID, "Keys", "Build")

		build := "Build"
		before := f.checkActivity()
		slice := f.fileTask(owner, core.NewTask{Parent: &p.ID, Title: "Limits", Step: &build, BlockedBy: []string{design.Key, keys.ID, design.Key}})
		if !slice.Task.Blocked || len(slice.Task.OpenBlockers) != 2 {
			t.Fatalf("filed with blockers: %+v", slice.Task.OpenBlockers)
		}
		if f.takeable(builder)[slice.Task.ID] {
			t.Fatal("a Task filed blocked is takeable")
		}
		if got := f.checkActivity() - before; got != 3 {
			t.Fatalf("Activity entries for the filing: %d, want task.filed and two task.blocker_added", got)
		}

		// Once its blockers end, it is takeable.
		for _, b := range []core.Task{design, keys} {
			if _, err := f.svc.DropTask(ctx, owner, b.Key, nil, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		if !f.takeable(builder)[slice.Task.ID] {
			t.Fatal("still not takeable after its blockers ended")
		}

		// A Parent neither blocks nor is filed blocked.
		web := "WEB"
		_, err := f.svc.FileTask(ctx, owner, core.NewTask{Project: &web, Title: "Under a Parent", Step: &build, BlockedBy: []string{p.Key}}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Project: &web, Title: "Broken down", Breakdown: true, BlockedBy: []string{slice.Task.Key}}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		// A question that blocks a Task cannot also be blocked by it, nor by what that Task blocks.
		a := f.task(owner, "WEB", "A", "Build")
		b := f.task(owner, "WEB", "B", "Build")
		if err := f.svc.AddBlocker(ctx, owner, b.Key, a.Key, core.Idem{}); err != nil { // A blocks B
			t.Fatal(err)
		}
		member := "owner"
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Title: "Question", Blocks: &a.Key, AimedAt: &member, BlockedBy: []string{a.Key}}, core.Idem{})
		wantCode(t, err, core.CodeCycle)
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Title: "Question", Blocks: &a.Key, AimedAt: &member, BlockedBy: []string{b.Key}}, core.Idem{})
		wantCode(t, err, core.CodeCycle)
	})
}
