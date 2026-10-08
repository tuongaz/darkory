package core_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// ranks lists the titles of the Project's Tasks with no Parent in Rank order, checking each
// holds its position.
func (f *fixture) ranks(project string) string {
	f.t.Helper()
	p, err := f.svc.ListTasks(f.t.Context(), f.admin, core.TaskFilter{Project: &project, Filters: []string{"top:is:true"}})
	if err != nil {
		f.t.Fatal(err)
	}
	var out []string
	for i, t := range p.Items {
		if t.Rank == nil || *t.Rank != int64(i+1) {
			f.t.Fatalf("%s has rank %v at position %d", t.Title, t.Rank, i+1)
		}
		out = append(out, t.Title)
	}
	return strings.Join(out, " ")
}

// Rank: a Task with no Parent moves to any position in its Project's Rank, by a Member of the
// Project or its Owner; ended Tasks keep their places; a Subtask sorts by its Parent's.
func TestRankTask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		lead := f.member("lead", []string{"WEB"}, nil)
		outsider := f.member("outsider", []string{"API"}, nil)
		var keys []string
		for _, title := range []string{"A", "B", "C", "D"} {
			keys = append(keys, f.task(lead, "WEB", title, "Build").Key)
		}
		sub := f.subtask(lead, keys[0], "A's part", "Build")
		if sub.Rank != nil {
			t.Fatalf("a Subtask has rank %d", *sub.Rank)
		}
		_, err := f.svc.RankTask(ctx, outsider, keys[3], 1, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.RankTask(ctx, lead, keys[3], 0, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.RankTask(ctx, lead, sub.Key, 1, core.Idem{})
		wantCode(t, err, core.CodeUseParent)

		moved, err := f.svc.RankTask(ctx, lead, keys[3], 1, core.Idem{})
		if err != nil || *moved.Rank != 1 {
			t.Fatalf("moved %+v, %v", moved, err)
		}
		if got := f.ranks("WEB"); got != "D A B C" {
			t.Fatalf("Rank %s", got)
		}
		// B is dropped and keeps its place; moving past the end moves last.
		if _, err := f.svc.DropTask(ctx, lead, keys[1], nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.RankTask(ctx, lead, keys[3], 99, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.ranks("WEB"); got != "A B C D" {
			t.Fatalf("Rank %s", got)
		}
		if _, err := f.svc.RankTask(ctx, lead, keys[2], 2, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.ranks("WEB"); got != "A C B D" {
			t.Fatalf("Rank %s", got)
		}
		before := f.checkActivity()
		if _, err := f.svc.RankTask(ctx, lead, keys[2], 2, core.Idem{}); err != nil || f.checkActivity() != before {
			t.Fatalf("a move to the same place wrote Activity: %v", err)
		}
		if got := f.kinds(moved.ID); got != "task.filed task.ranked task.ranked" {
			t.Fatalf("Activity: %s", got)
		}
		// The list puts each Subtask after its Parent.
		all, err := f.svc.ListTasks(ctx, f.admin, core.TaskFilter{Project: ptrStr("WEB")})
		if err != nil {
			t.Fatal(err)
		}
		var titles []string
		for _, task := range all.Items {
			titles = append(titles, task.Title)
		}
		if got := strings.Join(titles, ", "); got != "A, A's part, C, B, D" {
			t.Fatalf("listed %s", got)
		}
	})
}

// Complete for a Parent: by its Owner only, once every Subtask has ended (tasks_open otherwise);
// it files the Retrospective at the Workflow's retro Step. An ended Parent takes no new Subtask
// but the questions that block its Subtasks.
func TestCompleteParent(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown})
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		pd := f.parent(owner, "WEB", "Search")
		task := f.subtask(owner, pd.Task.ID, "Index", "Build")
		f.chainBuildIntoDone("WEB")

		_, err := f.svc.Complete(ctx, owner, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeTasksOpen)
		f.claim(owner, pd.Subtasks[0].Key, noTimeout)
		f.complete(owner, pd.Subtasks[0].Key)
		f.claim(builder, task.Key, noTimeout)
		f.complete(builder, task.Key)
		_, err = f.svc.Complete(ctx, builder, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		done, err := f.svc.Complete(ctx, owner, pd.Task.Key, ptrStr("shipped it"), core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		d := f.get(pd.Task.Key)
		if done.State != "done" || done.EndedAt == nil || len(d.Subtasks) != 3 || len(d.Notes) != 1 {
			t.Fatalf("completed %+v with %d Subtasks, Notes %+v", done, len(d.Subtasks), d.Notes)
		}
		r := d.Subtasks[2]
		if r.Kind != "retrospective" || r.Title != "Retrospective: Search" || r.State != "open" || r.SkillID == nil ||
			*r.SkillID != f.skillID(core.SkillRetro) || r.FiledBy != nil || r.OwnerID != owner.MemberID {
			t.Fatalf("Retrospective %+v", r)
		}
		if c := d.Task.SubtaskCounts; c == nil || c.Open != 1 || c.Done != 2 || c.Dropped != 0 || c.Working != 0 {
			t.Fatalf("counts %+v", c)
		}
		var actor *string
		if err := st.QueryRow(ctx, `SELECT actor_id FROM activity WHERE subject_id = $1 AND kind = 'task.filed'`, r.ID).Scan(&actor); err != nil || actor != nil {
			t.Fatalf("the Retrospective was filed by %v (%v); Darkory's own filings have no actor", actor, err)
		}
		_, err = f.svc.Complete(ctx, owner, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		_, err = f.svc.DropTask(ctx, owner, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeEnded)

		// Only the Retrospective and questions blocking a Subtask may be open under an ended Parent.
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Parent: &pd.Task.Key, Title: "More work", Step: ptrStr("Build")}, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		f.claim(retro, r.Key, noTimeout)
		q, err := f.svc.FileTask(ctx, retro, core.NewTask{Title: "Why was search slow?", AimedAt: ptrStr("builder"), Blocks: &r.Key}, core.Idem{})
		if err != nil || q.Task.ParentID == nil || *q.Task.ParentID != pd.Task.ID {
			t.Fatalf("a question under an ended Parent: %+v, %v", q.Task, err)
		}
		if got := f.kinds(pd.Task.ID); got != "task.filed task.note_added task.completed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// chainBuildIntoDone gives the Project's Build Step a way into Done ("done") beside the default's.
func (f *fixture) chainBuildIntoDone(project string) {
	f.t.Helper()
	f.exec(`INSERT INTO connectors (id, org_id, project_id, from_step_id, to_step_id, name, position, created_at)
SELECT $1, st.org_id, st.project_id, st.id, NULL, 'done', 2, 0 FROM steps st JOIN projects p ON p.id = st.project_id
WHERE p.key_prefix = $2 AND st.name = 'Build'`, store.NewID(), project)
}

// Dropping a Parent drops its open Subtasks and ends their Claims; a late holder's Heartbeat says
// the Claim ended. The Retrospective is filed all the same.
func TestDropParentCascades(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.chainBuildIntoDone("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{core.SkillEngineer})
		pd := f.parent(owner, "WEB", "Chat")
		held := f.subtask(owner, pd.Task.ID, "Held", "Build")
		lapsing := f.subtask(owner, pd.Task.ID, "Lapsing", "Build")
		done := f.subtask(owner, pd.Task.ID, "Done", "Build")
		f.claim(builder, done.Key, noTimeout)
		f.complete(builder, done.Key)
		f.claim(builder, lapsing.Key, timeout(time.Minute))
		f.clock.Advance(2 * time.Minute)
		f.claim(builder, held.Key, timeout(time.Minute))
		_, err := f.svc.DropTask(ctx, builder, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		dropped, err := f.svc.DropTask(ctx, owner, pd.Task.Key, ptrStr("not now"), core.Idem{})
		if err != nil || dropped.State != "dropped" {
			t.Fatalf("dropped %+v, %v", dropped, err)
		}
		states := map[string]string{}
		for _, task := range f.get(pd.Task.Key).Subtasks {
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
		// A Task without Subtasks files no Retrospective when it ends.
		alone := f.task(owner, "WEB", "Alone", "Build")
		if _, err := f.svc.DropTask(ctx, owner, alone.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.count(`SELECT COUNT(*) FROM tasks WHERE parent_id = $1`, alone.ID); n != 0 {
			t.Fatalf("a dropped Task without Subtasks has %d", n)
		}
		f.checkActivity()
	})
}

// The Owner's Complete and filing a Subtask race through the counter: either the Subtask lands
// first and the Complete is refused, or the Complete lands first and the filing is refused. Never
// a done Parent with an open Subtask beside its Retrospective.
func TestRaceCompleteParentAgainstFilingASubtask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown})
		filer := f.member("filer", []string{"WEB"}, nil)
		outcomes := map[string]int{}
		for i := range 10 {
			pd := f.parent(owner, "WEB", name("race", i))
			f.claim(owner, pd.Subtasks[0].Key, noTimeout)
			f.complete(owner, pd.Subtasks[0].Key)
			var completeErr, fileErr error
			var wg sync.WaitGroup
			start := make(chan struct{})
			wg.Go(func() {
				<-start
				_, completeErr = f.svc.Complete(ctx, owner, pd.Task.Key, nil, core.Idem{})
			})
			wg.Go(func() {
				<-start
				_, fileErr = f.svc.FileTask(ctx, filer, core.NewTask{Parent: &pd.Task.Key, Title: "Late", Step: ptrStr("Build")}, core.Idem{})
			})
			close(start)
			wg.Wait()
			switch {
			case completeErr == nil && codeOf(fileErr) == core.CodeEnded:
				outcomes["completed first"]++
			case fileErr == nil && codeOf(completeErr) == core.CodeTasksOpen:
				outcomes["filed first"]++
			default:
				t.Fatalf("complete: %v; file: %v", completeErr, fileErr)
			}
		}
		if n := f.count(`SELECT COUNT(*) FROM tasks t JOIN tasks p ON p.id = t.parent_id
WHERE p.state <> 'open' AND t.state = 'open' AND t.kind <> 'retrospective'`); n != 0 {
			t.Fatalf("%d open Subtasks under ended Parents", n)
		}
		t.Logf("outcomes %v", outcomes)
		f.checkActivity()
	})
}

