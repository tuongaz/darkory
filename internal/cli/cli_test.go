package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/core"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// The claim path through the CLI against a real server: file a Feature and a Task, list what is
// takeable, next, claim, heartbeat, release and complete, each with --json decoding as the /v1
// type it prints.
func TestClaimPath(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		bob := in.as("bob", "bob-1")

		fd := in.seed("bob", core.NewTask{Project: ptr("WEB"), Title: "Search", Breakdown: true})
		if fd.Task.Key != "WEB-1" || len(fd.Subtasks) != 1 || fd.Subtasks[0].Kind != "breakdown" {
			t.Fatalf("filed: %+v", fd)
		}
		breakdown := fd.Subtasks[0].Key
		filed := in.seed("bob", core.NewTask{Parent: ptr("WEB-1"), Step: ptr("Build"), Title: "Build search", Description: "Index it."})
		build := filed.Task.Key
		if filed.Task.Description != "Index it." || filed.Parent.Key != "WEB-1" {
			t.Fatalf("file: %+v", filed)
		}

		var takeable client.TaskList
		bob.json(&takeable, "takeable")
		if len(takeable.Items) != 2 || takeable.Items[0].Key != breakdown {
			t.Fatalf("takeable: %+v", takeable)
		}

		// next offers the Break down first: the owner takes it, as no one in WEB has breakdown.
		var next client.TaskDetail
		bob.json(&next, "next", "--wait", "0", "--timeout", "1m", "--model", "test-model")
		cl := next.Task.Claim
		if next.Task.Key != breakdown || cl == nil || cl.SessionID != "bob-1" || deref(cl.HeartbeatTimeoutSeconds) != 60 ||
			deref(cl.ModelLabel) != "test-model" || cl.ExpiresAt == nil {
			t.Fatalf("next: %+v claim %+v", next.Task, cl)
		}

		// Flags may follow the Task.
		var claimed client.TaskDetail
		bob.json(&claimed, "claim", build, "--timeout", "90")
		if claimed.Task.Claim == nil || deref(claimed.Task.Claim.HeartbeatTimeoutSeconds) != 90 {
			t.Fatalf("claim: %+v", claimed.Task)
		}
		var hb client.HeartbeatReply
		bob.json(&hb, "heartbeat", build)
		if hb.Status != client.HeartbeatStatusOk || hb.ExpiresAt == nil {
			t.Fatalf("heartbeat: %+v", hb)
		}
		if out := bob.ok("heartbeat", build); !strings.Contains(out, "ok: your Claim on "+build) {
			t.Fatalf("heartbeat printed %q", out)
		}

		var released client.Task
		bob.json(&released, "release", breakdown, "--note", "later")
		if released.Claim != nil || released.State != client.TaskStateOpen {
			t.Fatalf("release: %+v", released)
		}
		var mine client.TaskList
		bob.json(&mine, "tasks", "--mine")
		if len(mine.Items) != 1 || mine.Items[0].Key != build {
			t.Fatalf("tasks --mine: %+v", mine)
		}

		var done client.Task
		bob.json(&done, "complete", build, "--note", "built")
		if done.State != client.TaskStateDone {
			t.Fatalf("complete: %+v", done)
		}
		var shown client.TaskDetail
		bob.json(&shown, "show", build)
		if len(shown.Claims) != 1 || deref(shown.Claims[0].HowEnded) != client.ClaimEndCompleted ||
			len(shown.Notes) != 1 || shown.Notes[0].Body != "built" {
			t.Fatalf("show: claims %+v notes %+v", shown.Claims, shown.Notes)
		}

		// Text output names Members and Skills rather than printing their ids.
		text := bob.ok("show", build)
		for _, want := range []string{build + "  Build search", "bob as engineer:", "built", "(completed)"} {
			if !strings.Contains(text, want) {
				t.Errorf("show printed no %q:\n%s", want, text)
			}
		}
		if text := bob.ok("tasks", "--feature", "WEB-1"); !strings.Contains(text, breakdown) || !strings.Contains(text, "done") {
			t.Errorf("tasks printed:\n%s", text)
		}
		if text := bob.ok("me"); !strings.Contains(text, "bob (agent) in Acme") || !strings.Contains(text, "Session  bob-1") {
			t.Errorf("me printed:\n%s", text)
		}

		var page client.ActivityPage
		bob.json(&page, "activity")
		kinds := map[string]int{}
		for _, a := range page.Items {
			kinds[string(a.Kind)]++
		}
		if kinds["task.claimed"] != 2 || kinds["task.released"] != 1 || kinds["task.completed"] != 1 || page.LastSeq == 0 {
			t.Fatalf("activity kinds %v", kinds)
		}
	})
}

