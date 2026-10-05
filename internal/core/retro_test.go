package core_test

import (
	"testing"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// retroFixture is a shipped Feature whose build Task left an Observation, with its Retrospective
// open, a company Skill qa-acme at version 1, retro writers in WEB and a reviewer in OPS.
type retroFixture struct {
	*fixture
	owner, builder, retro, retro2, reviewer *auth.Caller
	feature                                 core.FeatureDetail
	retrospective                           core.Task
	observation                             core.Observation
}

func newRetroFixture(t *testing.T, st *store.Store) retroFixture {
	f := newFixture(t, st)
	ctx := t.Context()
	f.team("WEB")
	f.team("OPS")
	f.skill("build")
	f.skill("qa")
	if _, err := f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "qa-acme", Kind: "company", BaseSkill: ptrStr("qa"), Body: "Test the happy path."}, core.Idem{}); err != nil {
		t.Fatal(err)
	}
	r := retroFixture{fixture: f}
	r.owner = f.member("owner", []string{"WEB"}, []string{core.SkillBreakdown})
	r.builder = f.member("builder", []string{"WEB"}, []string{"build"})
	r.retro = f.member("retro", []string{"WEB"}, []string{core.SkillRetro, core.SkillSkillReview})
	r.retro2 = f.member("retro2", []string{"WEB"}, []string{core.SkillRetro})
	r.reviewer = f.member("reviewer", []string{"OPS"}, []string{core.SkillSkillReview})
	r.feature = f.feature(r.owner, "WEB", "Checkout")
	f.claim(r.owner, r.feature.Tasks[0].Key, noTimeout)
	f.complete(r.owner, r.feature.Tasks[0].Key)
	task := f.task(r.owner, r.feature.Feature.ID, "Build checkout", "build")
	f.claim(r.builder, task.Key, noTimeout)
	o, err := f.svc.Observe(ctx, r.builder, task.Key, "didnt_work", "qa missed the empty basket", core.Idem{})
	if err != nil {
		t.Fatal(err)
	}
	r.observation = o
	f.complete(r.builder, task.Key)
	shipped, err := f.svc.ShipFeature(ctx, r.owner, r.feature.Feature.Key, core.Idem{})
	if err != nil {
		t.Fatal(err)
	}
	r.retrospective = shipped.Tasks[len(shipped.Tasks)-1]
	return r
}

func (r retroFixture) version(skill string) int64 {
	r.t.Helper()
	d, err := r.svc.GetSkill(r.t.Context(), r.admin, skill)
	if err != nil {
		r.t.Fatal(err)
	}
	return d.Skill.CurrentVersion
}

