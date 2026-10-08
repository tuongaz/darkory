package core_test

import (
	"errors"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// signIn redeems a fresh login link for the Member, as a browser holding old (or no cookie), and
// returns the new cookie.
func (f *fixture) signIn(memberID, old string) string {
	f.t.Helper()
	ctx := f.t.Context()
	l, err := f.svc.IssueLoginLink(ctx, f.admin, memberID, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	bs, err := f.svc.RedeemLoginLink(ctx, l.Code, old)
	if err != nil {
		f.t.Fatal(err)
	}
	return bs.Cookie
}

func (f *fixture) cookieWorks(cookie string) bool {
	f.t.Helper()
	_, err := f.auth.Authenticate(f.t.Context(), auth.Credentials{Cookie: cookie})
	if err != nil && !errors.Is(err, auth.ErrUnauthenticated) {
		f.t.Fatal(err)
	}
	return err == nil
}

// A browser Session expires on the server after 30 days unused and 90 days in all, whatever its
// cookie says; signing in again closes the Session of the cookie the browser held. The security
// review's M4 proof found a cookie accepted a year on.
func TestBrowserSessionsExpire(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		ada := f.admin.MemberID
		first := f.signIn(ada, "")
		second := f.signIn(ada, first)
		if f.cookieWorks(first) || !f.cookieWorks(second) {
			t.Fatal("signing in again left the old cookie's Session open")
		}
		if n := f.count(`SELECT COUNT(*) FROM activity WHERE kind = 'session.closed' AND actor_id IS NULL`); n != 1 {
			t.Fatalf("%d session.closed entries without an actor", n)
		}

		// Used every 29 days it lives on, until 90 days after it started.
		for range 3 {
			f.clock.Advance(29 * 24 * time.Hour)
			if !f.cookieWorks(second) {
				t.Fatalf("a Session used every 29 days expired after %v", f.clock.Now().Sub(epoch))
			}
		}
		c, err := f.auth.Authenticate(ctx, auth.Credentials{Cookie: second})
		if err != nil {
			t.Fatal(err)
		}
		sessions, err := f.svc.ListSessions(ctx, f.admin, "ada", "", 0, "")
		if err != nil {
			t.Fatal(err)
		}
		var listed *core.Session
		for i, s := range sessions.Items {
			if s.ID == c.ChosenID {
				listed = &sessions.Items[i]
			}
		}
		if listed == nil || listed.ExpiresAt == nil || !listed.ExpiresAt.Equal(epoch.Add(90*24*time.Hour)) {
			t.Fatalf("the browser Session is listed as %+v", listed)
		}
		ok, err := f.svc.CallerValid(ctx, c)
		if err != nil || !ok {
			t.Fatalf("valid before its lifetime ends: %v %v", ok, err)
		}
		f.clock.Advance(3*24*time.Hour + time.Minute)
		if f.cookieWorks(second) {
			t.Fatal("a browser Session outlived its 90 days")
		}
		if ok, _ := f.svc.CallerValid(ctx, c); ok {
			t.Fatal("a long request outlives its browser Session's 90 days")
		}

		// Unused for 30 days, it expires; a token Session does not.
		third := f.signIn(ada, "")
		f.clock.Advance(30*24*time.Hour + time.Minute)
		if f.cookieWorks(third) {
			t.Fatal("a browser Session unused for 30 days still works")
		}
		f.session(ada, "ada-1")
		sessions, err = f.svc.ListSessions(ctx, f.admin, "ada", "", 0, "")
		if err != nil || len(sessions.Items) != 1 || sessions.Items[0].Kind != "token" || sessions.Items[0].ExpiresAt != nil {
			t.Fatalf("open Sessions %+v, %v", sessions.Items, err)
		}
		f.checkActivity()
	})
}