// Exit statuses: 3 for a refusal on a rule of the record, 4 when next finds nothing, 2 for usage
// and missing settings, 1 for other failures; errors print their code and message.
func TestExitStatuses(t *testing.T) {
	in := newInstall(t, storetest.Open(t, store.SQLite))
	in.setup()
	in.agent("carol", "WEB")
	bob, carol := in.as("bob", "bob-1"), in.as("carol", "carol-1")
	in.search("one", "two", "three", "four")
	bob.ok("claim", "WEB-3", "--timeout", "60")

	res := carol.fails(ExitRefused, "claim", "WEB-3", "--timeout", "60")
	if !strings.HasPrefix(res.stderr, "darkory: already_claimed: ") {
		t.Errorf("already_claimed printed %q", res.stderr)
	}
	res = carol.fails(ExitRefused, "claim", "WEB-3", "--json")
	var e struct{ Code, Message string }
	if err := json.Unmarshal([]byte(res.stderr), &e); err != nil || e.Code != "already_claimed" || e.Message == "" || res.stdout != "" {
		t.Errorf("--json error: stdout %q stderr %q", res.stdout, res.stderr)
	}
	if res := carol.fails(ExitRefused, "complete", "WEB-3"); !strings.Contains(res.stderr, "not_holder") {
		t.Errorf("complete by another: %q", res.stderr)
	}
	if res := carol.fails(ExitRefused, "claim", "WEB-4"); !strings.Contains(res.stderr, "not_takeable") {
		t.Errorf("claim without the Skill: %q", res.stderr)
	}
	if res := carol.fails(ExitNothing, "next", "--wait", "0"); !strings.Contains(res.stderr, "No Task became takeable") {
		t.Errorf("next with nothing: %q", res.stderr)
	}
	if res := carol.fails(ExitNothing, "next", "--wait", "0", "--json"); res.stdout != "" || res.stderr != "" {
		t.Errorf("next --json with nothing printed %q and %q", res.stdout, res.stderr)
	}
	if res := bob.fails(ExitFailed, "show", "WEB-99"); !strings.Contains(res.stderr, "not_found") {
		t.Errorf("show of nothing: %q", res.stderr)
	}

	bob.fails(ExitUsage, "claim")
	bob.fails(ExitUsage, "claim", "WEB-4", "--timeout", "soon")
	bob.fails(ExitUsage, "claim", "WEB-4", "WEB-5")
	bob.fails(ExitUsage, "nonsense")
	bob.fails(ExitUsage, "file", "--feature", "WEB-1", "--title", "neither skill nor aim")
	if res := bob.run("claim", "--help"); res.code != ExitOK || !strings.Contains(res.stderr, "Usage: darkory claim <task>") {
		t.Errorf("claim --help: %+v", res)
	}
	tokenless := &runner{t: t, env: map[string]string{"DARKORY_URL": in.ts.URL}}
	if res := tokenless.fails(ExitUsage, "me"); !strings.Contains(res.stderr, "DARKORY_TOKEN") {
		t.Errorf("no token: %q", res.stderr)
	}

	// Without DARKORY_SESSION, what would strand a Session-bound Claim refuses; the rest runs in a
	// Session of its own.
	nosession := in.as("bob", "")
	for _, args := range [][]string{{"claim", "WEB-4"}, {"claim", "WEB-4", "--timeout", "30"}, {"next", "--wait", "0"},
		{"heartbeat", "WEB-3"}, {"heartbeat", "run"}, {"session", "close"}} {
		if res := nosession.fails(ExitUsage, args...); !strings.Contains(res.stderr, `eval "$(darkory prime)"`) {
			t.Errorf("%v without a Session: %q", args, res.stderr)
		}
	}
	if out := nosession.ok("me"); !strings.Contains(out, "made up for this command") {
		t.Errorf("me without a Session: %q", out)
	}
	nosession.ok("claim", "WEB-4", "--timeout", "0")
	nosession.ok("release", "WEB-4") // bound to the Member, so another Session may release it
	if res := nosession.fails(ExitRefused, "complete", "WEB-3"); !strings.Contains(res.stderr, "DARKORY_SESSION is not set") {
		t.Errorf("complete of a Session-bound Claim without a Session: %q", res.stderr)
	}

	// A Heartbeat that finds the Claim lapsed is a refusal.
	bob.ok("claim", "WEB-5", "--timeout", "1")
	time.Sleep(1200 * time.Millisecond)
	if res := bob.fails(ExitRefused, "heartbeat", "WEB-5"); !strings.Contains(res.stderr, "lapsed") {
		t.Errorf("late heartbeat: %q", res.stderr)
	}
}