// A Retrospective proposes a new version of a company Skill and hands it to skill-review; a
// reviewer from another Team publishes it by completing the review, which also marks the
// Feature's Observations reviewed. Later Claims work under the new version.
func TestSkillVersionPublishes(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		r := newRetroFixture(t, st)
		ctx := t.Context()
		key := r.retrospective.Key

		obs, err := r.svc.ListFeatureObservations(ctx, r.retro, r.feature.Feature.Key, false)
		if err != nil || len(obs) != 1 || obs[0].ID != r.observation.ID {
			t.Fatalf("unreviewed Observations %+v, %v", obs, err)
		}
		_, err = r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 1, "Also test an empty basket.", core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		r.claim(r.retro, key, noTimeout)
		_, err = r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa", 1, "x", core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 2, "x", core.Idem{})
		wantCode(t, err, core.CodeProposalStale)
		first, err := r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 1, "Test an empty basket.", core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		// A second proposal on the same Task supersedes the first.
		p, err := r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 1, "Test the happy path and an empty basket.", core.Idem{})
		if err != nil || p.State != "pending" || p.AuthorID != r.retro.MemberID || p.BasedOnVersion != 1 {
			t.Fatalf("proposal %+v, %v", p, err)
		}
		if old, _ := r.svc.GetSkillProposal(ctx, r.admin, first.ID); old.State != "superseded" {
			t.Fatalf("first proposal %+v", old)
		}
		r.handover(r.retro, key, core.SkillSkillReview)
		d := r.get(key)
		if d.Proposal == nil || d.Proposal.ID != p.ID || d.Proposal.Body != p.Body {
			t.Fatalf("the Task carries %+v", d.Proposal)
		}

		// The author has skill-review too, and still cannot take the review of their own proposal.
		if r.takeable(r.retro)[r.retrospective.ID] {
			t.Fatal("the author can take the review of their own proposal")
		}
		r.claim(r.reviewer, key, noTimeout)
		done := r.complete(r.reviewer, key)
		if done.State != "done" {
			t.Fatalf("review %+v", done)
		}
		if v := r.version("qa-acme"); v != 2 {
			t.Fatalf("qa-acme is at version %d", v)
		}
		versions, err := r.svc.ListSkillVersions(ctx, r.admin, "qa-acme")
		if err != nil || len(versions) != 2 || versions[0].Version != 2 || versions[0].Body != p.Body ||
			*versions[0].ProposalID != p.ID || *versions[0].PublishedBy != r.reviewer.MemberID {
			t.Fatalf("versions %+v, %v", versions, err)
		}
		pub, _ := r.svc.GetSkillProposal(ctx, r.admin, p.ID)
		if pub.State != "published" || pub.PublishedVersion == nil || *pub.PublishedVersion != 2 || pub.DecidedAt == nil {
			t.Fatalf("published proposal %+v", pub)
		}

		// The Retrospective completed, so its Feature's Observations are reviewed by it.
		obs, _ = r.svc.ListFeatureObservations(ctx, r.retro, r.feature.Feature.Key, false)
		if len(obs) != 0 {
			t.Fatalf("still unreviewed: %+v", obs)
		}
		obs, _ = r.svc.ListFeatureObservations(ctx, r.retro, r.feature.Feature.Key, true)
		if len(obs) != 1 || obs[0].ReviewedByTaskID == nil || *obs[0].ReviewedByTaskID != r.retrospective.ID || obs[0].ReviewedAt == nil {
			t.Fatalf("all Observations %+v", obs)
		}

		// A Claim made now records version 2.
		next := r.feature2("Returns")
		qa := r.task(r.owner, next, "Test returns", "qa-acme")
		if err := r.svc.GrantSkill(ctx, r.admin, "builder", "qa-acme", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		c := r.claim(r.builder, qa.Key, noTimeout)
		if v := c.Task.Claim.SkillVersion; v == nil || *v != 2 {
			t.Fatalf("Claim records version %v", v)
		}
		if got := r.kinds(r.retrospective.ID); got != "task.filed task.claimed task.skill_proposed task.skill_proposed task.handed_over task.claimed task.completed" {
			t.Fatalf("Activity: %s", got)
		}
		skillID := r.skillID("qa-acme")
		if got := r.kinds(skillID); got != "skill.created skill.version_published" {
			t.Fatalf("the Skill's Activity: %s", got)
		}
		r.checkActivity()
	})
}

func (r retroFixture) feature2(title string) string {
	r.t.Helper()
	return r.fixture.feature(r.owner, "WEB", title).Feature.ID
}

// Two proposals written against the same version: the second review is refused with
// proposal_stale and changes nothing; handed back and rewritten, it publishes version 3.
func TestStaleProposalIsRefused(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		r := newRetroFixture(t, st)
		ctx := t.Context()
		other := r.fixture.feature(r.owner, "WEB", "Wishlist")
		r.claim(r.owner, other.Tasks[0].Key, noTimeout)
		r.complete(r.owner, other.Tasks[0].Key)
		shipped, err := r.svc.ShipFeature(ctx, r.owner, other.Feature.Key, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		second := shipped.Tasks[len(shipped.Tasks)-1]

		for _, w := range []struct {
			c    *auth.Caller
			task core.Task
			body string
		}{{r.retro, r.retrospective, "first"}, {r.retro2, second, "second"}} {
			r.claim(w.c, w.task.Key, noTimeout)
			if _, err := r.svc.ProposeSkillVersion(ctx, w.c, w.task.Key, "qa-acme", 1, w.body, core.Idem{}); err != nil {
				t.Fatal(err)
			}
			r.handover(w.c, w.task.Key, core.SkillSkillReview)
		}
		r.claim(r.reviewer, r.retrospective.Key, noTimeout)
		r.complete(r.reviewer, r.retrospective.Key)
		r.claim(r.reviewer, second.Key, noTimeout)
		before := r.checkActivity()
		_, err = r.svc.Complete(ctx, r.reviewer, second.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeProposalStale)
		if r.checkActivity() != before || r.version("qa-acme") != 2 {
			t.Fatal("a stale review changed something")
		}
		d := r.get(second.Key)
		if d.Task.State != "open" || d.Task.Claim == nil || d.Proposal.State != "pending" {
			t.Fatalf("after the refusal %+v proposal %+v", d.Task, d.Proposal)
		}
		// Handed back to retro and rewritten against version 2, it publishes version 3.
		r.handover(r.reviewer, second.Key, core.SkillRetro)
		r.claim(r.retro2, second.Key, noTimeout)
		if _, err := r.svc.ProposeSkillVersion(ctx, r.retro2, second.Key, "qa-acme", 2, "second, rebased", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		r.handover(r.retro2, second.Key, core.SkillSkillReview)
		// The reviewer held it under skill-review before, so may take it again under it.
		r.claim(r.reviewer, second.Key, noTimeout)
		r.complete(r.reviewer, second.Key)
		if v := r.version("qa-acme"); v != 3 {
			t.Fatalf("qa-acme is at version %d", v)
		}
		if n := r.count(`SELECT COUNT(*) FROM skill_proposals WHERE task_id = $1 AND state = 'superseded'`, second.ID); n != 1 {
			t.Fatalf("%d superseded proposals", n)
		}
		r.checkActivity()
	})
}

