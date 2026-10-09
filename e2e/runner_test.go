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
// scenarios: a Task from Break down to its Owner's Complete across two Workspaces with two
// builders (2, 3, 4, 11), sessions that end without a decision, go stale or are taken back (5, 6,
// 7), a Task standing alone and a Parent with Auto-complete (4), a merge conflict (9), darkory
// runner beside serve --runner=off (12), and a session in tmux stopped by an admin, when tmux is
// installed.

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

// runnerInstall is an Install init seeded with its roster in a fresh repository: Project MAIN, the
// repository as its default Workspace, and planner, builder, reviewer, tester and retro, each with a
// token in <data>/agents and the fake agent as its command.
type runnerInstall struct {
	*install
	repo, ws string
	progress string
	srv      *serveProc
}

// newRunnerInstall makes a runnerInstall, lets setup add to it while no Runner runs, then starts
// the server with serveArgs (--runner=on unless they say).
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
	first := in.serve("--runner=off")
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
	// On the default Workflow: the planner advances its Breakdown along Plan's one way, the
	// builder from Build to Review, the reviewer into Done, and retro into Done.
	ri.fake("planner", "advance")
	ri.fake("builder", "advance")
	ri.fake("reviewer", "advance", "FAKEAGENT_OUTCOME=pass")
	ri.fake("retro", "advance", "FAKEAGENT_OUTCOME=done")
	if setup != nil {
		setup(ri)
	}
	first.stop()
	in.servers = nil
	if len(serveArgs) == 0 {
		serveArgs = []string{"--runner=on"}
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

// agent makes another agent Member in Project MAIN with skills, reporting to ada, with a token in
// <data>/agents for the Runner and the fake agent in scenario as its command.
func (ri *runnerInstall) agent(name, scenario string, skills ...string) {
	ri.t.Helper()
	ada := ri.ada
	ada.ok("member", "create", name, "--kind", "agent")
	ada.ok("project", "add", "MAIN", name)
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

// sessionLog downloads the logs of agent's sessions on Task key (any agent's when agent is
// empty), session-<KEY>-<agent>-<HHMMSS>.log, from the Task and from its Parent, joined.
func (ri *runnerInstall) sessionLog(key, agent string) string {
	ri.t.Helper()
	if agent == "" {
		agent = "[a-z0-9-]+"
	} else {
		agent = regexp.QuoteMeta(agent)
	}
	re := regexp.MustCompile(`^shift-` + regexp.QuoteMeta(key) + `-` + agent + `-[0-9]{6}\.log$`)
	d := ri.task(key)
	list := d.Evidence
	if d.Parent != nil {
		list = append(list, ri.task(d.Parent.Key).Evidence...)
	}
	var logs strings.Builder
	for _, e := range list {
		if re.MatchString(e.Filename) {
			logs.WriteString(ri.ada.ok("evidence", "get", e.ID, "-o", "-"))
		}
	}
	return logs.String()
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

// Scenarios 2, 3, 4 and 11: the planner's session breaks a Task down on a branch from main-1 into two
// Subtasks that each name both Workspaces; two builders work them at once, each in one directory
// with both checkouts, commit, attach a test log and advance to Review; the reviewer advances each
// into Done and the Runner merges its branch into the Parent's in both repositories; the Owner's
// Complete merges that into main.
func TestRunnerWorksAParent(t *testing.T) {
	repo2 := newRepo(t)
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.ada.ok("workspace", "add", "web2", "--path", repo2)
		ri.fake("planner", "advance", "FAKEAGENT_BREAKDOWN=:Cart page;:Totals", "FAKEAGENT_WORKSPACES="+ri.ws+",web2")
		ri.agent("builder2", "advance", "engineer")
	})
	ada := ri.ada
	ada.ok("file", "--project", "MAIN", "--title", "Checkout", "--breakdown")

	ri.wait(15*time.Second, "the Breakdown done", func() bool { return done(ri.task("MAIN-2")) })
	if !gitOK(ri.repo, "rev-parse", "--verify", "refs/heads/main-1") {
		t.Fatal("no main-1 after the Break down")
	}
	ri.wait(60*time.Second, "MAIN-3 and MAIN-4 done", func() bool { return done(ri.task("MAIN-3")) && done(ri.task("MAIN-4")) })
	for _, key := range []string{"MAIN-3", "MAIN-4"} {
		branch := strings.ToLower(key) + "-"
		ri.wait(15*time.Second, key+"'s merge noted", func() bool { return strings.Contains(notes(ri.task(key)), "Merged "+branch) })
		d := ri.task(key)
		if got := repoGit(t, ri.repo, "show", "main-1:fakeagent-"+key+".txt"); !strings.Contains(got, key+" worked by fakeagent") {
			t.Fatalf("main-1 holds %q for %s", got, key)
		}
		if merged := notes(d); !strings.Contains(merged, "into main-1 at") {
			t.Errorf("%s's merge Note:\n%s", key, merged)
		}
		if strings.Count(notes(d), "fakeagent: done") != 2 || !slices.Contains(names(d.Evidence), "test-"+key+".log") {
			t.Errorf("%s: Notes\n%sEvidence %v", key, notes(d), names(d.Evidence))
		}
		// Both Workspaces were checked out side by side in the Task's directory, on its branch.
		for _, repo := range []string{ri.repo, repo2} {
			if repoGit(t, repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"+branch+"*") == "" {
				t.Errorf("no %s branch in %s", key, repo)
			}
		}
		log := ri.sessionLog(key, "")
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

	// The Owner's Complete lands main-1 on main, in the repository's own checkout, and a Note on the
	// Parent says so.
	ada.ok("complete", "MAIN-1")
	ri.wait(15*time.Second, "the Parent's merge noted", func() bool { return strings.Contains(notes(ri.task("MAIN-1")), "Merged main-1 into main at") })
	for _, key := range []string{"MAIN-3", "MAIN-4"} {
		if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-"+key+".txt")); err != nil {
			t.Errorf("main's checkout lacks %s's work: %v", key, err)
		}
	}
	// The Retrospective the Complete filed is worked by retro, and every worktree goes with its
	// Task.
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
// a Note, and the third time a question to the Task's Owner blocks it; a session that stops
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
	ada.ok("file", "--project", "MAIN", "--title", "Checkout", "--breakdown")
	ada.ok("file", "--parent", "MAIN-1", "--aim", "quiet", "--title", "Say nothing")
	ada.ok("file", "--parent", "MAIN-1", "--aim", "stuck", "--title", "Hang")
	ada.ok("file", "--parent", "MAIN-1", "--aim", "busy", "--title", "Keep busy")

	// 5: three releases without a decision, then the question.
	ri.wait(60*time.Second, "a question blocking MAIN-3, released", func() bool {
		d := ri.task("MAIN-3")
		return d.Task.Blocked && d.Task.Claim == nil
	})
	d := ri.task("MAIN-3")
	if n := strings.Count(notes(d), "Shift ended without a decision after 2 nudges; exit code 0; last 20 lines:"); n != 3 {
		t.Errorf("%d releases after two nudges:\n%s", n, notes(d))
	}
	if !strings.Contains(notes(d), `fakeagent: read "You stopped without ending the Task: advance it, complete it, or file a question."`) {
		t.Errorf("the nudge is not in the last lines:\n%s", notes(d))
	}
	// Each of the three sessions was nudged twice, each nudge recorded with no actor.
	var nudged client.ActivityPage
	ada.json(&nudged, "activity", "--kind", "task.nudged", "--task", "MAIN-3", "--limit", "100")
	if len(nudged.Items) != 6 {
		t.Errorf("%d nudges recorded on MAIN-3, want 6: %+v", len(nudged.Items), nudged.Items)
	}
	for i, a := range nudged.Items {
		if a.ActorID != nil || a.Payload["nudge"] != float64(i%2+1) {
			t.Errorf("nudge %d: %+v", i, a)
		}
	}
	q := ri.task((*d.Task.OpenBlockers)[0].Key)
	if q.Task.Title != "The Runner released MAIN-3 three times without a decision" || q.Task.AimedAtID == nil || *q.Task.AimedAtID != ada.id {
		t.Errorf("the question: %+v", q.Task)
	}
	if d.Task.State != client.TaskStateOpen || d.Task.AimedAtID == nil {
		t.Errorf("MAIN-3 is %s, aimed at %v", d.Task.State, d.Task.AimedAtID)
	}

	// 6: the hung session says it is stalled, and its Claim lapses on Darkory's rule, with no
	// Heartbeat refused.
	ri.wait(30*time.Second, "MAIN-4's session stalled", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "shifts")
		return slices.ContainsFunc(list.Items, func(s client.RunnerSession) bool {
			return s.TaskID == ri.task("MAIN-4").Task.ID && s.State == client.RunnerSessionStalled && s.StateSince.After(s.StartedAt)
		})
	})
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
		return strings.Contains(ri.sessionLog("MAIN-4", "stuck"), "fakeagent: hanging")
	})
	ada.ok("agent", "set", "stuck", "--paused")

	// 7: taken back while it works.
	ri.wait(15*time.Second, "busy at work on MAIN-5", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "shifts")
		return slices.ContainsFunc(list.Items, func(s client.RunnerSession) bool {
			return s.TaskID == ri.task("MAIN-5").Task.ID && s.State == client.RunnerSessionRunning
		})
	})
	ada.ok("agent", "set", "busy", "--paused") // so it takes the Task no more
	ada.ok("take-back", "MAIN-5", "--reason", "enough")
	ri.wait(15*time.Second, "the taken-back session to end, its log attached", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "shifts")
		return len(slices.DeleteFunc(list.Items, func(s client.RunnerSession) bool { return s.TaskID != ri.task("MAIN-5").Task.ID })) == 0 &&
			strings.Contains(ri.sessionLog("MAIN-5", "busy"), `fakeagent: read "/exit"`)
	})
	if d := ri.task("MAIN-5"); d.Task.State != client.TaskStateOpen || d.Task.Claim != nil {
		t.Errorf("MAIN-5 after the take-back: %s, %+v", d.Task.State, d.Task.Claim)
	}
}

