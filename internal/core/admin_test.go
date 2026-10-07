package core_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

func TestInitCreatesTheInstallOnce(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		skills, err := f.svc.ListSkills(ctx, f.admin, nil)
		if err != nil {
			t.Fatal(err)
		}
		// The four builtin Skills, and engineer and review, which the default Workflow's Build and
		// Review Steps carry, whether or not the roster is seeded.
		var names []string
		for _, s := range skills {
			builtin := s.Name != core.SkillEngineer && s.Name != core.SkillReview
			if s.Builtin != builtin || s.Kind != "generic" || s.CurrentVersion != 1 {
				t.Errorf("seeded Skill %+v", s)
			}
			names = append(names, s.Name)
		}
		if !slices.Equal(names, []string{"acceptance", "breakdown", "engineer", "retro", "review", "skill-review"}) {
			t.Fatalf("seeded Skills %v", names)
		}
		if me, err := f.svc.GetMe(ctx, f.admin); err != nil || len(me.Projects) != 0 || me.Organisations != nil {
			t.Fatalf("me without the roster: %+v, %v", me, err)
		}
		if _, err := f.svc.Init(ctx, "Again", "bob"); !errors.Is(err, core.ErrInitialised) {
			t.Fatalf("second init: %v", err)
		}
		me, err := f.svc.GetMe(ctx, f.admin)
		if err != nil || me.Organisation.Name != "Acme" || !me.Member.Admin || me.Member.Kind != "human" || me.Session.ID != "ada-1" {
			t.Fatalf("me %+v, %v", me, err)
		}
		m, link, err := f.svc.StartupLink(ctx)
		if err != nil || m.Name != "ada" || link.Code == "" || !link.ExpiresAt.Equal(epoch.Add(core.LoginLinkTTL)) {
			t.Fatalf("startup link for %v: %+v, %v", m.Name, link, err)
		}
		f.checkActivity()
	})
}

// Admin operations need the admin mark; reads are open to every Member.
func TestAdminOperationsNeedTheAdminMark(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		f.skill("qa")
		bob := f.member("bob", []string{"WEB"}, nil)
		forbidden := map[string]error{}
		_, forbidden["createMember"] = f.svc.CreateMember(ctx, bob, core.NewMember{Name: "eve", Kind: "agent"}, core.Idem{})
		_, forbidden["createProject"] = f.svc.CreateProject(ctx, bob, core.NewProject{Key: "API", Name: "API"}, core.Idem{})
		_, forbidden["updateProject"] = f.svc.UpdateProject(ctx, bob, "WEB", core.ProjectChange{AutoComplete: ptrBool(true)}, core.Idem{})
		_, forbidden["setWorkflow"] = f.svc.SetWorkflow(ctx, bob, "WEB", core.WorkflowInput{}, core.Idem{})
		_, forbidden["createSkill"] = f.svc.CreateSkill(ctx, bob, core.NewSkill{Name: "x", Kind: "generic"}, core.Idem{})
		forbidden["grantSkill"] = f.svc.GrantSkill(ctx, bob, "bob", "qa", core.Idem{})
		forbidden["addProjectMember"] = f.svc.AddProjectMember(ctx, bob, "WEB", "ada", core.Idem{})
		forbidden["setManager"] = f.svc.SetManager(ctx, bob, "bob", "ada", core.Idem{})
		_, forbidden["issueToken"] = f.svc.IssueToken(ctx, bob, "bob", "more", 0, core.Idem{})
		_, forbidden["issueLoginLink"] = f.svc.IssueLoginLink(ctx, bob, "bob", core.Idem{})
		_, forbidden["updateMember"] = f.svc.UpdateMember(ctx, bob, "bob", core.MemberChange{Admin: ptrBool(true)}, core.Idem{})
		_, forbidden["listAdaTokens"] = f.svc.ListTokens(ctx, bob, "ada")
		for op, err := range forbidden {
			if codeOf(err) != core.CodeForbidden {
				t.Errorf("%s by a non-admin: %v", op, err)
			}
		}
		if _, err := f.svc.ListMembers(ctx, bob, nil, nil); err != nil {
			t.Fatal(err)
		}
		if d, err := f.svc.GetProject(ctx, bob, "WEB"); err != nil || len(d.Members) != 1 {
			t.Fatalf("project %+v, %v", d, err)
		}
		if w, err := f.svc.GetWorkflow(ctx, bob, "WEB"); err != nil || len(w.Steps) != 6 {
			t.Fatalf("workflow %+v, %v", w, err)
		}
		if ts, err := f.svc.ListTokens(ctx, bob, "bob"); err != nil || len(ts) != 1 {
			t.Fatalf("own tokens %v, %v", ts, err)
		}
		f.checkActivity()
	})
}