// dropReply forwards each request, then loses the reply of the first one match accepts, as a
// network dropping the connection after the server answered.
type dropReply struct {
	base  http.RoundTripper
	match func(*http.Request) bool

	mu      sync.Mutex
	dropped bool
	keys    []string
}

func (d *dropReply) RoundTrip(req *http.Request) (*http.Response, error) {
	if !d.match(req) {
		return d.base.RoundTrip(req)
	}
	d.mu.Lock()
	d.keys = append(d.keys, req.Header.Get("Idempotency-Key"))
	drop := !d.dropped
	d.dropped = true
	d.mu.Unlock()
	res, err := d.base.RoundTrip(req)
	if err != nil || !drop {
		return res, err
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return nil, errors.New("connection reset by peer")
}

// A write whose reply is lost is sent again once with the same Idempotency-Key, and the Install
// answers the retry with the first result rather than writing twice.
func TestRetryAfterALostReplyWritesOnce(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		bob := in.as("bob", "bob-1")
		in.search()

		filing := &dropReply{base: http.DefaultTransport, match: func(r *http.Request) bool {
			return r.Method == http.MethodPost && r.URL.Path == "/v1/tasks"
		}}
		flaky := in.as("bob", "bob-1")
		flaky.hc = &http.Client{Transport: filing}
		var filed client.TaskDetail
		flaky.json(&filed, "file", "--feature", "WEB-1", "--aim", "bob", "--title", "Once")
		var list client.TaskList
		bob.json(&list, "tasks", "--feature", "WEB-1")
		if n := countTitle(list.Items, "Once"); n != 1 || len(filing.keys) != 2 || filing.keys[0] == "" || filing.keys[0] != filing.keys[1] {
			t.Fatalf("filed %d Tasks with keys %q", n, filing.keys)
		}

		// next claims, the reply is lost, and the retry returns the same Claim.
		claiming := &dropReply{base: http.DefaultTransport, match: func(r *http.Request) bool {
			return r.URL.Path == "/v1/tasks/next"
		}}
		flaky.hc = &http.Client{Transport: claiming}
		var next client.TaskDetail
		flaky.json(&next, "next", "--wait", "0", "--timeout", "60")
		var shown client.TaskDetail
		bob.json(&shown, "show", next.Task.Key)
		if len(claiming.keys) != 2 || claiming.keys[0] != claiming.keys[1] || len(shown.Claims) != 1 ||
			next.Task.Claim == nil || shown.Claims[0].ID != next.Task.Claim.ID {
			t.Fatalf("keys %q, Claims %+v, next %+v", claiming.keys, shown.Claims, next.Task.Claim)
		}
		var page client.ActivityPage
		bob.json(&page, "activity")
		claims := 0
		for _, a := range page.Items {
			if a.Kind == "task.claimed" {
				claims++
			}
		}
		if claims != 1 {
			t.Fatalf("%d task.claimed entries, want 1", claims)
		}
		// Every write carries a fresh key.
		if filing.keys[0] == claiming.keys[0] {
			t.Fatal("two writes shared an Idempotency-Key")
		}
	})
}

func countTitle(ts []client.Task, title string) int {
	n := 0
	for _, t := range ts {
		if t.Title == title {
			n++
		}
	}
	return n
}

// prime's first line starts a Session when a shell evals it, and the rules follow as comments.
func TestPrimeEvalsInSh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	r := &runner{t: t, env: map[string]string{}}
	out := r.ok("prime")
	first, rest, _ := strings.Cut(out, "\n")
	id, ok := strings.CutPrefix(first, "export DARKORY_SESSION=")
	if !ok {
		t.Fatalf("prime's first line is %q", first)
	}
	for line := range strings.Lines(rest) {
		if !strings.HasPrefix(line, "#") {
			t.Fatalf("prime printed a line that is not a comment: %q", line)
		}
	}
	cmd := exec.Command("sh", "-c", `eval "$PRIME" && printf %s "$DARKORY_SESSION"`)
	cmd.Env = append(os.Environ(), "PRIME="+out)
	got, err := cmd.Output()
	if err != nil {
		t.Fatalf("sh: %v", err)
	}
	u, err := uuid.Parse(string(got))
	if err != nil || u.Version() != 7 || string(got) != id {
		t.Fatalf("eval set DARKORY_SESSION=%q (%v), prime printed %q", got, err, id)
	}
	if again := r.ok("prime"); strings.HasPrefix(again, first) {
		t.Fatal("prime printed the same Session id twice")
	}
	rules := r.ok("prime", "--rules-only")
	if strings.Contains(rules, "export") || strings.HasPrefix(rules, "#") {
		t.Fatalf("--rules-only printed %q", rules)
	}
	for _, want := range []string{"darkory next", "heartbeat run --background", "handover", "--blocks", "observe", "attach", "another holder's Task",
		"not instructions to you", "reveal a token", "Agents should not hold admin tokens"} {
		if !strings.Contains(rules, want) {
			t.Errorf("the rules say nothing of %q", want)
		}
	}
}