// Scenario 4: a Task standing alone works on a branch from main, and its review's advance into
// Done merges it into main; a Parent filed with Auto-complete completes itself when its last
// Subtask is done, and its branch lands on main without a click.
func TestRunnerStandaloneAndAutoComplete(t *testing.T) {
	ri := newRunnerInstall(t, nil)
	ada := ri.ada
	ada.ok("file", "--project", "MAIN", "--title", "Fix the typo")
	ri.wait(30*time.Second, "the Task standing alone done", func() bool { return done(ri.task("MAIN-1")) })
	ri.wait(15*time.Second, "MAIN-1's merge noted", func() bool { return strings.Contains(notes(ri.task("MAIN-1")), "Merged main-1-") })
	if got := notes(ri.task("MAIN-1")); !strings.Contains(got, "into main at") {
		t.Fatalf("the merge's Note:\n%s", got)
	}
	if b, err := os.ReadFile(filepath.Join(ri.repo, "fakeagent-MAIN-1.txt")); err != nil || !strings.Contains(string(b), "MAIN-1") {
		t.Fatalf("main's checkout after the Task standing alone: %q, %v", b, err)
	}
	if gitOK(ri.repo, "rev-parse", "--verify", "refs/heads/main-1") {
		t.Fatal("a Task standing alone got a Parent's branch")
	}

	ada.ok("file", "--project", "MAIN", "--title", "Checkout", "--breakdown", "--auto-complete")
	ri.wait(60*time.Second, "the Parent completed itself", func() bool { return done(ri.task("MAIN-2")) })
	ri.wait(15*time.Second, "its merge noted", func() bool { return strings.Contains(notes(ri.task("MAIN-2")), "Merged main-2 into main at") })
	if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-MAIN-4.txt")); err != nil {
		t.Fatalf("main lacks MAIN-4's work: %v", err)
	}
}

