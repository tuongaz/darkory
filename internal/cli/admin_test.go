package cli

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/mail"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The admin commands against the real server: Members, Teams, Skills, grants, Reporting lines,
// tokens, login links and Sessions.
func TestAdminCommands(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		ada := in.as("ada", "ada-1")

		var m client.Member
		ada.json(&m, "member", "create", "dan", "--kind", "human", "--email", "dan@example.com")
		if m.Name != "dan" || m.Kind != client.Human || deref(m.Email) != "dan@example.com" || m.Admin {
			t.Fatalf("member create: %+v", m)
		}
		ada.json(&m, "member", "update", "dan", "--admin", "--name", "daniel")
		if m.Name != "daniel" || !m.Admin {
			t.Fatalf("member update: %+v", m)
		}
		ada.json(&m, "member", "update", "daniel", "--admin=false")
		if m.Admin {
			t.Fatalf("member update --admin=false: %+v", m)
		}
		ada.fails(ExitUsage, "member", "update", "daniel")

		var team client.Team
		ada.json(&team, "team", "create", "OPS", "Operations")
		ada.ok("team", "add", "OPS", "daniel")
		var td client.TeamDetail
		ada.json(&td, "team", "show", "OPS")
		if td.Team.Key != "OPS" || len(td.Members) != 1 || td.Members[0].Name != "daniel" {
			t.Fatalf("team show: %+v", td)
		}
		if out := ada.ok("team", "list"); !strings.Contains(out, "OPS      Operations") {
			t.Fatalf("team list: %q", out)
		}
		var members client.MemberList
		ada.json(&members, "member", "list", "--team", "OPS")
		if len(members.Items) != 1 {
			t.Fatalf("member list --team: %+v", members)
		}
		ada.ok("team", "remove", "OPS", "daniel")
		ada.json(&members, "member", "list", "--team", "OPS")
		if len(members.Items) != 0 {
			t.Fatalf("after team remove: %+v", members)
		}

		var sk client.SkillDetail
		ada.json(&sk, "skill", "create", "qa", "--kind", "generic", "--body", "Test it.")
		ada.stdin = "Test it the Acme way.\n"
		ada.json(&sk, "skill", "create", "qa-acme", "--kind", "company", "--base", "qa", "--file", "-")
		ada.stdin = ""
		if sk.Skill.Kind != client.Company || sk.Current.Body != "Test it the Acme way." || sk.Current.Version != 1 {
			t.Fatalf("skill create: %+v", sk)
		}
		if out := ada.ok("skill", "show", "qa-acme"); !strings.Contains(out, "Test it the Acme way.") || !strings.Contains(out, "on qa") {
			t.Fatalf("skill show: %q", out)
		}
		var versions client.SkillVersionList
		ada.json(&versions, "skill", "versions", "qa-acme")
		if len(versions.Items) != 1 {
			t.Fatalf("skill versions: %+v", versions)
		}
		var skills client.SkillList
		ada.json(&skills, "skill", "list", "--kind", "company")
		if len(skills.Items) != 1 || skills.Items[0].Name != "qa-acme" {
			t.Fatalf("skill list --kind company: %+v", skills)
		}

		ada.ok("grant", "daniel", "qa")
		ada.ok("report-to", "daniel", "ada")
		var md client.MemberDetail
		ada.json(&md, "member", "show", "daniel")
		if len(md.Skills) != 1 || md.Skills[0].Name != "qa" || deref(md.Member.ManagerID) == "" {
			t.Fatalf("member show: %+v", md)
		}
		if out := ada.ok("member", "show", "ada"); !strings.Contains(out, "Reports  daniel") {
			t.Fatalf("member show ada: %q", out)
		}
		if res := ada.fails(ExitRefused, "report-to", "ada", "daniel"); !strings.Contains(res.stderr, "cycle") {
			t.Fatalf("a Reporting-line loop: %q", res.stderr)
		}
		ada.ok("ungrant", "daniel", "qa")
		ada.ok("report-to", "daniel", "--none")
		var after client.MemberDetail
		ada.json(&after, "member", "show", "daniel")
		if len(after.Skills) != 0 || after.Member.ManagerID != nil {
			t.Fatalf("after ungrant and --none: %+v", after)
		}

		// Tokens: issue (the secret once), list, use, revoke.
		var issued client.IssuedToken
		ada.json(&issued, "token", "issue", "daniel", "--name", "laptop", "--timeout", "5m")
		if !strings.HasPrefix(issued.Secret, "dk_") || deref(issued.Token.DefaultHeartbeatTimeoutSeconds) != 300 {
			t.Fatalf("token issue: %+v", issued)
		}
		in.tokens["daniel"] = issued.Secret
		dan := in.as("daniel", "dan-1")
		var me client.Me
		dan.json(&me, "me")
		if me.Member.Name != "daniel" || me.Session.ID != "dan-1" {
			t.Fatalf("me: %+v", me)
		}
		var tokens client.TokenList
		dan.json(&tokens, "token", "list")
		if len(tokens.Items) != 1 || tokens.Items[0].Name != "laptop" {
			t.Fatalf("token list: %+v", tokens)
		}
		var closed client.ClosedSession
		dan.json(&closed, "session", "close")
		if closed.Session.ID != "dan-1" || closed.Session.ClosedAt == nil {
			t.Fatalf("session close: %+v", closed)
		}
		dan.ok("logout")
		var revoked client.Token
		ada.json(&revoked, "token", "revoke", issued.Token.ID)
		if revoked.RevokedAt == nil {
			t.Fatalf("token revoke: %+v", revoked)
		}
		if res := dan.fails(ExitFailed, "me"); !strings.Contains(res.stderr, "unauthenticated") {
			t.Fatalf("a revoked token: %q", res.stderr)
		}

		var link client.LoginLink
		ada.json(&link, "login", "daniel")
		if !strings.Contains(link.URL, "/v1/login-links/") {
			t.Fatalf("login: %+v", link)
		}
		if out := ada.ok("login", "daniel"); !strings.Contains(out, "sign in as daniel") {
			t.Fatalf("login printed %q", out)
		}
		// Not an admin: refused.
		in.agent("eve", "")
		if res := in.as("eve", "eve-1").fails(ExitRefused, "member", "create", "x", "--kind", "agent"); !strings.Contains(res.stderr, "forbidden") {
			t.Fatalf("member create by a non-admin: %q", res.stderr)
		}
	})
}