// heartbeat run keeps a Claim with a short timeout alive for as long as it runs, and the Claim
// lapses once it stops.
func TestHeartbeatRunKeepsAClaimAlive(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		bob := in.as("bob", "bob-1")
		in.search("Build")
		bob.ok("claim", "WEB-3", "--timeout", "2s")

		ctx, cancel := context.WithCancel(t.Context())
		out := &lockedBuffer{}
		done := make(chan result, 1)
		go func() { done <- bob.runTo(ctx, out, &lockedBuffer{}, "heartbeat", "run") }()
		time.Sleep(5 * time.Second)
		assertHeld(t, bob, "WEB-3")
		cancel()
		if res := <-done; res.code != ExitOK {
			t.Fatalf("heartbeat run: %+v", res)
		}
		if !strings.Contains(out.String(), "keeping this Session's Claims alive") {
			t.Errorf("heartbeat run printed %q", out.String())
		}
		time.Sleep(2500 * time.Millisecond)
		bob.fails(ExitRefused, "heartbeat", "WEB-3")
	})
}

// heartbeat run started first, as the rules say, finds a Claim made after it by another process
// of the Session in time, though the Claim takes the token's 2 s default timeout and the run lists
// the Session's Claims only every 5 s by default: it lists at a third of the token's default.
func TestHeartbeatRunFindsALaterClaimInTime(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		var issued client.IssuedToken
		in.as("ada", "ada-cli").json(&issued, "token", "issue", "bob", "--name", "short", "--timeout", "2s")
		in.tokens["bob-short"] = issued.Secret
		bob := in.as("bob-short", "bob-1")
		in.search("Build")

		ctx, cancel := context.WithCancel(t.Context())
		out := &lockedBuffer{}
		done := make(chan result, 1)
		go func() { done <- bob.runTo(ctx, out, &lockedBuffer{}, "heartbeat", "run") }()
		eventually(t, 5*time.Second, "heartbeat run to start", func() bool {
			return strings.Contains(out.String(), "keeping this Session's Claims alive")
		})
		time.Sleep(300 * time.Millisecond) // past its first list
		var claimed client.TaskDetail
		bob.json(&claimed, "claim", "WEB-3")
		if *claimed.Task.Claim.HeartbeatTimeoutSeconds != 2 {
			t.Fatalf("bob took %+v", claimed.Task)
		}
		time.Sleep(6 * time.Second)
		assertHeldOr(t, bob, "WEB-3", out.String())
		cancel()
		if res := <-done; res.code != ExitOK {
			t.Fatalf("heartbeat run: %+v", res)
		}
	})
}

// assertHeld fails unless task's Claim is live, read without sending a Heartbeat.
func assertHeld(t *testing.T, r *runner, task string) {
	t.Helper()
	var d client.TaskDetail
	r.json(&d, "show", task)
	if d.Task.Claim == nil || d.Task.Claim.ExpiresAt == nil || !d.Task.Claim.ExpiresAt.After(time.Now()) || len(d.Claims) != 1 {
		t.Fatalf("%s is not held: %+v, Claims %+v", task, d.Task.Claim, d.Claims)
	}
}