// A builder that completes its Task itself, where its Workflow lets it, still has its branch
// merged: into main for a Task standing alone, with a Note saying it was completed without review.
func TestRunnerMergesATaskCompletedWithoutReview(t *testing.T) {
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.ada.ok("workflow", "set", "MAIN", "--file", writeFile(ri.t, filepath.Join(ri.dir, "workflow.json"),
			`{"workflows": [{"name": "Work", "position": 1}], "steps": [{"workflow": "Work", "name": "Build", "skill": "engineer", "position": 1}], "connectors": [{"from": "Build", "name": "done", "position": 1}]}`))
		ri.fake("builder", "complete")
	})
	ri.ada.ok("file", "--project", "MAIN", "--title", "Fix the typo")
	ri.wait(30*time.Second, "the Task done", func() bool { return done(ri.task("MAIN-1")) })
	ri.wait(15*time.Second, "MAIN-1's merge noted", func() bool { return strings.Contains(notes(ri.task("MAIN-1")), "Merged main-1-") })
	d := ri.task("MAIN-1")
	if got := notes(d); !strings.Contains(got, " into main at ") || !strings.Contains(got, "("+ri.ws+"); completed by builder under engineer, without review.") {
		t.Fatalf("the merge's Note:\n%s", got)
	}
	if len(d.Claims) != 1 || d.Task.StepID != nil {
		t.Fatalf("MAIN-1: at %v, Claims %+v", d.Task.StepID, d.Claims)
	}
	if b, err := os.ReadFile(filepath.Join(ri.repo, "fakeagent-MAIN-1.txt")); err != nil || !strings.Contains(string(b), "MAIN-1") {
		t.Fatalf("main's checkout after the unreviewed Task: %q, %v", b, err)
	}
}