// health and the emailed login link need no token.
func TestPublicCommands(t *testing.T) {
	sent := mail.NewFake()
	in := newInstallWith(t, storetest.Open(t, store.SQLite), server.Options{Mail: sent, PublicURL: "http://darkory.test"})
	in.as("ada", "ada-1").ok("member", "update", "ada", "--email", "ada@example.com")
	anon := &runner{t: t, env: map[string]string{"DARKORY_URL": in.ts.URL}}
	var h client.Health
	anon.json(&h, "health")
	if h.Status != client.HealthStatusOk || h.Version == "" || !slices.Contains(h.SignInModes, client.SignInEmailLink) {
		t.Fatalf("health: %+v", h)
	}
	if out := anon.ok("health"); !strings.Contains(out, "email_link") {
		t.Fatalf("health printed %q", out)
	}
	anon.fails(ExitUsage, "login")
	anon.fails(ExitUsage, "login", "ada", "--email", "ada@example.com")

	// The reply is the same whether or not a Member has the address; only a Member is emailed.
	for _, addr := range []string{"nobody@example.com", "ada@example.com"} {
		if out := anon.ok("login", "--email", addr); !strings.Contains(out, "a login link is on its way") {
			t.Fatalf("login --email %s: %q", addr, out)
		}
	}
	m, ok := sent.Next(5 * time.Second)
	if !ok || m.To != "ada@example.com" || !strings.Contains(m.Text, "http://darkory.test/v1/login-links/") {
		t.Fatalf("emailed %+v, %v", m, ok)
	}
	if len(sent.Sent()) != 1 {
		t.Fatalf("sent %d emails", len(sent.Sent()))
	}
}