// A Member lists their own open Sessions, an admin anyone's, a page at a time.
func TestListSessions(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		bob := f.member("bob", []string{"WEB"}, nil)
		eve := f.member("eve", []string{"WEB"}, nil)
		for _, id := range []string{"bob-2", "bob-3"} {
			f.clock.Advance(time.Minute)
			f.session(bob.MemberID, id)
		}
		page, err := f.svc.ListSessions(ctx, bob, "bob", "", 2, "")
		if err != nil || len(page.Items) != 2 || page.Items[0].ID != "bob-3" || page.NextCursor == "" {
			t.Fatalf("first page %+v, %v", page, err)
		}
		rest, err := f.svc.ListSessions(ctx, f.admin, "bob", "", 2, page.NextCursor)
		if err != nil || len(rest.Items) != 1 || rest.Items[0].ID != "bob-1" || rest.NextCursor != "" {
			t.Fatalf("second page %+v, %v", rest, err)
		}
		_, err = f.svc.ListSessions(ctx, eve, "bob", "", 0, "")
		wantCode(t, err, core.CodeForbidden)
	})
}

// Deactivating a Member revokes their tokens, closes their Sessions and ends every Claim they
// hold, whether bound to a Session or to the Member, each recorded; every credential of theirs is
// refused from then on and none can be issued, until an admin reactivates them.
func TestDeactivatingAMemberStopsEverythingTheyHold(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newClaimFixture(t, st)
		ctx := t.Context()
		bound := f.fixture.task(f.a, "WEB", "Member-bound", "Build")
		f.claim(f.a, f.task.Key, timeout(time.Minute))
		f.claim(f.a, bound.Key, noTimeout)
		cookie := f.signIn(f.a.MemberID, "")
		email := "alice@example.com"
		if _, err := f.svc.UpdateMember(ctx, f.admin, "alice", core.MemberChange{Email: &email}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		unused, err := f.svc.IssueLoginLink(ctx, f.admin, "alice", core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		// An emailed sign-in looked her up before the deactivation and sends after it.
		pending, err := f.svc.MembersByEmail(ctx, email)
		if err != nil || len(pending) != 1 {
			t.Fatalf("email lookup %+v, %v", pending, err)
		}

		_, err = f.svc.DeactivateMember(ctx, f.b, "alice", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		_, err = f.svc.DeactivateMember(ctx, f.admin, "ada", core.Idem{})
		wantCode(t, err, core.CodeForbidden)
		before := f.checkActivity()
		m, err := f.svc.DeactivateMember(ctx, f.admin, "alice", core.Idem{})
		if err != nil || m.DeactivatedAt == nil {
			t.Fatalf("deactivate = %+v, %v", m, err)
		}
		if !f.takeable(f.b)[f.task.ID] || !f.takeable(f.b)[bound.ID] {
			t.Fatal("a deactivated Member's Claims still hold their Tasks")
		}
		for _, k := range []string{f.task.ID, bound.ID} {
			if n := f.count(`SELECT COUNT(*) FROM claims WHERE task_id = $1 AND how_ended = 'member_deactivated'`, k); n != 1 {
				t.Fatalf("%d Claims on %s ended by the deactivation", n, k)
			}
		}
		if _, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: f.secrets[f.a.MemberID], Session: "alice-new"}); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("the token still authenticates: %v", err)
		}
		if f.cookieWorks(cookie) {
			t.Fatal("the browser cookie still works")
		}
		if ok, _ := f.svc.CallerValid(ctx, f.a); ok {
			t.Fatal("a long request of the deactivated Member goes on")
		}
		if _, err := f.svc.RedeemLoginLink(ctx, unused.Code, ""); codeOf(err) != core.CodeNotFound {
			t.Fatalf("a link issued before the deactivation signs in: %v", err)
		}
		_, err = f.svc.IssueToken(ctx, f.admin, "alice", "again", 0, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.IssueLoginLink(ctx, f.admin, "alice", core.Idem{})
		wantCode(t, err, core.CodeConflict)
		links := f.count(`SELECT COUNT(*) FROM login_links WHERE member_id = $1`, f.a.MemberID)
		_, err = f.svc.IssueEmailLink(ctx, pending[0])
		wantCode(t, err, core.CodeConflict)
		if n := f.count(`SELECT COUNT(*) FROM login_links WHERE member_id = $1`, f.a.MemberID); n != links {
			t.Fatal("an emailed link was issued for a deactivated Member")
		}
		if found, err := f.svc.MembersByEmail(ctx, email); err != nil || len(found) != 0 {
			t.Fatalf("email sign-in finds %+v, %v", found, err)
		}
		if sessions, err := f.svc.ListSessions(ctx, f.admin, "alice", "", 0, ""); err != nil || len(sessions.Items) != 0 {
			t.Fatalf("open Sessions %+v, %v", sessions.Items, err)
		}
		if got := f.activityKinds(f.a.MemberID); got[len(got)-1] != "member.deactivated" {
			t.Fatalf("the Member's Activity %v", got)
		}
		// The deactivation, the token revoked, two Sessions closed (one ending a Claim), the
		// Member-bound Claim ended.
		if n := f.checkActivity() - before; n != 6 {
			t.Fatalf("the deactivation recorded %d entries", n)
		}
		again, err := f.svc.DeactivateMember(ctx, f.admin, "alice", core.Idem{})
		if err != nil || !again.DeactivatedAt.Equal(*m.DeactivatedAt) || f.checkActivity() != before+6 {
			t.Fatalf("deactivating again = %+v, %v", again, err)
		}

		// The Member stays in the record; reactivated, they can be issued a token again.
		if members, _ := f.svc.ListMembers(ctx, f.admin, nil, nil); len(members) != 3 {
			t.Fatalf("members %+v", members)
		}
		if m, err := f.svc.ReactivateMember(ctx, f.admin, "alice", core.Idem{}); err != nil || m.DeactivatedAt != nil {
			t.Fatalf("reactivate = %+v, %v", m, err)
		}
		// Reactivation revives nothing: the old token, cookie and link stay dead, the link within
		// its 15 minutes too.
		if _, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: f.secrets[f.a.MemberID], Session: "alice-back"}); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("the old token after reactivation: %v", err)
		}
		if f.cookieWorks(cookie) {
			t.Fatal("the old cookie works after reactivation")
		}
		if _, _, err := f.svc.LoginLinkFor(ctx, unused.Code); codeOf(err) != core.CodeNotFound {
			t.Fatalf("the old link shows its page after reactivation: %v", err)
		}
		if _, err := f.svc.RedeemLoginLink(ctx, unused.Code, ""); codeOf(err) != core.CodeNotFound {
			t.Fatalf("the old link signs in after reactivation: %v", err)
		}
		tok, err := f.svc.IssueToken(ctx, f.admin, "alice", "again", 0, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: "alice-back"}); err != nil {
			t.Fatalf("a new token after reactivation: %v", err)
		}
		f.checkActivity()
	})
}

