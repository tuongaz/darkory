package e2e

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
)

// The Runner end to end (docs/build/agents-plan.md, the scenarios): darkory init seeds its roster
// in a fresh git repository, every agent runs tools/fakeagent as its command, and darkory serve
// runs the Runner beside the server, its clocks shortened, sessions as child processes. The
// scenarios: a Feature from Break down to Ship across two Workspaces with two builders (2, 3, 4,
// 11), sessions that end without a decision, go stale or are taken back (5, 6, 7), a quick Feature
// and a ship-when-done one (4), a merge conflict (9), darkory agents beside serve --agents=off
// (12), and a session in tmux stopped by an admin, when tmux is installed.

// runnerTimings make a session take a second or two.
// The Claims' timeout leaves a loaded machine room for late Heartbeats; a hung session still lapses
// within about 12 s.
const runnerTimings = "wait=1s,timeout=10s,tick=200ms,stale=2s,nudge=700ms,exit=3s,poll=1s,retry=300ms"

var (
	fakeOnce sync.Once
	fakeBin  string
	fakeErr  error
)

// fakeAgent builds tools/fakeagent next to the darkory binary, once.
func fakeAgent(t *testing.T) string {
	t.Helper()
	fakeOnce.Do(func() {
		fakeBin = filepath.Join(filepath.Dir(bin), "fakeagent")
		cmd := exec.Command("go", "build", "-o", fakeBin, "./tools/fakeagent")
		cmd.Dir = ".."
		if out, err := cmd.CombinedOutput(); err != nil {
			fakeErr = fmt.Errorf("building fakeagent: %v\n%s", err, out)
		}
	})
	if fakeErr != nil {
		t.Fatal(fakeErr)
	}
	return fakeBin
}

// newRepo makes a git repository on main with one commit, whose user is set.
func newRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	repoGit(t, repo, "init", "-q", "-b", "main")
	repoGit(t, repo, "config", "user.name", "Ada")
	repoGit(t, repo, "config", "user.email", "ada@example.com")
	writeFile(t, filepath.Join(repo, "README"), "the product\n")
	repoGit(t, repo, "add", "README")
	repoGit(t, repo, "commit", "-q", "-m", "first")
	return repo
}

// repoGit runs git in dir, with no global or system configuration, and returns its output.
func repoGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

// gitOK says whether git succeeds in dir.
func gitOK(dir string, args ...string) bool {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd.Run() == nil
}

// runnerInstall is an Install init seeded with its roster in a fresh repository: Team MAIN, the
// repository as its default Workspace, and planner, builder, reviewer and retro, each with a
// token in <data>/agents and the fake agent as its command.
type runnerInstall struct {
	*install
	repo, ws string
	progress string
	srv      *serveProc
}

// newRunnerInstall makes a runnerInstall, lets setup add to it while no Runner runs, then starts
// the server with serveArgs (--agents=on unless they say).
func newRunnerInstall(t *testing.T, setup func(ri *runnerInstall), serveArgs ...string) *runnerInstall {
	t.Helper()
	needE2E(t)
	fakeAgent(t)
	repo := newRepo(t)
	ri := &runnerInstall{install: &install{t: t, dir: t.TempDir(), wd: repo}, repo: repo, progress: t.TempDir()}
	in := ri.install
	in.db = filepath.Join(in.dir, "darkory.db")
	if postgresURL() != "" {
		in.db = newDatabase(t)
	}
	res := in.exec(in.env(), "init", "--org", "Acme", "--name", "ada", "--data", in.dir, "--db", in.db)
	if res.code != 0 {
		t.Fatalf("darkory init: exit %d\n%s%s", res.code, res.stdout, res.stderr)
	}
	token := regexp.MustCompile(`(?m)^\s+(dk_\S+)$`).FindStringSubmatch(res.stdout)
	if token == nil {
		t.Fatalf("no token in darkory init's output:\n%s", res.stdout)
	}
	in.serveEnv = []string{"DARKORY_RUNNER_TIMINGS=" + runnerTimings, "DARKORY_RUNNER_TMUX=off"}
	// Set the agents up with no Runner running, so none starts the roster's Claude Code.
	first := in.serve("--agents=off")
	in.ada = &member{in: in, name: "ada", token: token[1], url: first.url}
	in.ada.session = in.ada.prime()
	var me client.Me
	in.ada.json(&me, "me")
	in.ada.id = me.Member.ID
	var list client.WorkspaceList
	in.ada.json(&list, "workspace", "list")
	if len(list.Items) != 1 || list.Items[0].Path != realPath(t, ri.repo) {
		t.Fatalf("init made the Workspaces %+v, not the repository it ran in", list.Items)
	}
	ri.ws = list.Items[0].Name
	for name, scenario := range map[string]string{"planner": "complete", "builder": "handover", "reviewer": "complete", "retro": "complete"} {
		ri.fake(name, scenario)
	}
	if setup != nil {
		setup(ri)
	}
	first.stop()
	in.servers = nil
	if len(serveArgs) == 0 {
		serveArgs = []string{"--agents=on"}
	}
	ri.srv = in.serve(serveArgs...)
	in.ada.url = ri.srv.url
	return ri
}