// Owner: ownership of a Task with no Parent passes by its Owner or someone above them on their
// Reporting line, and its Subtasks' with it in one write; a Subtask's cannot be set (use_parent).
func TestPassOwnership(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		boss := f.member("boss", nil, nil)
		peer := f.member("peer", []string{"WEB"}, nil)
		f.manager("owner", "boss")
		pd := f.parent(owner, "WEB", "Billing")
		sub := f.subtask(owner, pd.Task.ID, "Invoices", "Build")
		_, err := f.svc.PassOwnership(ctx, peer, pd.Task.Key, "peer", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.PassOwnership(ctx, owner, sub.Key, "peer", core.Idem{})
		wantCode(t, err, core.CodeUseParent)
		_, err = f.svc.FileTask(ctx, owner, core.NewTask{Parent: &pd.Task.Key, Title: "x", Owner: ptrStr("peer")}, core.Idem{})
		wantCode(t, err, core.CodeUseParent)
		got, err := f.svc.PassOwnership(ctx, owner, pd.Task.Key, "peer", core.Idem{})
		if err != nil || got.OwnerID != peer.MemberID {
			t.Fatalf("passed %+v, %v", got, err)
		}
		for _, s := range f.get(pd.Task.Key).Subtasks {
			if s.OwnerID != peer.MemberID {
				t.Fatalf("Subtask %s is still owned by %s", s.Key, s.OwnerID)
			}
		}
		// boss is no longer above the Owner, so cannot take it back; the new Owner passes it on.
		_, err = f.svc.PassOwnership(ctx, boss, pd.Task.Key, "boss", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		f.manager("peer", "boss")
		got, err = f.svc.PassOwnership(ctx, boss, pd.Task.Key, "owner", core.Idem{})
		if err != nil || got.OwnerID != owner.MemberID {
			t.Fatalf("taken back up the line %+v, %v", got, err)
		}
		_, err = f.svc.DropTask(ctx, peer, pd.Task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if got := f.kinds(pd.Task.ID); got != "task.filed task.owner_passed task.owner_passed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// When nobody in the Project has breakdown or retro, the Owner takes the Breakdown and the
// Retrospective (ADR 0010).
func TestOwnerFallbackForBreakdownAndRetrospective(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		mate := f.member("mate", []string{"WEB"}, nil)
		pd := f.parent(owner, "WEB", "Docs")
		breakdown := pd.Subtasks[0]
		if !f.takeable(owner)[breakdown.ID] || f.takeable(mate)[breakdown.ID] {
			t.Fatal("the Breakdown does not fall to the Owner alone")
		}
		f.claim(owner, breakdown.Key, noTimeout)
		f.complete(owner, breakdown.Key)
		f.complete(owner, pd.Task.Key)
		retro := f.get(pd.Task.Key).Subtasks[1]
		if !f.takeable(owner)[retro.ID] || f.takeable(mate)[retro.ID] {
			t.Fatal("the Retrospective does not fall to the Owner alone")
		}
		// Once a Member of the Project has retro, the fallback ends.
		if err := f.svc.GrantSkill(t.Context(), f.admin, "mate", core.SkillRetro, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.takeable(owner)[retro.ID] || !f.takeable(mate)[retro.ID] {
			t.Fatal("the fallback holds while the Project has the Skill")
		}
	})
}

// An ended Parent keeps its Rank, and `next` offers its Retrospective by it, ahead of a
// Retrospective filed earlier under a Parent ranked lower.
func TestRetrospectiveSortsByTheEndedParentsRank(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		owner := f.member("owner", []string{"WEB"}, nil)
		retro := f.member("retro", []string{"WEB"}, []string{core.SkillRetro})
		first := f.parent(owner, "WEB", "First")
		second := f.parent(owner, "WEB", "Second")
		if _, err := f.svc.DropTask(ctx, owner, second.Task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.clock.Advance(time.Minute)
		if _, err := f.svc.DropTask(ctx, owner, first.Task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.ranks("WEB"); got != "First Second" {
			t.Fatalf("Rank %s", got)
		}
		got, _ := f.svc.ListTakeable(ctx, retro, 0)
		if len(got) != 2 || got[0].Title != "Retrospective: First" {
			t.Fatalf("takeable %v", keys(got))
		}
		if _, err := f.svc.RankTask(ctx, owner, second.Task.Key, 1, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, ok, err := f.svc.Next(ctx, retro, 0, noTimeout, core.Idem{})
		if err != nil || !ok || d.Task.Title != "Retrospective: Second" {
			t.Fatalf("next %+v %v %v", d.Task, ok, err)
		}
	})
}
