package core_test

import (
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Helpers for the flow tests.

func (f *fixture) claim(c *auth.Caller, ref string, o core.ClaimOptions) core.TaskDetail {
	f.t.Helper()
	d, err := f.svc.Claim(f.t.Context(), c, ref, o, core.Idem{})
	if err != nil {
		f.t.Fatalf("%s claims %s: %v", c.Name, ref, err)
	}
	return d
}

func (f *fixture) complete(c *auth.Caller, ref string) core.Task {
	f.t.Helper()
	t, err := f.svc.Complete(f.t.Context(), c, ref, nil, core.Idem{})
	if err != nil {
		f.t.Fatalf("%s completes %s: %v", c.Name, ref, err)
	}
	return t
}

func (f *fixture) handover(c *auth.Caller, ref, skill string) core.Task {
	f.t.Helper()
	t, err := f.svc.Handover(f.t.Context(), c, ref, skill, nil, core.Idem{})
	if err != nil {
		f.t.Fatalf("%s hands %s over to %s: %v", c.Name, ref, skill, err)
	}
	return t
}

func (f *fixture) get(ref string) core.TaskDetail {
	f.t.Helper()
	d, err := f.svc.GetTask(f.t.Context(), f.admin, ref)
	if err != nil {
		f.t.Fatal(err)
	}
	return d
}

// kinds lists the kinds of the Activity entries about subject, in order.
func (f *fixture) kinds(subject string) string {
	f.t.Helper()
	rows, err := f.st.Query(f.t.Context(), `SELECT kind FROM activity WHERE subject_id = $1 ORDER BY seq`, subject)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			f.t.Fatal(err)
		}
		out = append(out, k)
	}
	return strings.Join(out, " ")
}

func (f *fixture) manager(member, manager string) {
	f.t.Helper()
	if err := f.svc.SetManager(f.t.Context(), f.admin, member, manager, core.Idem{}); err != nil {
		f.t.Fatal(err)
	}
}