// wait is eventually, showing the record and what the Runner did when cond never holds.
func (ri *runnerInstall) wait(within time.Duration, what string, cond func() bool) {
	ri.t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			ri.t.Logf("the Tasks:\n%s", ri.ada.run("tasks").stdout)
			var lines []string
			for _, l := range strings.Split(ri.srv.log.String(), "\n") {
				if strings.Contains(l, "component=runner") {
					lines = append(lines, l)
				}
			}
			ri.t.Fatalf("%s did not happen within %s; the Runner's log:\n%s", what, within, strings.Join(lines, "\n"))
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// fake makes an agent's command the fake agent in scenario, with env added.
func (ri *runnerInstall) fake(agent, scenario string, env ...string) {
	ri.t.Helper()
	progress := filepath.Join(ri.progress, "{session_id}.jsonl")
	args := []string{"agent", "set", agent, "--command", fakeBin, "--model", "fake-1", "--unattended", "--paused=false",
		"--progress-file", progress, "--arg=--prompt-file", "--arg={prompt_file}", "--arg=--progress", "--arg=" + progress,
		"--arg=--mcp-config", "--arg={mcp_config}", "--env", "FAKEAGENT_SCENARIO=" + scenario}
	for _, e := range env {
		args = append(args, "--env", e)
	}
	ri.ada.ok(args...)
}

// agent makes another agent Member in Team MAIN with skills, reporting to ada, with a token in
// <data>/agents for the Runner and the fake agent in scenario as its command.
func (ri *runnerInstall) agent(name, scenario string, skills ...string) {
	ri.t.Helper()
	ada := ri.ada
	ada.ok("member", "create", name, "--kind", "agent")
	ada.ok("team", "add", "MAIN", name)
	ada.ok("report-to", name, "ada")
	for _, s := range skills {
		ada.ok("grant", name, s)
	}
	var tok client.IssuedToken
	ada.json(&tok, "token", "issue", name, "--name", "runner")
	writeFile(ri.t, filepath.Join(ri.dir, "agents", name+".token"), tok.Secret+"\n")
	ri.fake(name, scenario)
}

func (ri *runnerInstall) task(key string) client.TaskDetail {
	ri.t.Helper()
	var d client.TaskDetail
	ri.ada.json(&d, "show", key)
	return d
}

func (ri *runnerInstall) feature(key string) client.FeatureDetail {
	ri.t.Helper()
	var d client.FeatureDetail
	ri.ada.json(&d, "feature", "show", key)
	return d
}

// evidence downloads the last Evidence named filename on Task key; "" when there is none.
func (ri *runnerInstall) evidence(key, filename string) string {
	ri.t.Helper()
	var id string
	for _, e := range ri.task(key).Evidence {
		if e.Filename == filename {
			id = e.ID
		}
	}
	if id == "" {
		return ""
	}
	return ri.ada.ok("evidence", "get", id, "-o", "-")
}

// featureEvidence downloads the last Evidence named filename on Feature key itself.
func (ri *runnerInstall) featureEvidence(key, filename string) string {
	ri.t.Helper()
	var id string
	for _, e := range ri.feature(key).Evidence {
		if e.Filename == filename && e.TaskID == nil {
			id = e.ID
		}
	}
	if id == "" {
		return ""
	}
	return ri.ada.ok("evidence", "get", id, "-o", "-")
}

func names(list []client.Evidence) []string {
	var out []string
	for _, e := range list {
		out = append(out, e.Filename)
	}
	return out
}

func notes(d client.TaskDetail) string {
	var b strings.Builder
	for _, n := range d.Notes {
		b.WriteString(n.Body + "\n")
	}
	return b.String()
}

func done(d client.TaskDetail) bool { return d.Task.State == client.TaskStateDone }

// Scenarios 2, 3, 4 and 11: the planner's session breaks a Feature down on feature/MAIN-1 into two
// Tasks that each name both Workspaces; two builders work them at once, each in one directory with
// both checkouts, commit, attach a test log and hand over; the reviewer completes each and the
// Runner merges its branch into the Feature's in both repositories; Ship merges that into main.
func TestRunnerWorksAFeature(t *testing.T) {
	repo2 := newRepo(t)
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.ada.ok("workspace", "add", "web2", "--path", repo2)
		ri.fake("planner", "complete", "FAKEAGENT_BREAKDOWN=engineer:Cart page;engineer:Totals", "FAKEAGENT_WORKSPACES="+ri.ws+",web2")
		ri.agent("builder2", "handover", "engineer")
	})
	ada := ri.ada
	ada.ok("feature", "create", "--team", "MAIN", "--title", "Checkout")

	ri.wait(15*time.Second, "the Break down done", func() bool { return done(ri.task("MAIN-2")) })
	if !gitOK(ri.repo, "rev-parse", "--verify", "feature/MAIN-1") {
		t.Fatal("no feature/MAIN-1 after the Break down")
	}
	ri.wait(60*time.Second, "MAIN-3 and MAIN-4 done", func() bool { return done(ri.task("MAIN-3")) && done(ri.task("MAIN-4")) })
	for _, key := range []string{"MAIN-3", "MAIN-4"} {
		ri.wait(15*time.Second, key+"'s merge recorded", func() bool { return ri.evidence(key, "merge-"+key+".txt") != "" })
		d := ri.task(key)
		if got := repoGit(t, ri.repo, "show", "feature/MAIN-1:fakeagent-"+key+".txt"); !strings.Contains(got, key+" worked by fakeagent") {
			t.Fatalf("feature/MAIN-1 holds %q for %s", got, key)
		}
		if merged := ri.evidence(key, "merge-"+key+".txt"); !strings.Contains(merged, "Merged "+key+"/") || !strings.Contains(merged, "into feature/MAIN-1 at") {
			t.Errorf("%s's merge record: %q", key, merged)
		}
		if !strings.Contains(notes(d), "fakeagent: built; please review") || !strings.Contains(notes(d), "fakeagent: done") || !slices.Contains(names(d.Evidence), "test-"+key+".log") {
			t.Errorf("%s: Notes\n%sEvidence %v", key, notes(d), names(d.Evidence))
		}
		// Both Workspaces were checked out side by side in the Task's directory, on its branch.
		for _, repo := range []string{ri.repo, repo2} {
			if repoGit(t, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"+key+"/") == "" {
				t.Errorf("no %s branch in %s", key, repo)
			}
		}
		log := ri.evidence(key, "session-"+key+".log") + ri.featureEvidence("MAIN-1", "session-"+key+".log")
		for _, dir := range []string{filepath.Join("workspaces", key, ri.ws), filepath.Join("workspaces", key, "web2")} {
			if !strings.Contains(log, dir) {
				t.Errorf("%s's session did not work in %s:\n%s", key, dir, log)
			}
		}
	}
	// Two builders took the two Tasks.
	var holders []string
	for _, key := range []string{"MAIN-3", "MAIN-4"} {
		holders = append(holders, ri.task(key).Claims[0].HolderID)
	}
	t.Logf("MAIN-3 and MAIN-4 were built by %v", holders)

	// Ship lands feature/MAIN-1 on main, in the repository's own checkout.
	ada.ok("feature", "ship", "MAIN-1")
	ri.wait(15*time.Second, "the Ship's merge recorded", func() bool { return ri.featureEvidence("MAIN-1", "merge-MAIN-1.txt") != "" })
	for _, key := range []string{"MAIN-3", "MAIN-4"} {
		if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-"+key+".txt")); err != nil {
			t.Errorf("main's checkout lacks %s's work: %v", key, err)
		}
	}
	if got := ri.featureEvidence("MAIN-1", "merge-MAIN-1.txt"); !strings.Contains(got, "Merged feature/MAIN-1 into main at") {
		t.Errorf("the Ship's merge record: %q", got)
	}
	// The Retrospective Ship filed is worked by retro, and every worktree goes with its Task.
	ri.wait(30*time.Second, "the worktrees gone", func() bool {
		entries, _ := os.ReadDir(filepath.Join(ri.dir, "workspaces"))
		for _, e := range entries {
			if e.IsDir() {
				return false
			}
		}
		return true
	})
}