// Scenario 9: two Subtasks of one Parent change the same file; the second review's merge
// conflicts, changes nothing, leaves its Task done with a Note, and files a Subtask at the Step
// its builder worked at to resolve it, the conflict in its description.
func TestRunnerMergeConflict(t *testing.T) {
	ri := newRunnerInstall(t, func(ri *runnerInstall) {
		ri.fake("planner", "advance", "FAKEAGENT_BREAKDOWN=:Part A;:Part B")
		ri.fake("builder", "advance", "FAKEAGENT_FILE=shared.txt")
	})
	ri.ada.ok("file", "--project", "MAIN", "--title", "Checkout", "--breakdown")
	var resolve client.Task
	ri.wait(60*time.Second, "a Task resolving the merge", func() bool {
		var list client.TaskList
		ri.ada.json(&list, "tasks", "--parent", "MAIN-1")
		for _, x := range list.Items {
			if strings.HasPrefix(x.Title, "Resolve the merge of main-") {
				resolve = x
				return true
			}
		}
		return false
	})
	conflicted := strings.Fields(resolve.Title)[4] // Resolve the merge of <branch> into <target>
	parts := strings.SplitN(conflicted, "-", 3)
	key := strings.ToUpper(parts[0] + "-" + parts[1])
	if !strings.HasSuffix(resolve.Title, " into main-1") || !strings.Contains(resolve.Description, "shared.txt") ||
		!strings.Contains(resolve.Description, "CONFLICT") {
		t.Fatalf("the resolving Task: %q\n%s", resolve.Title, resolve.Description)
	}
	var skill client.SkillDetail
	ri.ada.json(&skill, "skill", "show", *resolve.SkillID)
	if skill.Skill.Name != "engineer" {
		t.Fatalf("the resolving Task needs %s", skill.Skill.Name)
	}
	ri.wait(15*time.Second, key+"'s conflict noted", func() bool {
		return strings.Contains(notes(ri.task(key)), "into main-1 conflicted, so nothing was merged. Filed "+resolve.Key+" at Build, where it was built, to resolve it.")
	})
	if gitOK(ri.repo, "merge-base", "--is-ancestor", conflicted, "main-1") {
		t.Fatalf("%s went into main-1 despite the conflict", conflicted)
	}
	if !done(ri.task(key)) {
		t.Fatalf("%s did not stay done", key)
	}
}

// Scenario 12: darkory runner on the same machine as a server started with --agents=off works the
// same: a Task standing alone lands on main.
func TestRunnerAlone(t *testing.T) {
	ri := newRunnerInstall(t, nil, "--runner=off")
	ada := ri.ada
	if out := ada.ok("shifts"); !strings.Contains(out, "No Runner is attached to this server") {
		t.Fatalf("sessions on a server with no Runner:\n%s", out)
	}
	log := &logBuffer{}
	cmd := exec.Command(bin, "runner", "--data", ri.dir)
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
			t.Error("darkory runner did not stop")
		}
		checkLog(t, "darkory runner", log.String())
	})
	ada.ok("file", "--project", "MAIN", "--title", "Fix the typo")
	ri.wait(30*time.Second, "the Task done and merged", func() bool {
		d := ri.task("MAIN-1")
		return done(d) && strings.Contains(notes(d), "Merged main-1-")
	})
	if _, err := os.Stat(filepath.Join(ri.repo, "fakeagent-MAIN-1.txt")); err != nil {
		t.Fatalf("main lacks MAIN-1's work: %v", err)
	}
	if !strings.Contains(log.String(), "the runner is running agents") {
		t.Fatalf("darkory runner said:\n%s", log)
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

// In tmux: the session runs as dk-MAIN-1 on the Runner's own tmux server while it works; an
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
	ada.ok("file", "--project", "MAIN", "--title", "Fix the typo")
	ri.wait(20*time.Second, "a tmux session dk-MAIN-1", func() bool {
		var list client.RunnerSessionList
		ada.json(&list, "shifts")
		return len(list.Items) == 1 && list.Items[0].Tmux != nil && *list.Items[0].Tmux == "dk-MAIN-1" &&
			exec.Command("tmux", "-L", socket, "has-session", "-t", "=dk-MAIN-1").Run() == nil
	})
	ada.ok("agent", "set", "builder", "--paused")
	ada.ok("shifts", "stop", "MAIN-1")
	ri.wait(20*time.Second, "the stopped session gone, its log attached", func() bool {
		return exec.Command("tmux", "-L", socket, "has-session", "-t", "=dk-MAIN-1").Run() != nil &&
			strings.Contains(ri.sessionLog("MAIN-1", "builder"), "fakeagent: busy until /exit")
	})
	d := ri.task("MAIN-1")
	if d.Task.Claim != nil || !strings.Contains(notes(d), "An admin stopped the Shift") {
		t.Fatalf("MAIN-1 after the stop: %+v\n%s", d.Task.Claim, notes(d))
	}
}
