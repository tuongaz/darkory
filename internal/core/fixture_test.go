package core_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/auth"
	"github.com/tuongaz/darkory/internal/clock"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/wake"
)

var epoch = time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)

// fixture is an initialised Install with a fake clock, and helpers to add Members.
type fixture struct {
	t       *testing.T
	st      *store.Store
	svc     *core.Service
	clock   *clock.Fake
	auth    *auth.Authenticator
	admin   *auth.Caller
	secrets map[string]string // Member id → token secret
}

func newFixture(t *testing.T, st *store.Store) *fixture {
	t.Helper()
	f := &fixture{t: t, st: st, clock: clock.NewFake(epoch), secrets: map[string]string{}}
	f.svc = core.New(st, f.clock, wake.New(), nil)
	f.auth = auth.New(st, f.clock)
	init, err := f.svc.Init(t.Context(), "Acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	f.secrets[init.Member.ID] = init.Token.Secret
	f.admin = f.session(init.Member.ID, "ada-1")
	return f
}

// session returns a Caller for the Member through the Session id chosen.
func (f *fixture) session(memberID, chosen string) *auth.Caller {
	f.t.Helper()
	c, err := f.auth.Authenticate(f.t.Context(), auth.Credentials{Bearer: f.secrets[memberID], Session: chosen})
	if err != nil {
		f.t.Fatalf("authenticate %s: %v", chosen, err)
	}
	return c
}

func (f *fixture) team(key string) string {
	f.t.Helper()
	tm, err := f.svc.CreateTeam(f.t.Context(), f.admin, key, "Team "+key, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return tm.ID
}

func (f *fixture) skill(name string) string {
	f.t.Helper()
	d, err := f.svc.CreateSkill(f.t.Context(), f.admin, core.NewSkill{Name: name, Kind: "generic", Body: name + " well"}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Skill.ID
}

// member creates an agent Member in teams with skills, a token, and returns a Caller through a
// Session named after it.
func (f *fixture) member(name string, teams, skills []string) *auth.Caller {
	f.t.Helper()
	ctx := f.t.Context()
	m, err := f.svc.CreateMember(ctx, f.admin, core.NewMember{Name: name, Kind: "agent"}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	for _, tm := range teams {
		if err := f.svc.AddTeamMember(ctx, f.admin, tm, m.ID, core.Idem{}); err != nil {
			f.t.Fatal(err)
		}
	}
	for _, sk := range skills {
		if err := f.svc.GrantSkill(ctx, f.admin, m.ID, sk, core.Idem{}); err != nil {
			f.t.Fatal(err)
		}
	}
	tok, err := f.svc.IssueToken(ctx, f.admin, m.ID, "main", 0, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	f.secrets[m.ID] = tok.Secret
	return f.session(m.ID, name+"-1")
}

// feature files a Feature in team as c, and returns it with its Break down.
func (f *fixture) feature(c *auth.Caller, team, title string) core.FeatureDetail {
	f.t.Helper()
	d, err := f.svc.FileFeature(f.t.Context(), c, core.NewFeature{Team: team, Title: title}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d
}

// task files a work Task needing skill on feature.
func (f *fixture) task(c *auth.Caller, feature, title, skill string) core.Task {
	f.t.Helper()
	d, err := f.svc.FileTask(f.t.Context(), c, core.NewTask{Feature: &feature, Title: title, Skill: &skill}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Task
}

func (f *fixture) aimed(c *auth.Caller, feature, title, member string) core.Task {
	f.t.Helper()
	d, err := f.svc.FileTask(f.t.Context(), c, core.NewTask{Feature: &feature, Title: title, AimedAt: &member}, core.Idem{})
	if err != nil {
		f.t.Fatal(err)
	}
	return d.Task
}

func (f *fixture) exec(query string, args ...any) {
	f.t.Helper()
	if err := f.st.WriteBatchNoSeq(f.t.Context(), store.Stmt{SQL: query, Args: args}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.st.QueryRow(f.t.Context(), query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) takeable(c *auth.Caller) map[string]bool {
	f.t.Helper()
	ts, err := f.svc.ListTakeable(f.t.Context(), c, 0)
	if err != nil {
		f.t.Fatal(err)
	}
	out := map[string]bool{}
	for _, t := range ts {
		out[t.ID] = true
	}
	return out
}

func timeout(d time.Duration) core.ClaimOptions { return core.ClaimOptions{Timeout: &d} }

var noTimeout = timeout(0)

func codeOf(err error) core.Code {
	var e *core.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func wantCode(t *testing.T, err error, code core.Code) {
	t.Helper()
	if codeOf(err) != code {
		t.Fatalf("err = %v, want %s", err, code)
	}
}

// jsonIdem keeps results and refusals as their JSON, as the server does.
func jsonIdem(key, hash string) core.Idem {
	return core.Idem{Key: key, Hash: hash, Render: func(v any) (int, []byte, error) {
		b, err := json.Marshal(v)
		return 200, b, err
	}, RenderRefusal: func(e *core.Error) (int, []byte, error) {
		b, err := json.Marshal(map[string]string{"code": string(e.Code), "message": e.Message})
		return 409, b, err
	}}
}

// answer is what the server sends for a write's outcome.
type answer struct {
	status int
	body   []byte
}

// answerOf is the answer to a write under idem: its result, the response kept under the key, or
// its refusal. It may run on any goroutine.
func answerOf(t *testing.T, idem core.Idem, result any, err error) answer {
	t.Helper()
	var replay *core.Replay
	var refusal *core.Error
	switch {
	case err == nil:
		b, err := json.Marshal(result)
		if err != nil {
			t.Error(err)
		}
		return answer{200, b}
	case errors.As(err, &replay):
		return answer{replay.Status, replay.Body}
	case errors.As(err, &refusal):
		status, b, err := idem.RenderRefusal(refusal)
		if err != nil {
			t.Error(err)
		}
		return answer{status, b}
	}
	t.Errorf("unexpected error: %v", err)
	return answer{}
}

// checkActivity checks that the Organisation's Activity is numbered 1…n without gaps and that the
// counter agrees.
func (f *fixture) checkActivity() int {
	f.t.Helper()
	rows, err := f.st.Query(f.t.Context(), `SELECT seq FROM activity WHERE org_id = $1 ORDER BY seq`, f.admin.OrgID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			f.t.Fatal(err)
		}
		n++
		if seq != int64(n) {
			f.t.Fatalf("Activity has a gap: entry %d is numbered %d", n, seq)
		}
	}
	if c := f.count(`SELECT seq FROM organisations WHERE id = $1`, f.admin.OrgID); c != n {
		f.t.Fatalf("counter is %d with %d Activity entries", c, n)
	}
	return n
}

func name(prefix string, i int) string { return fmt.Sprintf("%s%02d", prefix, i) }