// Scenarios 5, 6 and 7: an agent that stops without a decision is nudged twice and released with
// a Note, and the third time a question to the Feature owner blocks its Task; a session that stops
// making progress gets no more Heartbeats, its Claim lapses, it is killed and its log is Evidence;
// a session whose Task is taken back ends, its log attached.
func TestRunnerEndsSessionsWithoutADecision(t *testing.T) {
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.ada.ok("agent", "set", "planner", "--paused")
		ri.agent("quiet", "silent", "engineer")
		ri.agent("stuck", "hang", "engineer")
		ri.agent("busy", "busy", "engineer")
	})
	ada := ri.ada
	ada.ok("feature", "create", "--team", "MAIN", "--title", "Checkout")
	ada.ok("file", "--feature", "MAIN-1", "--aim", "quiet", "--title", "Say nothing")
	ada.ok("file", "--feature", "MAIN-1", "--aim", "stuck", "--title", "Hang")
	ada.ok("file", "--feature", "MAIN-1", "--aim", "busy", "--title", "Keep busy")

	// 5: three releases without a decision, then the question.
	ri.wait(60*time.Second, "a question blocking MAIN-3, released", func() bool {
		d := ri.task("MAIN-3")
		return d.Task.Blocked && d.Task.Claim == nil
	})
	d := ri.task("MAIN-3")
	if n := strings.Count(notes(d), "Session ended without a decision after 2 nudges; exit code 0; last 20 lines:"); n != 3 {
		t.Errorf("%d releases after two nudges:\n%s", n, notes(d))
	}
	if !strings.Contains(notes(d), `fakeagent: read "You stopped without ending the Task: complete it, hand it over, or file a question."`) {
		t.Errorf("the nudge is not in the last lines:\n%s", notes(d))
	}
	q := ri.task((*d.Task.OpenBlockers)[0].Key)
	if q.Task.Title != "The runner released MAIN-3 three times without a decision" || q.Task.AimedAtID == nil || *q.Task.AimedAtID != ada.id {
		t.Errorf("the question: %+v", q.Task)
	}
	if d.Status.Name != "Todo" {
		t.Errorf("MAIN-3 is %s", d.Status.Name)
	}

	// 6: the hung session's Claim lapses on Darkory's rule, with no Heartbeat refused.
	ri.wait(30*time.Second, "MAIN-4's Claim to lapse", func() bool {
		var page client.ActivityPage
		ada.json(&page, "activity", "--kind", "task.lapsed", "--limit", "100")
		for _, a := range page.Items {
			if a.SubjectID == ri.task("MAIN-4").Task.ID && a.ActorID == nil {
				return true
			}
		}
		return false
	})
	ri.wait(15*time.Second, "the hung session's log", func() bool {
		return strings.Contains(ri.evidence("MAIN-4", "session-MAIN-4.log"), "fakeagent: hanging")
	})
	ada.ok("agent", "set", "stuck", "--paused")

	// 7: taken back while it works.
	ri.wait(15*time.Second, "busy at work on MAIN-5", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "sessions")
		return slices.ContainsFunc(list.Items, func(s client.RunnerSession) bool {
			return s.TaskID == ri.task("MAIN-5").Task.ID && s.State == client.RunnerSessionRunning
		})
	})
	ada.ok("agent", "set", "busy", "--paused") // so it takes the Task no more
	ada.ok("take-back", "MAIN-5", "--reason", "enough")
	ri.wait(15*time.Second, "the taken-back session to end, its log attached", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "sessions")
		return len(slices.DeleteFunc(list.Items, func(s client.RunnerSession) bool { return s.TaskID != ri.task("MAIN-5").Task.ID })) == 0 &&
			strings.Contains(ri.evidence("MAIN-5", "session-MAIN-5.log"), `fakeagent: read "/exit"`)
	})
	if d := ri.task("MAIN-5"); d.Status.Name != "Todo" || d.Task.Claim != nil {
		t.Errorf("MAIN-5 after the take-back: %s, %+v", d.Status.Name, d.Task.Claim)
	}
}