func TestMembersProjectsAndSkills(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		f.project("WEB")
		_, err := f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "WEB", Name: "Other"}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.CreateProject(ctx, f.admin, core.NewProject{Key: "web", Name: "Lower"}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)

		email := "bob@example.com"
		bob, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: "bob", Kind: "human", Email: &email}, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: "bob", Kind: "agent"}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: "eve", Kind: "agent", Email: &email}, core.Idem{})
		wantCode(t, err, core.CodeConflict)
		_, err = f.svc.UpdateMember(ctx, f.admin, "ada", core.MemberChange{Admin: ptrBool(false)}, core.Idem{})
		wantCode(t, err, core.CodeConflict) // the last admin
		// A name spelled as an id would make references to it ambiguous (security review, Info).
		_, err = f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: bob.ID, Kind: "agent"}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.UpdateMember(ctx, f.admin, "bob", core.MemberChange{Name: &f.admin.MemberID}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		_, err = f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "0199b4a2-7c1e-7d3a-9f00-123456789abc", Kind: "generic", Body: "x"}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		bob, err = f.svc.UpdateMember(ctx, f.admin, "bob", core.MemberChange{Admin: ptrBool(true), Name: ptrStr("robert")}, core.Idem{})
		if err != nil || !bob.Admin || bob.Name != "robert" {
			t.Fatalf("update %+v, %v", bob, err)
		}
		before := f.checkActivity()
		// Changing nothing writes nothing.
		if _, err := f.svc.UpdateMember(ctx, f.admin, "robert", core.MemberChange{Name: ptrStr("robert")}, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddProjectMember(ctx, f.admin, "WEB", "robert", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.AddProjectMember(ctx, f.admin, "WEB", "robert", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if n := f.checkActivity(); n != before+1 {
			t.Fatalf("%d entries for one change", n-before)
		}

		qa := f.skill("qa")
		company, err := f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "qa-acme", Kind: "company", BaseSkill: ptrStr("qa"), Body: "Our QA"}, core.Idem{})
		if err != nil || company.Skill.BaseSkillID == nil || *company.Skill.BaseSkillID != qa || company.Current.Version != 1 || company.Current.Body != "Our QA" {
			t.Fatalf("company Skill %+v, %v", company, err)
		}
		_, err = f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "qa-more", Kind: "company", BaseSkill: ptrStr("qa-acme"), Body: "x"}, core.Idem{})
		wantCode(t, err, core.CodeInvalid) // builds on a company Skill
		_, err = f.svc.CreateSkill(ctx, f.admin, core.NewSkill{Name: "lonely", Kind: "company", Body: "x"}, core.Idem{})
		wantCode(t, err, core.CodeInvalid)
		if err := f.svc.GrantSkill(ctx, f.admin, "robert", "qa-acme", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, err := f.svc.GetMember(ctx, f.admin, "robert")
		if err != nil || len(d.Projects) != 1 || len(d.Skills) != 1 || d.Skills[0].Name != "qa-acme" {
			t.Fatalf("member detail %+v, %v", d, err)
		}
		if err := f.svc.RevokeSkill(ctx, f.admin, "robert", "qa-acme", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.RemoveProjectMember(ctx, f.admin, "WEB", "robert", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		d, _ = f.svc.GetMember(ctx, f.admin, bob.ID)
		if len(d.Projects) != 0 || len(d.Skills) != 0 {
			t.Fatalf("after removal %+v", d)
		}
		f.checkActivity()
	})
}

// Reporting lines may cross Projects but never loop.
func TestReportingLinesRefuseCycles(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		for _, n := range []string{"bea", "cal", "dan"} {
			if _, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: n, Kind: "agent"}, core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		for _, line := range [][2]string{{"bea", "ada"}, {"cal", "bea"}, {"dan", "cal"}} {
			if err := f.svc.SetManager(ctx, f.admin, line[0], line[1], core.Idem{}); err != nil {
				t.Fatal(err)
			}
		}
		for _, loop := range [][2]string{{"ada", "dan"}, {"bea", "cal"}, {"cal", "cal"}} {
			wantCode(t, f.svc.SetManager(ctx, f.admin, loop[0], loop[1], core.Idem{}), core.CodeCycle)
		}
		d, err := f.svc.GetMember(ctx, f.admin, "bea")
		if err != nil || *d.Member.ManagerID != f.admin.MemberID || len(d.Reports) != 1 || d.Reports[0].Name != "cal" {
			t.Fatalf("bea %+v, %v", d, err)
		}
		if err := f.svc.ClearManager(ctx, f.admin, "cal", core.Idem{}); err != nil {
			t.Fatal(err)
		}
		if err := f.svc.SetManager(ctx, f.admin, "bea", "dan", core.Idem{}); err != nil {
			t.Fatalf("no loop once cal reports to no one: %v", err)
		}
		f.checkActivity()
	})
}

// A Session id is the copy's own: presented with another token of the same Member it is refused.
func TestSessionsAreStartedOnFirstSight(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		f := newFixture(t, st)
		ctx := t.Context()
		again := f.session(f.admin.MemberID, "ada-1")
		if again.SessionID != f.admin.SessionID {
			t.Fatal("the same Session id started a second Session")
		}
		tok, err := f.svc.IssueToken(ctx, f.admin, "ada", "second", 30*time.Second, core.Idem{})
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: "ada-1"})
		if !errors.Is(err, auth.ErrSessionRequired) {
			t.Fatalf("a Session id open with another token: %v", err)
		}
		c, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: "ada-2"})
		if err != nil || c.DefaultTimeout != 30*time.Second || c.TokenID != tok.Token.ID {
			t.Fatalf("second token's Session %+v, %v", c, err)
		}
		for _, bad := range []string{"", "has space", string(make([]byte, 300))} {
			if _, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: bad}); !errors.Is(err, auth.ErrSessionRequired) {
				t.Errorf("Session id %q: %v", bad, err)
			}
		}
		if _, err := f.auth.Authenticate(ctx, auth.Credentials{}); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("no credential: %v", err)
		}
		// A closed Session's id starts a new Session when presented again.
		if _, err := f.svc.CloseSession(ctx, c, "ada-2", nil, core.Idem{}); err != nil {
			t.Fatal(err)
		}
		reopened, err := f.auth.Authenticate(ctx, auth.Credentials{Bearer: tok.Secret, Session: "ada-2"})
		if err != nil || reopened.SessionID == c.SessionID {
			t.Fatalf("reopened %+v, %v", reopened, err)
		}
	})
}