// heartbeat run --background starts a detached copy that keeps the Claim alive until heartbeat
// stop; the test binary stands in for darkory.
func TestHeartbeatRunInTheBackground(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the test stands the test binary in for darkory with a Unix cache directory")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))
	t.Setenv("DARKORY_CLI_TEST_AS_DARKORY", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	in := newInstall(t, storetest.Open(t, store.SQLite))
	in.setup()
	bob := in.as("bob", "bob-bg")
	bob.exe = exe
	in.search("Build")
	bob.ok("claim", "WEB-3", "--timeout", "2s")

	out := bob.ok("heartbeat", "run", "--background")
	t.Cleanup(func() { bob.run("heartbeat", "stop") })
	if !strings.Contains(out, "run in the background (pid ") {
		t.Fatalf("--background printed %q", out)
	}
	if again := bob.ok("heartbeat", "run", "--background"); !strings.Contains(again, "already runs") {
		t.Fatalf("a second --background printed %q", again)
	}
	time.Sleep(5 * time.Second)
	files, _ := heartbeatFiles(bob.settings())
	logged, _ := os.ReadFile(files.log)
	assertHeldOr(t, bob, "WEB-3", string(logged))
	if out := bob.ok("heartbeat", "stop"); !strings.Contains(out, "Stopped") {
		t.Fatalf("heartbeat stop printed %q", out)
	}
	if out := bob.ok("heartbeat", "stop"); !strings.Contains(out, "No background heartbeat") {
		t.Fatalf("a second heartbeat stop printed %q", out)
	}
	time.Sleep(2500 * time.Millisecond)
	bob.fails(ExitRefused, "heartbeat", "WEB-3")

	// A copy that ends on its own, here when its Session is closed and its token revoked, removes
	// its pid file.
	bob.ok("heartbeat", "run", "--background")
	var tokens client.TokenList
	bob.json(&tokens, "token", "list")
	in.as("ada", "ada-1").ok("token", "revoke", tokens.Items[0].ID)
	eventually(t, 15*time.Second, "the copy to remove its pid file", func() bool {
		_, err := os.Stat(files.pid)
		return os.IsNotExist(err)
	})
	if logged, _ := os.ReadFile(files.log); !strings.Contains(string(logged), "no longer accepts this token") {
		t.Fatalf("the copy logged:\n%s", logged)
	}
}

func assertHeldOr(t *testing.T, r *runner, task, log string) {
	t.Helper()
	var d client.TaskDetail
	r.json(&d, "show", task)
	if d.Task.Claim == nil {
		t.Fatalf("%s is not held; the background heartbeat logged:\n%s", task, log)
	}
}

// activity --follow prints entries as they are written.
func TestActivityFollow(t *testing.T) {
	storetest.Each(t, func(t *testing.T, st *store.Store) {
		in := newInstall(t, st)
		in.setup()
		ada, bob := in.as("ada", "ada-1"), in.as("bob", "bob-1")

		var before client.ActivityPage
		ada.json(&before, "activity")
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		out := &lockedBuffer{}
		done := make(chan result, 1)
		go func() {
			done <- ada.runTo(ctx, out, &lockedBuffer{}, "activity", "--follow", "--json", "--after", jsonInt(before.LastSeq))
		}()
		in.search()
		eventually(t, 10*time.Second, "task.filed on the stream", func() bool {
			return strings.Contains(out.String(), `"task.filed"`)
		})
		cancel()
		if res := <-done; res.code != ExitOK {
			t.Fatalf("activity --follow: %+v", res)
		}
		var last int64
		for line := range strings.Lines(out.String()) {
			var a client.Activity
			if err := json.Unmarshal([]byte(line), &a); err != nil {
				t.Fatalf("a line that is not an Activity: %q", line)
			}
			if a.Seq <= before.LastSeq || a.Seq <= last {
				t.Fatalf("entry %d out of order after %d", a.Seq, last)
			}
			last = a.Seq
		}

		// Text output, from the first entry.
		ctx2, cancel2 := context.WithCancel(t.Context())
		defer cancel2()
		text := &lockedBuffer{}
		go func() { done <- ada.runTo(ctx2, text, &lockedBuffer{}, "activity", "--follow", "--all") }()
		eventually(t, 10*time.Second, "the text stream", func() bool {
			return strings.Contains(text.String(), "bob") && strings.Contains(text.String(), "task.filed")
		})
		cancel2()
		<-done

		// Without --after or --all, following starts from now.
		ctx3, cancel3 := context.WithCancel(t.Context())
		defer cancel3()
		now := &lockedBuffer{}
		go func() { done <- ada.runTo(ctx3, now, &lockedBuffer{}, "activity", "--follow", "--json") }()
		time.Sleep(300 * time.Millisecond)
		bob.ok("file", "--feature", "WEB-1", "--aim", "bob", "--title", "After")
		eventually(t, 10*time.Second, "the new Task on the stream", func() bool { return strings.Contains(now.String(), `"task.filed"`) })
		cancel3()
		<-done
		if strings.Contains(now.String(), `"title":"Search"`) {
			t.Fatalf("following from now sent history:\n%s", now.String())
		}
	})
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