// Scenario 4: a quick Feature's one Task works on a branch from main, and its review's completion
// merges it into main and ships the Feature; a Feature filed to ship when done ships itself when
// its last Task is done, and its branch lands on main without a click.
func TestRunnerQuickAndShipWhenDone(t *testing.T) {
	ri := newRunnerInstall(t, nil)
	ada := ri.ada
	ada.ok("feature", "create", "--team", "MAIN", "--title", "Fix the typo", "--quick", "--skill", "engineer")
	ri.wait(30*time.Second, "the quick Feature shipped", func() bool { return ri.feature("MAIN-1").Feature.State == client.FeatureStateShipped })
	ri.wait(15*time.Second, "MAIN-2's merge recorded", func() bool { return ri.evidence("MAIN-2", "merge-MAIN-2.txt") != "" })
	if got := ri.evidence("MAIN-2", "merge-MAIN-2.txt"); !strings.Contains(got, "into main at") {
		t.Fatalf("the quick merge: %q", got)
	}
	if b, err := os.ReadFile(filepath.Join(ri.repo, "fakeagent-MAIN-2.txt")); err != nil || !strings.Contains(string(b), "MAIN-2") {
		t.Fatalf("main's checkout after the quick Feature: %q, %v", b, err)
	}
	if gitOK(ri.repo, "rev-parse", "--verify", "feature/MAIN-1") {
		t.Fatal("a quick Feature got a feature branch")
	}

	ada.ok("feature", "create", "--team", "MAIN", "--title", "Checkout", "--ship-when-done")
	ri.wait(60*time.Second, "the ship-when-done Feature shipped", func() bool { return ri.feature("MAIN-3").Feature.State == client.FeatureStateShipped })
	ri.wait(15*time.Second, "its Ship's merge recorded", func() bool { return ri.featureEvidence("MAIN-3", "merge-MAIN-3.txt") != "" })
	if got := ri.featureEvidence("MAIN-3", "merge-MAIN-3.txt"); !strings.Contains(got, "Merged feature/MAIN-3 into main at") {
		t.Fatalf("the Ship's merge: %q", got)
	}
	if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-MAIN-5.txt")); err != nil {
		t.Fatalf("main lacks MAIN-5's work: %v", err)
	}
}

