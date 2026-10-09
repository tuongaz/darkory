package core_test

import (
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Every branch of the Takeable rule, and its negative, through the takeable list and the claim,
// which share one SQL fragment.
func TestTakeableRule(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("API")
		f.skill("build")
		f.skill("qa")
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", inWork(core.WorkflowsInput{Steps: []core.StepInput{
			{Name: "Backlog"}, {Name: "Plan", Skill: ptrStr(core.SkillBreakdown)}, {Name: "Build", Skill: ptrStr("build")},
			{Name: "QA", Skill: ptrStr("qa")}, {Name: "Skill review", Skill: ptrStr(core.SkillSkillReview)},
		}}), core.Idem{}); err != nil {
			t.Fatal(err)
		}
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		apiBuilder := f.member("api-builder", []string{"API"}, []string{"build"})
		reviewer := f.member("reviewer", []string{"API"}, []string{core.SkillSkillReview})
		noSkill := f.member("no-skill", []string{"WEB"}, nil)

		pd := f.parent(owner, "WEB", "Sign-up page")
		p := pd.Task
		breakdown := pd.Subtasks[0]
		if breakdown.Kind != "breakdown" || breakdown.Title != "Break down: Sign-up page" || breakdown.Key != "WEB-2" || p.Key != "WEB-1" ||
			breakdown.StepID == nil || *breakdown.StepID != f.step("WEB", "Plan") {
			t.Fatalf("Breakdown filed as %+v under %+v", breakdown, p)
		}
		build := f.subtask(owner, p.ID, "Build the form", "Build")
		aimed := f.fileTask(owner, core.NewTask{Parent: &p.ID, Title: "Which provider?", AimedAt: ptrStr("api-builder")}).Task
		review := f.subtask(owner, p.ID, "Review the qa Skill", "Skill review")
		qa := f.subtask(owner, p.ID, "Test the form", "QA")
		hold := f.subtask(owner, p.ID, "Some day", "Backlog")

		cases := []struct {
			name   string
			caller *auth.Caller
			task   core.Task
			want   bool
		}{
			{"at a Step whose Skill the caller has, in the caller's Project", builder, build, true},
			{"same Skill, other Project", apiBuilder, build, false},
			{"caller's Project, Skill missing", noSkill, build, false},
			{"the Owner, while a Member of the Project has the Skill", owner, build, false},
			{"aimed at the caller, in another Project", apiBuilder, aimed, true},
			{"aimed at someone else", builder, aimed, false},
			{"skill-review from another Project", reviewer, review, true},
			{"skill-review without the Skill", builder, review, false},
			{"the Owner, while a Member of another Project has skill-review", owner, review, false},
			{"the Owner, when no Member of the Project has the Skill", owner, qa, true},
			{"not the Owner, when no Member of the Project has the Skill", noSkill, qa, false},
			{"the Owner falls back to the Breakdown too", owner, breakdown, true},
			{"a Breakdown needs the breakdown Skill", builder, breakdown, false},
			{"a hold offers its Tasks to no one", builder, hold, false},
			{"a hold offers its Tasks to no one, the Owner included", owner, hold, false},
			{"a Parent is never takeable", owner, p, false},
		}
		for _, tc := range cases {
			if got := f.takeable(tc.caller)[tc.task.ID]; got != tc.want {
				t.Errorf("%s: takeable = %v, want %v", tc.name, got, tc.want)
			}
		}

		// The Owner's fallback ends once a Member of the Project has the Skill.
		if err := f.svc.GrantSkill(ctx, f.admin, "no-skill", "qa", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.takeable(owner)[qa.ID] {
			t.Error("the Owner can still take a Task the Project now has the Skill for")
		}
		if !f.takeable(noSkill)[qa.ID] {
			t.Error("a Project Member granted the Skill cannot take the Task")
		}

		// A claim refused by the rule says not_takeable; one allowed succeeds.
		_, err := f.svc.Claim(ctx, apiBuilder, build.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		_, err = f.svc.Claim(ctx, owner, p.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if _, err := f.svc.Claim(ctx, reviewer, review.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatalf("skill-review across Projects: %v", err)
		}
		if _, err := f.svc.Claim(ctx, apiBuilder, aimed.ID, noTimeout, core.Idem{}); err != nil {
			t.Fatalf("aimed at the caller: %v", err)
		}

		// A Step's Skill may change: the Tasks at it keep their place, and the rule reads the new
		// Skill.
		w, err := f.svc.GetWorkflow(ctx, f.admin, "WEB")
		if err != nil {
			t.Fatal(err)
		}
		in := core.WorkflowsInput{Workflows: []core.WorkflowInput{{Name: core.WorkflowFirstName, Position: 1}}}
		for _, s := range w.Steps {
			si := core.StepInput{ID: s.ID, Workflow: s.WorkflowID, Name: s.Name, Skill: s.SkillID, Position: s.Position}
			if s.Name == "Build" {
				si.Skill = ptrStr("qa")
			}
			in.Steps = append(in.Steps, si)
		}
		if _, err := f.svc.SetWorkflow(ctx, f.admin, "WEB", in, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.takeable(builder)[build.ID] || !f.takeable(noSkill)[build.ID] {
			t.Error("the Takeable rule does not read the Step's new Skill")
		}
		f.checkActivity()
	})
}

// A Task with an open blocker is not takeable; when the blocker ends it is. Among Tasks of one
// Rank, those that block another come first in `next`'s order.
func TestBlockedTasksAreNotTakeable(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.skill("build")
		f.chain("WEB", [2]string{"Build", "build"})
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		p := f.task(builder, "WEB", "Checkout", "Build")
		blocked := f.subtask(builder, p.ID, "Pay", "Build")
		other := f.subtask(builder, p.ID, "Ship", "Build")
		blocker := f.subtask(builder, p.ID, "Ask about tax", "Build")
		f.exec(`INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ($1, $2, $3, $4, 0)`,
			builder.OrgID, blocked.ID, blocker.ID, builder.MemberID)

		list, err := f.svc.ListTakeable(ctx, builder, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != 2 || list[0].ID != blocker.ID || list[1].ID != other.ID {
			t.Fatalf("takeable %v, want the blocker, then the other", keys(list))
		}
		got, err := f.svc.GetTask(ctx, builder, blocked.Key)
		if err != nil {
			t.Fatal(err)
		}
		if !got.Task.Blocked || len(got.Blockers) != 1 || got.Blockers[0].ID != blocker.ID || len(got.Task.OpenBlockers) != 1 ||
			got.Task.OpenBlockers[0].Title != "Ask about tax" {
			t.Fatalf("blocked Task reads %+v", got.Task)
		}
		_, err = f.svc.Claim(ctx, builder, blocked.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)

		// `next` offers the blocker first even though it was filed after the others.
		d, ok, err := f.svc.Next(ctx, builder, 0, noTimeout, core.Idem{})
		if err != nil || !ok || d.Task.ID != blocker.ID {
			t.Fatalf("next = %v %v %v, want the blocker", d.Task.Key, ok, err)
		}
		if _, err := f.svc.Complete(ctx, builder, blocker.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if !f.takeable(builder)[blocked.ID] {
			t.Fatal("the Task is still not takeable after its blocker ended")
		}
	})
}

// A Member who held a Task under one Skill can take it again only under that Skill, which the
// Claim recorded from the Task's Step.
func TestNoSelfReview(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		build := f.skill("build")
		review := f.skill("review-it")
		f.chain("WEB", [2]string{"Build", "build"}, [2]string{"Review", "review-it"})
		both := f.member("both", []string{"WEB"}, []string{"build", "review-it"})
		task := f.task(both, "WEB", "Index", "Review")
		other := f.task(both, "WEB", "Rank", "Review")

		// Seed past Claims as advancing from Build to Review would leave them.
		for _, id := range []string{task.ID, other.ID} {
			f.exec(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, started_at, ended_at, how_ended)
VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 1, 'advanced')`, store.NewID(), both.OrgID, id, both.MemberID, both.SessionID, build)
		}
		// Having also held it under review, as when a review was released, does not help.
		f.exec(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, started_at, ended_at, how_ended)
VALUES ($1, $2, $3, $4, $5, $6, 1, 2, 3, 'released')`, store.NewID(), both.OrgID, task.ID, both.MemberID, both.SessionID, review)

		if f.takeable(both)[task.ID] || f.takeable(both)[other.ID] {
			t.Fatal("the builder may review their own work")
		}
		_, err := f.svc.Claim(ctx, both, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)

		// Under the Skill they held it with, they may take it again.
		again := f.task(both, "WEB", "Tune", "Build")
		f.exec(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, started_at, ended_at, how_ended)
VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 1, 'released')`, store.NewID(), both.OrgID, again.ID, both.MemberID, both.SessionID, build)
		if _, err := f.svc.Claim(ctx, both, again.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatalf("claim under the same Skill: %v", err)
		}
	})
}

func keys(ts []core.Task) []string {
	var out []string
	for _, t := range ts {
		out = append(out, t.Key)
	}
	return out
}
