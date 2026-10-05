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
		f.team("WEB")
		f.team("API")
		f.skill("build")
		f.skill("qa")
		owner := f.member("owner", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		apiBuilder := f.member("api-builder", []string{"API"}, []string{"build"})
		reviewer := f.member("reviewer", []string{"API"}, []string{core.SkillSkillReview})
		noSkill := f.member("no-skill", []string{"WEB"}, nil)

		feat := f.feature(owner, "WEB", "Sign-up page")
		breakdown := feat.Tasks[0]
		if breakdown.Kind != "breakdown" || breakdown.Title != "Break down: Sign-up page" || breakdown.Key != "WEB-2" || feat.Feature.Key != "WEB-1" {
			t.Fatalf("Break down filed as %+v on %+v", breakdown, feat.Feature)
		}
		fid := feat.Feature.ID
		build := f.task(owner, fid, "Build the form", "build")
		aimed := f.aimed(owner, fid, "Which provider?", "api-builder")
		review := f.task(owner, fid, "Review the qa Skill", core.SkillSkillReview)
		qa := f.task(owner, fid, "Test the form", "qa")

		cases := []struct {
			name   string
			caller *auth.Caller
			task   core.Task
			want   bool
		}{
			{"needs a Skill the caller has, in the caller's Team", builder, build, true},
			{"same Skill, other Team", apiBuilder, build, false},
			{"caller's Team, Skill missing", noSkill, build, false},
			{"the owner, while a Member of the Team has the Skill", owner, build, false},
			{"aimed at the caller, in another Team", apiBuilder, aimed, true},
			{"aimed at someone else", builder, aimed, false},
			{"skill-review from another Team", reviewer, review, true},
			{"skill-review without the Skill", builder, review, false},
			{"the owner, while a Member of another Team has skill-review", owner, review, false},
			{"the owner, when no Member of the Team has the Skill", owner, qa, true},
			{"not the owner, when no Member of the Team has the Skill", noSkill, qa, false},
			{"the owner falls back to the Break down too", owner, breakdown, true},
			{"a Break down needs the breakdown Skill", builder, breakdown, false},
		}
		for _, tc := range cases {
			if got := f.takeable(tc.caller)[tc.task.ID]; got != tc.want {
				t.Errorf("%s: takeable = %v, want %v", tc.name, got, tc.want)
			}
		}

		// The owner's fallback ends once a Member of the Team has the Skill.
		if err := f.svc.GrantSkill(ctx, f.admin, "no-skill", "qa", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if f.takeable(owner)[qa.ID] {
			t.Error("the owner can still take a Task the Team now has the Skill for")
		}
		if !f.takeable(noSkill)[qa.ID] {
			t.Error("a Team Member granted the Skill cannot take the Task")
		}

		// A claim refused by the rule says not_takeable; one allowed succeeds.
		_, err := f.svc.Claim(ctx, apiBuilder, build.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if _, err := f.svc.Claim(ctx, reviewer, review.Key, noTimeout, core.Idem{}); err != nil {
			t.Fatalf("skill-review across Teams: %v", err)
		}
		if _, err := f.svc.Claim(ctx, apiBuilder, aimed.ID, noTimeout, core.Idem{}); err != nil {
			t.Fatalf("aimed at the caller: %v", err)
		}
		f.checkActivity()
	})
}

// A Task with an open blocker is not takeable; when the blocker ends it is. Tasks that block
// another come first in `next`'s order.
func TestBlockedTasksAreNotTakeable(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		feat := f.feature(builder, "WEB", "Checkout")
		blocked := f.task(builder, feat.Feature.ID, "Pay", "build")
		blocker := f.task(builder, feat.Feature.ID, "Ask about tax", "build")
		f.exec(`INSERT INTO blocks (org_id, task_id, blocker_task_id, added_by, added_at) VALUES ($1, $2, $3, $4, 0)`,
			builder.OrgID, blocked.ID, blocker.ID, builder.MemberID)

		list, err := f.svc.ListTakeable(ctx, builder, 0)
		if err != nil {
			t.Fatal(err)
		}
		// The builder filed the Feature, so it also owns the Break down nobody in WEB can take.
		if len(list) != 2 || list[0].ID != blocker.ID || list[1].Kind != "breakdown" {
			t.Fatalf("takeable %v, want the blocker, then the Break down", keys(list))
		}
		got, err := f.svc.GetTask(ctx, builder, blocked.Key)
		if err != nil {
			t.Fatal(err)
		}
		if !got.Task.Blocked || len(got.Blockers) != 1 || got.Blockers[0].ID != blocker.ID {
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

// A Member who held a Task under one Skill can take it again only under that Skill.
func TestNoSelfReview(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		build := f.skill("build")
		f.skill("review")
		both := f.member("both", []string{"WEB"}, []string{"build", "review"})
		feat := f.feature(both, "WEB", "Search")
		task := f.task(both, feat.Feature.ID, "Index", "review")
		other := f.task(both, feat.Feature.ID, "Rank", "review")

		// Seed past Claims as a Handover from build to review would leave them.
		for _, id := range []string{task.ID, other.ID} {
			f.exec(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, started_at, ended_at, how_ended)
VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 1, 'handed_over')`, store.NewID(), both.OrgID, id, both.MemberID, both.SessionID, build)
		}
		// Having also held it under review, as when a review was released, does not help.
		f.exec(`INSERT INTO claims (id, org_id, task_id, holder_id, session_id, skill_id, skill_version, started_at, ended_at, how_ended)
SELECT $1, org_id, id, $2, $3, skill_id, 1, 2, 3, 'released' FROM tasks WHERE id = $4`, store.NewID(), both.MemberID, both.SessionID, task.ID)

		if f.takeable(both)[task.ID] || f.takeable(both)[other.ID] {
			t.Fatal("the builder may review their own work")
		}
		_, err := f.svc.Claim(ctx, both, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)

		// Under the Skill they held it with, they may take it again.
		again := f.task(both, feat.Feature.ID, "Tune", "build")
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