// Scenario 9: two Tasks of one Feature change the same file; the second review's merge conflicts,
// changes nothing, and files a Task needing the builder's Skill to resolve it, the conflict in its
// description.
func TestRunnerMergeConflict(t *testing.T) {
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.fake("planner", "complete", "FAKEAGENT_BREAKDOWN=engineer:Part A;engineer:Part B")
		ri.fake("builder", "handover", "FAKEAGENT_FILE=shared.txt")
	})
	ri.ada.ok("feature", "create", "--team", "MAIN", "--title", "Checkout")
	var resolve client.Task
	ri.wait(60*time.Second, "a Task resolving the merge", func() bool {
		var list client.TaskList
		ri.ada.json(&list, "tasks", "--feature", "MAIN-1")
		for _, x := range list.Items {
			if strings.HasPrefix(x.Title, "Resolve the merge of MAIN-") {
				resolve = x
				return true
			}
		}
		return false
	})
	conflicted := strings.Fields(resolve.Title)[4] // Resolve the merge of <branch> into <target>
	key := strings.SplitN(conflicted, "/", 2)[0]
	if !strings.HasSuffix(resolve.Title, " into feature/MAIN-1") || !strings.Contains(resolve.Description, "shared.txt") ||
		!strings.Contains(resolve.Description, "CONFLICT") {
		t.Fatalf("the resolving Task: %q\n%s", resolve.Title, resolve.Description)
	}
	var skill client.SkillDetail
	ri.ada.json(&skill, "skill", "show", *resolve.SkillID)
	if skill.Skill.Name != "engineer" {
		t.Fatalf("the resolving Task needs %s", skill.Skill.Name)
	}
	ri.wait(15*time.Second, key+"'s merge record", func() bool { return ri.evidence(key, "merge-"+key+".txt") != "" })
	if got := ri.evidence(key, "merge-"+key+".txt"); !strings.Contains(got, "conflicted, so nothing was merged") {
		t.Fatalf("%s's merge record: %q", key, got)
	}
	if gitOK(ri.repo, "merge-base", "--is-ancestor", conflicted, "feature/MAIN-1") {
		t.Fatalf("%s went into feature/MAIN-1 despite the conflict", conflicted)
	}
}