// A builder who also has qa hands their Task over to qa and cannot take that stage, but takes the
// Task back under build when qa hands it back: no one judges their own work (ADR 0001).
func TestHandoverKeepsNoSelfReview(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.skill("build")
		f.skill("qa")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build", "qa"})
		tester := f.member("tester", []string{"WEB"}, []string{"qa"})
		feature := f.feature(lead, "WEB", "Sign-up").Feature.ID
		task := f.task(lead, feature, "Build the form", "build")

		f.claim(builder, task.Key, noTimeout)
		if _, err := f.svc.AddNote(ctx, builder, task.Key, "the form posts to /signup", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		// Only the holder hands over.
		_, err := f.svc.Handover(ctx, tester, task.Key, "qa", nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		_, err = f.svc.Handover(ctx, builder, task.Key, "no-such-skill", nil, core.Idem{})
		wantCode(t, err, core.CodeNotFound)

		f.clock.Advance(time.Hour)
		note := "ready for qa"
		out, err := f.svc.Handover(ctx, builder, task.Key, "qa", &note, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		qa := f.skillID("qa")
		if out.Claim != nil || out.SkillID == nil || *out.SkillID != qa || !out.WaitingSince.Equal(f.clock.Now()) {
			t.Fatalf("handed over %+v", out)
		}
		d := f.get(task.Key)
		if d.Task.SkillID == nil || *d.Task.SkillID != qa || d.Task.Claim != nil || !d.Task.WaitingSince.Equal(f.clock.Now()) {
			t.Fatalf("after Handover %+v", d.Task)
		}
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "handed_over" || len(d.Notes) != 2 || d.Notes[1].Body != note {
			t.Fatalf("claims %+v notes %+v", d.Claims, d.Notes)
		}

		// The builder has qa but held the Task under build: the qa stage is not theirs to take.
		if f.takeable(builder)[task.ID] {
			t.Fatal("the builder can take the qa stage of their own Task")
		}
		_, err = f.svc.Claim(ctx, builder, task.Key, noTimeout, core.Idem{})
		wantCode(t, err, core.CodeNotTakeable)
		if !f.takeable(tester)[task.ID] {
			t.Fatal("qa cannot take the Task")
		}
		f.claim(tester, task.Key, noTimeout)
		f.handover(tester, task.Key, "build")

		// Back under build, the builder takes it again; the tester, who held it under qa, cannot.
		if f.takeable(tester)[task.ID] {
			t.Fatal("the tester can take the build stage after reviewing it")
		}
		f.claim(builder, task.Key, noTimeout)
		d = f.get(task.Key)
		if len(d.Claims) != 3 || len(d.Notes) != 2 {
			t.Fatalf("claims %d notes %d", len(d.Claims), len(d.Notes))
		}
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.note_added task.handed_over task.claimed task.handed_over task.claimed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// A Task aimed at a Member is no longer aimed at anyone once handed over to a Skill.
func TestHandoverOfAnAimedTask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		f.team("WEB")
		f.skill("build")
		lead := f.member("lead", []string{"WEB"}, nil)
		builder := f.member("builder", []string{"WEB"}, []string{"build"})
		task := f.aimed(lead, f.feature(lead, "WEB", "Login").Feature.ID, "Which provider?", "lead")
		f.claim(lead, task.Key, noTimeout)
		out := f.handover(lead, task.Key, "build")
		if out.AimedAtID != nil || out.SkillID == nil {
			t.Fatalf("handed over %+v", out)
		}
		if !f.takeable(builder)[task.ID] {
			t.Fatal("the build Skill cannot take the handed-over Task")
		}
	})
}

// Notes and Observations are written only by the Member holding the Task, through the Session
// that holds it when the Claim has a timeout. An Observation records the Skill it was made under.
func TestNotesAndObservationsNeedTheClaim(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		_, err := f.svc.AddNote(ctx, f.a, f.task.Key, "nobody holds it", core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		f.claim(f.a, f.task.Key, timeout(time.Minute))
		sibling := f.session(f.a.MemberID, "alice-2")
		for _, c := range []*auth.Caller{f.b, sibling} {
			_, err = f.svc.AddNote(ctx, c, f.task.Key, "not mine", core.Idem{})
			wantCode(t, err, core.CodeNotHolder)
			_, err = f.svc.Observe(ctx, c, f.task.Key, "worked", "not mine", core.Idem{})
			wantCode(t, err, core.CodeNotHolder)
		}
		_, err = f.svc.AddNote(ctx, f.a, f.task.Key, " ", core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.Observe(ctx, f.a, f.task.Key, "great", "x", core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		n, err := f.svc.AddNote(ctx, f.a, f.task.Key, "started", core.Idem{})
		if err != nil || n.AuthorID != f.a.MemberID || n.SkillID == nil || *n.SkillID != f.skillID("build") {
			t.Fatalf("note %+v, %v", n, err)
		}
		o, err := f.svc.Observe(ctx, f.a, f.task.Key, "didnt_work", "the build script needs a flag", core.Idem{})
		if err != nil || o.AuthorID != f.a.MemberID || o.SkillID == nil || *o.SkillID != f.skillID("build") || o.Outcome != "didnt_work" ||
			o.FeatureID != f.task.FeatureID || o.ReviewedByTaskID != nil {
			t.Fatalf("observation %+v, %v", o, err)
		}
		d := f.get(f.task.Key)
		if len(d.Notes) != 1 || len(d.Observations) != 1 || d.Observations[0].ID != o.ID {
			t.Fatalf("notes %+v observations %+v", d.Notes, d.Observations)
		}
		// A lapsed Claim writes nothing more.
		f.clock.Advance(2 * time.Minute)
		_, err = f.svc.AddNote(ctx, f.a, f.task.Key, "too late", core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		if got := f.kinds(f.task.ID); got != "task.filed task.claimed task.note_added task.observed" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Anyone above the holder on their Reporting line, or the Feature owner, takes a Claim back; the
// holder's next Heartbeat says so. Nobody else may.
func TestTakeBack(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.team("WEB")
		f.team("API")
		f.skill("build")
		owner := f.member("owner", []string{"WEB"}, nil)
		holder := f.member("holder", []string{"WEB"}, []string{"build"})
		peer := f.member("peer", []string{"WEB"}, []string{"build"})
		f.member("lead", []string{"API"}, nil)
		head := f.member("head", []string{"API"}, nil)
		f.manager("holder", "lead")
		f.manager("lead", "head")
		feature := f.feature(owner, "WEB", "Login").Feature.ID
		task := f.task(owner, feature, "Build it", "build")

		_, err := f.svc.TakeBack(ctx, head, task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeNotHolder)
		f.claim(holder, task.Key, timeout(time.Minute))
		_, err = f.svc.TakeBack(ctx, peer, task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		// Two steps up the Reporting line, from another Team.
		reason := "needed elsewhere"
		out, err := f.svc.TakeBack(ctx, head, task.Key, &reason, core.Idem{})
		if err != nil || out.Claim != nil {
			t.Fatalf("take-back %+v, %v", out, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, holder, task.Key); err != nil || hb.Status != "taken_back" {
			t.Fatalf("heartbeat after take-back: %+v, %v", hb, err)
		}
		if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND how_ended = 'taken_back' AND ended_by = $2`, task.ID, head.MemberID); n != 1 {
			t.Fatalf("%d Claims ended taken_back by head", n)
		}
		if !f.takeable(peer)[task.ID] {
			t.Fatal("the Task is not takeable after the take-back")
		}
		// The Feature owner, who is on nobody's line.
		f.claim(peer, task.Key, noTimeout)
		if _, err := f.svc.TakeBack(ctx, owner, task.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if got := f.kinds(task.ID); got != "task.filed task.claimed task.taken_back task.claimed task.taken_back" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

// Only the Feature owner drops a Task, held or not; any Claim on it ends, and the Tasks it
// blocked are freed.
func TestDropTask(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		owner := f.a // alice filed the Feature
		blocked := f.fixture.task(owner, f.task.FeatureID, "After it", "build")
		if err := f.svc.AddBlocker(ctx, owner, blocked.Key, f.task.Key, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		f.claim(f.b, f.task.Key, timeout(time.Minute))
		_, err := f.svc.DropTask(ctx, f.b, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeForbidden)

		out, err := f.svc.DropTask(ctx, owner, f.task.Key, ptrStr("not needed"), core.Idem{})
		if err != nil || out.State != "dropped" || out.Claim != nil || out.EndedAt == nil {
			t.Fatalf("dropped %+v, %v", out, err)
		}
		if hb, err := f.svc.Heartbeat(ctx, f.b, f.task.Key); err != nil || hb.Status != "ended" {
			t.Fatalf("heartbeat after drop: %+v, %v", hb, err)
		}
		d := f.get(f.task.Key)
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "dropped" {
			t.Fatalf("claims %+v", d.Claims)
		}
		_, err = f.svc.DropTask(ctx, owner, f.task.Key, nil, core.Idem{})
		wantCode(t, err, core.CodeEnded)
		if !f.takeable(f.b)[blocked.ID] {
			t.Fatal("a Task blocked by a dropped Task is still blocked")
		}

		// A Claim that had run out unrecorded is recorded as lapsed, not dropped.
		f.claim(f.b, blocked.Key, timeout(time.Minute))
		f.clock.Advance(2 * time.Minute)
		if _, err := f.svc.DropTask(ctx, owner, blocked.Key, nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d = f.get(blocked.Key)
		if len(d.Claims) != 1 || *d.Claims[0].HowEnded != "lapsed" {
			t.Fatalf("claims %+v", d.Claims)
		}
		if got := f.kinds(blocked.ID); got != "task.filed task.blocker_added task.claimed task.lapsed task.dropped" {
			t.Fatalf("Activity: %s", got)
		}
		f.checkActivity()
	})
}

func (f *fixture) skillID(name string) string {
	f.t.Helper()
	d, err := f.svc.GetSkill(f.t.Context(), f.admin, name)
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Skill.ID
}