// The author of a proposal never publishes it: even holding the review, which the Claim rows
// normally prevent, completing it is refused.
func TestAuthorCannotPublishTheirProposal(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		r := newRetroFixture(t, st)
		ctx := t.Context()
		key := r.retrospective.Key
		r.claim(r.retro, key, noTimeout)
		if _, err := r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 1, "mine", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		r.handover(r.retro, key, core.SkillSkillReview)
		// Forget the author's Claim under retro, so the Takeable rule lets them take the review.
		r.exec(`DELETE FROM claims WHERE task_id = $1 AND holder_id = $2`, r.retrospective.ID, r.retro.MemberID)
		r.claim(r.retro, key, noTimeout)
		_, err := r.svc.Complete(ctx, r.retro, key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		if v := r.version("qa-acme"); v != 1 {
			t.Fatalf("the author published version %d", v)
		}
	})
}

// A Retrospective completed under retro, with no proposal, marks the Feature's Observations
// reviewed, and an Observation made on it is reviewed too. A proposal left pending is superseded.
func TestRetrospectiveMarksObservationsReviewed(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		r := newRetroFixture(t, st)
		ctx := t.Context()
		key := r.retrospective.Key
		r.claim(r.retro, key, noTimeout)
		if _, err := r.svc.Observe(ctx, r.retro, key, "worked", "the Observations were clear", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		p, err := r.svc.ProposeSkillVersion(ctx, r.retro, key, "qa-acme", 1, "never mind", core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		r.complete(r.retro, key)
		all, _ := r.svc.ListFeatureObservations(ctx, r.owner, r.feature.Feature.Key, true)
		if len(all) != 2 {
			t.Fatalf("%d Observations", len(all))
		}
		for _, o := range all {
			if o.ReviewedByTaskID == nil || *o.ReviewedByTaskID != r.retrospective.ID {
				t.Fatalf("not reviewed by the Retrospective: %+v", o)
			}
		}
		if got, _ := r.svc.GetSkillProposal(ctx, r.admin, p.ID); got.State != "superseded" || r.version("qa-acme") != 1 {
			t.Fatalf("proposal %+v", got)
		}
	})
}

// A Feature filed by a Retrospective records it.
func TestFeatureFiledFromARetrospective(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		r := newRetroFixture(t, st)
		d, err := r.svc.FileFeature(t.Context(), r.retro, core.NewFeature{Team: "WEB", Title: "Fix empty baskets",
			FromRetrospective: &r.retrospective.Key}, core.Idem{})
		if err != nil || d.Feature.FromRetrospectiveTaskID == nil || *d.Feature.FromRetrospectiveTaskID != r.retrospective.ID {
			t.Fatalf("feature %+v, %v", d.Feature, err)
		}
		_, err = r.svc.FileFeature(t.Context(), r.retro, core.NewFeature{Team: "WEB", Title: "x", FromRetrospective: &r.feature.Tasks[0].Key}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
	})
}