// Scenario 12: darkory agents on the same machine as a server started with --agents=off works the
// same: a quick Feature lands on main.
func TestRunnerAlone(t *testing.T) {
	ri := newRunnerInstall(t, nil, "--agents=off")
	ada := ri.ada
	if res := ada.run("sessions"); res.code == 0 || !strings.Contains(res.stderr, "no_runner") {
		t.Fatalf("sessions on a server with no Runner: exit %d\n%s", res.code, res.stderr)
	}
	log := &logBuffer{}
	cmd := exec.Command(bin, "agents", "--data", ri.dir)
	cmd.Env = ri.env(append(ri.serveEnv, "DARKORY_URL="+ri.srv.url)...)
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(20 * time.Second):
			cmd.Process.Kill()
			t.Error("darkory agents did not stop")
		}
		checkLog(t, "darkory agents", log.String())
	})
	ada.ok("feature", "create", "--team", "MAIN", "--title", "Fix the typo", "--quick", "--skill", "engineer")
	ri.wait(30*time.Second, "the quick Feature shipped and merged", func() bool {
		return ri.feature("MAIN-1").Feature.State == client.FeatureStateShipped && ri.evidence("MAIN-2", "merge-MAIN-2.txt") != ""
	})
	if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-MAIN-2.txt")); err != nil {
		t.Fatalf("main lacks MAIN-2's work: %v", err)
	}
	if !strings.Contains(log.String(), "the runner is running agents") {
		t.Fatalf("darkory agents said:\n%s", log)
	}
}

// tmuxSocket is the Runner's tmux server for the data directory: darkory-<the first 8 hex digits
// of the SHA-256 of its real path>.
func tmuxSocket(t *testing.T, data string) string {
	sum := sha256.Sum256([]byte(realPath(t, data)))
	return "darkory-" + hex.EncodeToString(sum[:4])
}

// killTmux stops a tmux server and removes its socket, which tmux leaves behind.
func killTmux(socket string) {
	exec.Command("tmux", "-L", socket, "kill-server").Run()
	dir := os.Getenv("TMUX_TMPDIR")
	if dir == "" {
		dir = "/tmp"
	}
	os.Remove(filepath.Join(dir, fmt.Sprintf("tmux-%d", os.Getuid()), socket))
}

// In tmux: the session runs as dk-MAIN-2 on the Runner's own tmux server while it works; an
// admin's stop through /v1 ends it, its tmux session is gone, the Task is released with a Note
// and the pane's log is Evidence. It needs tmux.
func TestRunnerInTmux(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("no tmux on this machine")
	}
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.fake("builder", "busy")
		ri.serveEnv = []string{"DARKORY_RUNNER_TIMINGS=" + runnerTimings, "DARKORY_RUNNER_TMUX=on"}
	})
	socket := tmuxSocket(t, ri.dir)
	t.Cleanup(func() { killTmux(socket) })
	ada := ri.ada
	ada.ok("feature", "create", "--team", "MAIN", "--title", "Fix the typo", "--quick", "--skill", "engineer")
	ri.wait(20*time.Second, "a tmux session dk-MAIN-2", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "sessions")
		return len(list.Items) == 1 && list.Items[0].Tmux != nil && *list.Items[0].Tmux == "dk-MAIN-2" &&
			exec.Command("tmux", "-L", socket, "has-session", "-t", "=dk-MAIN-2").Run() == nil
	})
	ada.ok("agent", "set", "builder", "--paused")
	ada.ok("sessions", "stop", "MAIN-2")
	ri.wait(20*time.Second, "the stopped session gone, its log attached", func() bool {
		return exec.Command("tmux", "-L", socket, "has-session", "-t", "=dk-MAIN-2").Run() != nil &&
			strings.Contains(ri.evidence("MAIN-2", "session-MAIN-2.log"), "fakeagent: busy until /exit")
	})
	d := ri.task("MAIN-2")
	if d.Task.Claim != nil || !strings.Contains(notes(d), "An admin stopped the session") {
		t.Fatalf("MAIN-2 after the stop: %+v\n%s", d.Task.Claim, notes(d))
	}
}