// The last active admin cannot be deactivated or lose the mark; a deactivated admin does not
// count.
func TestTheLastActiveAdminStays(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		if _, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: "root", Kind: "human", Admin: true}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		tok, err := f.svc.IssueToken(ctx, f.admin, "root", "main", 0, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		root, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: "root-1"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.DeactivateMember(ctx, root, "ada", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		no := false
		_, err = f.svc.UpdateMember(ctx, root, "root", core.MemberChange{Admin: &no}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
	})
}

// A Task whose only Project Member with its Step's Skill was deactivated falls back to its Owner,
// and a Task at the skill-review Step to its Owner once the Organisation's only reviewer is
// deactivated.
func TestDeactivatedMembersLeaveTheSkillPools(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.project("OPS")
		f.skill("qa")
		f.chain("WEB", [2]string{"QA", "qa"}, [2]string{"Skill review", core.SkillSkillReview})
		owner := f.member("owner", []string{"WEB"}, nil)
		f.member("tester", []string{"WEB"}, []string{"qa"})
		f.member("reviewer", []string{"OPS"}, []string{core.SkillSkillReview})
		qa := f.task(owner, "WEB", "Test search", "QA")
		review := f.task(owner, "WEB", "Review", "Skill review")
		if f.takeable(owner)[qa.ID] || f.takeable(owner)[review.ID] {
			t.Fatal("the owner takes Tasks others can take")
		}
		for _, m := range []string{"tester", "reviewer"} {
			if _, err := f.svc.DeactivateMember(ctx, f.admin, m, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		if !f.takeable(owner)[qa.ID] || !f.takeable(owner)[review.ID] {
			t.Fatal("Tasks wait for deactivated Members")
		}
	})
}
