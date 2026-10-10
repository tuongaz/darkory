package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
)

// silentPrefix starts the Note of every release for a Shift that ended without a decision, so
// the runner can count them on the Task (three file a question to the Task's Owner).
const silentPrefix = "Shift ended without a decision"

// olderSilentPrefix is how those Notes began before the Runner's sessions were called Shifts; a
// Task released that way before still counts them.
const olderSilentPrefix = "Session ended without a decision"

// silentLimit is how many releases without a decision file a question to the Task's Owner.
const silentLimit = 3

// maxLog is the most of a session's log attached as Evidence: its end.
const maxLog = 8 << 20

// session is one Claim being worked: the agent's command, its progress and its end.
type session struct {
	r   *Runner
	a   *agent
	rec Record
	d   *client.TaskDetail
	set AgentSettings
	log *slog.Logger

	key, taskID, claimID string
	started              time.Time

	dir, logPath string
	proc         Proc
	// checkouts are the session's worktrees, and tips their branches' commits when it started, so
	// its end can tell whether it committed (built).
	checkouts []Checkout
	tips      map[string]string
	// progress is the file the agent writes as it works; empty when there is none to read.
	progress, claudeDir string
	transcript          bool
	// claude says the command is Claude Code, started in folder (its paths); answered says the
	// runner has accepted its one first-run dialog of the session (firstRun), and turned that the
	// agent's model has answered; dialog names a dialog on screen left to a person, and toldJoin
	// that a Note says so.
	claude           bool
	folder           []string
	answered, turned bool
	dialog           string
	toldJoin         bool

	ended chan string
	cmds  chan sessionCmd
	over  chan struct{}

	mu         sync.Mutex
	state      string
	stateSince time.Time

	lastProgress time.Time
	stale        bool
	// procs are the processes under the session started after its last record, as last seen;
	// holding says why a quiet session still counts as working (quietProgress).
	procs     map[int]bool
	holding   string
	nudges    int
	lastNudge time.Time
}

type sessionCmd struct {
	stop bool
	done chan error
}

const (
	cmdNudge = false
	cmdStop  = true
)

func newSession(a *agent, rec Record, d *client.TaskDetail, set AgentSettings) *session {
	claimID := ""
	if d.Task.Claim != nil {
		claimID = d.Task.Claim.ID
	}
	dir := filepath.Join(a.r.cfg.Data, "sessions", d.Task.Key)
	s := &session{r: a.r, a: a, rec: rec, d: d, set: set, key: d.Task.Key, taskID: d.Task.ID, claimID: claimID,
		started: time.Now(), log: a.r.log.With("agent", a.name(), "task", d.Task.Key), dir: dir, logPath: filepath.Join(dir, "pane.log"),
		ended: make(chan string, 1), cmds: make(chan sessionCmd), over: make(chan struct{}), state: StateRunning}
	s.stateSince = s.started
	return s
}

func (s *session) snapshot() RunnerSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	rs := RunnerSession{TaskID: s.taskID, Task: s.key, MemberID: s.a.me.Member.ID, Member: s.a.name(), SessionID: s.rec.Session(),
		Host: s.r.machine, StartedAt: s.started, State: s.state, StateSince: s.stateSince, LogPath: s.logPath}
	// A session being prepared on a tmux host is shown in tmux already: that is where it starts.
	if s.r.host.Tmux() && (s.proc == nil || s.proc.Tmux()) {
		rs.Tmux, rs.TmuxSession, rs.TmuxSocket = true, TmuxName(s.key), s.r.Socket()
	}
	return rs
}

// setState says what the session is doing, and since when it has; an ending session stays ending.
func (s *session) setState(st string) {
	s.mu.Lock()
	if s.state != StateEnding && s.state != st {
		s.state, s.stateSince = st, time.Now()
	}
	s.mu.Unlock()
}

// errPaused is a session that did not start because its agent was paused meanwhile.
var errPaused = errors.New("the agent was paused")

// claimEnded is told by the Activity stream that the session's Claim ended, and how.
func (s *session) claimEnded(kind string) {
	select {
	case s.ended <- kind:
	default:
	}
}

// command hands an admin's nudge or stop to the session.
func (s *session) command(ctx context.Context, stop bool) error {
	c := sessionCmd{stop: stop, done: make(chan error, 1)}
	select {
	case s.cmds <- c:
	case <-s.over:
		return ErrNoSession
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-c.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// run works the session from start to end. It returns false when the session could not start.
func (s *session) run(ctx context.Context) bool {
	r := s.r
	r.mu.Lock()
	r.sessions[s.rec.Session()] = s
	r.mu.Unlock()
	defer func() {
		s.noteBuilt(context.WithoutCancel(ctx))
		// Gone from the list before over closes, so a session waiting on it starts at once.
		r.mu.Lock()
		delete(r.sessions, s.rec.Session())
		r.mu.Unlock()
		close(s.over)
		if ctx.Err() == nil {
			// Not when the runner stops: the Task goes back, and the next runner's Poll reads it.
			s.readPullRequests(ctx)
		}
		s.cleanUp(context.WithoutCancel(ctx))
	}()
	s.log.Info("took a Task", "title", s.d.Task.Title, "step", stepName(s.d), "session", s.rec.Session())
	err := s.waitForEarlier(ctx)
	if err == nil {
		err = s.start(ctx)
	}
	if err != nil {
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if ctx.Err() != nil {
			s.release(bctx, "The Runner stopped before the Shift started.")
			return true
		}
		if errors.Is(err, errPaused) {
			s.log.Info("the agent was paused before its Shift started; releasing the Task unworked")
			s.release(bctx, pausedNote)
			return true
		}
		s.log.Error("could not start the Shift", "err", err)
		s.giveUp(bctx, fmt.Sprintf("the runner could not start it: %s", remote.CleanLine(err.Error())))
		return false
	}
	s.log.Info("started the Shift", "host", r.hostName(), "log", s.logPath, "progress", s.progress)
	s.watch(ctx)
	return true
}

// waitForEarlier waits while an earlier session of the Task ends, as the builder's does after it
// hands over to a review this runner takes at once: the two share the Task's worktree, log and
// tmux session. It returns as soon as the earlier one has ended, heartbeating each Tick until then.
func (s *session) waitForEarlier(ctx context.Context) error {
	t := time.NewTicker(s.r.t.Tick)
	defer t.Stop()
	for {
		var earlier *session
		s.r.mu.Lock()
		for _, o := range s.r.sessions {
			if o != s && o.taskID == s.taskID {
				earlier = o
			}
		}
		s.r.mu.Unlock()
		if earlier == nil {
			return nil
		}
		select {
		case <-earlier.over:
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if _, err := s.rec.Heartbeat(ctx, s.key); err != nil && ctx.Err() == nil {
				s.log.Warn("heartbeat while an earlier Shift ends", "err", err)
			}
		}
	}
}

// start prepares the Workspaces, writes the prompt and the MCP configuration, and starts the
// agent's command.
func (s *session) start(ctx context.Context) error {
	r := s.r
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	parent, err := s.rec.Parent(ctx, s.d)
	if err != nil {
		return fmt.Errorf("reading the Parent of %s: %w", s.key, err)
	}
	wss, err := s.rec.Workspaces(ctx, s.d)
	if err != nil {
		return fmt.Errorf("reading the Task's Workspaces: %w", err)
	}
	if s.d.Task.AimedAtID != nil {
		// A question aimed at a Member is answered in Notes: no checkout, no branch, nothing to merge.
		wss = nil
	}
	r.awaitMerges(ctx, s.key, parent, wss)
	checkouts, err := r.Prepare(ctx, s.key, parentKey(s.d), PlanCheckouts(r.taskDir(s.key), s.key, s.d.Task.Title, parentKey(s.d), wss))
	if err != nil {
		return fmt.Errorf("preparing the Workspaces: %w", err)
	}
	cwd := r.taskDir(s.key)
	if len(checkouts) > 0 {
		cwd = checkouts[0].Dir
	}
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		return err
	}
	s.checkouts = checkouts
	s.tips = tips(ctx, checkouts)
	s.noteReviewing(ctx)
	p, err := s.prompt(ctx, parent, checkouts)
	if err != nil {
		return err
	}
	promptFile := filepath.Join(s.dir, "prompt.md")
	if err := os.WriteFile(promptFile, []byte(BuildPrompt(p)), 0o600); err != nil {
		return err
	}
	// The session's environment is the runner's own few variables, not the server's (baseEnv).
	// The darkory the runner is goes first on the PATH, so the session's CLI is the same release.
	env := baseEnv(os.Environ())
	env = setEnv(env, "PATH", filepath.Dir(r.bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	env = setEnv(env, remote.EnvURL, r.cfg.URL)
	env = setEnv(env, remote.EnvToken, s.a.token)
	env = setEnv(env, remote.EnvSession, s.rec.Session())
	mcpFile := filepath.Join(s.dir, "mcp.json")
	if err := s.writeMCPConfig(mcpFile, r.taskDir(s.key)); err != nil {
		return err
	}
	v := Values{PromptFile: promptFile, Workspace: cwd, SessionID: s.rec.Session(), Model: s.set.Model, MCPConfig: mcpFile, Task: s.key,
		Title: s.d.Task.Title}
	argv, err := Render(s.set.Command, s.set.Args, s.set.Unattended, v)
	if err != nil {
		return err
	}
	// Claude Code runs with the person's own configuration (claude.go); the folder is what its
	// first-run dialog would name.
	s.claude = IsClaude(s.set.Command)
	s.folder = []string{cwd}
	if real, err := filepath.EvalSymlinks(cwd); err == nil && real != cwd {
		s.folder = append(s.folder, real)
	}
	keys := make([]string, 0, len(s.set.Env))
	for k := range s.set.Env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = setEnv(env, k, s.set.Env[k])
	}
	switch {
	case s.set.ProgressFile != "":
		if s.progress, err = Expand(s.set.ProgressFile, v); err != nil {
			return err
		}
		if !filepath.IsAbs(s.progress) {
			s.progress = filepath.Join(cwd, s.progress)
		}
	case s.claude:
		s.claudeDir = ClaudeDir(env)
		s.progress, s.transcript = TranscriptPath(s.claudeDir, cwd, s.rec.Session()), true
	}
	// The last moment to see a pause set while the Task was prepared: no command starts after it.
	if set, ok, err := s.a.rec.Agent(ctx, s.a.me.Member.ID); err == nil && (!ok || set.Paused) {
		return errPaused
	}
	proc, err := r.host.Start(ctx, Spec{Name: TmuxName(s.key), Argv: argv, Dir: cwd, Env: env, SessionDir: s.dir, Log: s.logPath})
	if err != nil {
		return fmt.Errorf("starting %s: %w", argv[0], err)
	}
	s.mu.Lock()
	s.proc = proc
	s.mu.Unlock()
	return nil
}

// writeMCPConfig writes the MCP configuration that connects the session to `darkory mcp` as the
// agent, in the session's Darkory Session. Heartbeats are the runner's (D8), so the MCP server
// sends none. The file holds the token: only this user reads it.
func (s *session) writeMCPConfig(path, evidenceRoot string) error {
	doc := map[string]any{"mcpServers": map[string]any{"darkory": map[string]any{
		"type": "stdio", "command": s.r.bin, "args": []string{"mcp", "--no-heartbeat"},
		"env": map[string]string{remote.EnvURL: s.r.cfg.URL, remote.EnvToken: s.a.token, remote.EnvSession: s.rec.Session(),
			"DARKORY_EVIDENCE_ROOT": evidenceRoot},
	}}}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// prompt gathers what the prompt says from the record.
func (s *session) prompt(ctx context.Context, parent *ParentInfo, checkouts []Checkout) (Prompt, error) {
	members, err := s.rec.Members(ctx)
	if err != nil {
		return Prompt{}, err
	}
	names := map[string]string{}
	for _, m := range members {
		names[m.ID] = m.Name
	}
	d := s.d
	var wf *client.Workflows
	if leadsToAStep(d) {
		if wf, err = s.rec.Workflows(ctx, d.Task.ProjectID); err != nil {
			return Prompt{}, err
		}
	}
	p := Prompt{Agent: s.a.name(), Manager: names[s.manager(d)], Dir: s.r.taskDir(s.key), Checkouts: checkouts, Rules: remote.Rules,
		Task: PromptTask{Key: d.Task.Key, Title: d.Task.Title, Description: d.Task.Description, Step: stepName(d), Kind: string(d.Task.Kind),
			Outcomes: outcomes(d, wf)}}
	if parent != nil {
		p.Parent = &PromptParent{Key: parent.Key, Title: parent.Title, Description: parent.Description, Owner: parent.Owner}
	}
	if p.Manager == "" {
		p.Manager = or(names[d.Task.OwnerID], s.manager(d))
	}
	if id := d.Task.SkillID; id != nil {
		sk, err := s.rec.Skill(ctx, *id)
		if err != nil {
			return Prompt{}, err
		}
		p.Task.Skill, p.Task.Review = sk.Skill.Name, s.r.isReview(ctx, s.rec, sk.Skill)
		texts := []*client.SkillDetail{sk}
		if sk.Skill.Kind == client.Company && sk.Skill.BaseSkillID != nil {
			if base, err := s.rec.Skill(ctx, *sk.Skill.BaseSkillID); err == nil {
				texts = append(texts, base)
			}
		} else {
			// The company's version of a generic Skill, when the agent has one, comes first: one of
			// the Organisation's or of the Task's Project, never another Project's (ADR 0020).
			for _, own := range s.a.me.Skills {
				if own.Kind == client.Company && own.BaseSkillID != nil && *own.BaseSkillID == sk.Skill.ID &&
					(own.ProjectID == nil || *own.ProjectID == d.Task.ProjectID) {
					if c, err := s.rec.Skill(ctx, own.ID); err == nil {
						texts = append([]*client.SkillDetail{c}, texts...)
					}
				}
			}
		}
		for _, t := range texts {
			p.Skills = append(p.Skills, PromptSkill{Name: t.Skill.Name, Version: t.Current.Version, Company: t.Skill.Kind == client.Company, Body: t.Current.Body})
		}
	}
	for _, n := range d.Notes {
		pn := PromptNote{At: n.CreatedAt, Author: or(names[n.AuthorID], n.AuthorID), Body: n.Body}
		if n.SkillID != nil {
			if sk, ok := s.r.skill(ctx, s.rec, *n.SkillID); ok {
				pn.Skill = sk.Name
			}
		}
		p.Notes = append(p.Notes, pn)
	}
	for _, e := range d.Evidence {
		// A Shift's log is the Claim's, not the Task's Evidence.
		if e.TaskID == d.Task.ID && e.Kind == client.EvidenceKindEvidence {
			p.Evidence = append(p.Evidence, PromptEvidence{ID: e.ID, Filename: e.Filename, ContentType: e.ContentType,
				AttachedBy: or(names[e.AttachedBy], e.AttachedBy), Size: e.Size})
		}
	}
	return p, nil
}

// watch follows the session until it ends.
func (s *session) watch(ctx context.Context) {
	t := time.NewTicker(s.r.t.Tick)
	defer t.Stop()
	s.lastProgress = s.started
	for {
		select {
		case <-ctx.Done():
			s.shutdown(ctx)
			return
		case how := <-s.ended:
			s.finish(ctx, how)
			return
		case <-s.proc.Done():
			s.exited(ctx)
			return
		case c := <-s.cmds:
			if c.stop {
				s.log.Info("an admin stopped the Shift")
				c.done <- nil
				s.end(ctx, "An admin stopped the Shift; the Task goes back for another.")
				return
			}
			s.log.Info("nudged by an admin")
			c.done <- s.proc.Type(Nudge)
		case <-t.C:
			if s.check(ctx) {
				return
			}
		}
	}
}

// check reads the session's progress: a Heartbeat while it is fresh, none once it is stale, and a
// nudge when the agent's turn ended with the Claim still held. The session's state follows:
// waiting while it shows a dialog left to a person, else stalled while stale, waiting while its
// turn has ended, running otherwise. It says whether the session ended.
func (s *session) check(ctx context.Context) bool {
	s.firstRun(ctx)
	var rd Reading
	if s.progress == "" {
		// Nothing to read: the session counts as working while its command runs.
		s.lastProgress = time.Now()
	} else {
		var err error
		rd, err = ReadProgress(s.progress)
		if err != nil {
			s.log.Warn("reading the Shift's progress", "file", s.progress, "err", err)
		}
		if !rd.Exists && s.transcript {
			if found := findTranscript(s.claudeDir, s.rec.Session()); found != "" && found != s.progress {
				s.log.Info("found the Shift's transcript elsewhere", "file", found)
				s.progress = found
				rd, _ = ReadProgress(found)
			}
		}
		if rd.Exists && rd.Modified.Before(s.started) {
			rd = Reading{} // an earlier session's
		}
		if rd.Exists && rd.Modified.After(s.lastProgress) {
			s.lastProgress = rd.Modified
		}
	}
	quiet := ""
	if s.progress != "" {
		// Read every check, so a process is known to have run from one check to the next.
		quiet = s.quietProgress(ctx, rd)
	}
	fresh := time.Since(s.lastProgress) < s.r.t.Stale
	switch {
	case fresh:
		s.holding = ""
	case quiet != "":
		if s.holding != quiet {
			s.log.Info("the Shift's progress is quiet, but "+quiet+"; counting it as progress", "last_progress", s.lastProgress.Format(time.RFC3339))
			s.holding = quiet
		}
		fresh = true
	}
	if fresh {
		if s.stale {
			s.log.Info("the Shift shows progress again; sending Heartbeats")
			s.stale = false
		}
		st, err := s.rec.Heartbeat(ctx, s.key)
		switch {
		case err == nil && st != client.HeartbeatStatusOk:
			return s.finish(ctx, string(st))
		case refusedBy(err, client.ErrorCodeNotHolder, client.ErrorCodeEnded, client.ErrorCodeNotFound) || stopped(err):
			return s.finish(ctx, "ended")
		case err != nil && ctx.Err() == nil:
			s.log.Warn("heartbeat", "err", err)
		}
	} else {
		if !s.stale {
			msg := "the Shift's progress went stale; no more Heartbeats, so the Claim lapses unless it moves again"
			if rd.InFlight {
				msg = "the Shift's tool call has run for the Claim's timeout with no process of it running; no more Heartbeats, " +
					"so the Claim lapses unless it moves again"
			}
			s.log.Info(msg, "last_progress", s.lastProgress.Format(time.RFC3339))
			s.stale, s.holding = true, ""
		}
		// The lapse comes on the Activity stream; this catches it should the stream miss it.
		if d, err := s.rec.Task(ctx, s.key); err == nil && !s.holds(d) {
			return s.finish(ctx, "lapsed")
		}
	}
	switch {
	case s.dialog != "":
		s.setState(StateWaiting)
	case s.stale:
		s.setState(StateStalled)
	case rd.Ended:
		s.setState(StateWaiting)
	default:
		s.setState(StateRunning)
	}
	if !rd.Ended {
		return false
	}
	return s.turnEnded(ctx)
}

// quietProgress says why a session whose progress file has gone quiet still works, or "" when
// nothing says so. A tool call can run for longer than the file may go quiet (the plan: a silent
// ten-minute make verify lapsed fourteen Claims in MAIN-1's Retrospective), so: a process under the
// session that started after its last record and is still there a check later — the call's own
// work; a short-lived one, such as a status line's command, is never seen twice — counts for as
// long as it runs. For Claude Code, whose transcript says when a call is in flight, only while
// one is. Failing that, a call in flight counts for up to the Claim's own timeout after its last
// record, so a call that hangs still lets the Claim lapse.
func (s *session) quietProgress(ctx context.Context, rd Reading) string {
	if !rd.Exists {
		return ""
	}
	if !s.transcript || rd.InFlight {
		seen := map[int]bool{}
		var running []proc
		if pid := s.proc.PID(); pid > 0 {
			ps, _ := descendants(ctx, pid)
			for _, p := range ps {
				// ps gives start times to the second.
				if p.Started.Before(rd.Modified.Add(-time.Second)) {
					continue
				}
				seen[p.PID] = true
				if s.procs[p.PID] {
					running = append(running, p)
				}
			}
		}
		s.procs = seen
		if len(running) > 0 {
			return fmt.Sprintf("a process it started is running (%s, pid %d)", running[0].Command, running[0].PID)
		}
	}
	if rd.InFlight && time.Since(rd.Modified) < s.r.t.ClaimTimeout {
		return "a tool call is in flight"
	}
	return ""
}

// firstRun looks at the screen of a Claude Code session in tmux (Claude Code asks only on a
// terminal) for one of its first-run dialogs, which a repository never opened in Claude Code
// meets. The runner accepts one such dialog per session, and only while the agent's model has not
// answered yet: Claude Code asks before any model turn, so after one nothing the agent prints can
// make the runner press a key. It notes the answer. A dialog it may not answer is left to a
// person: the session waits, with a Note saying to join it.
func (s *session) firstRun(ctx context.Context) {
	a, ok := s.proc.(Answerer)
	if !s.claude || !ok {
		return
	}
	p, found := findFirstRunPrompt(a.Shown(), s.folder...)
	s.dialog = ""
	if !found {
		return
	}
	turned := s.agentTurned()
	if !turned && !s.answered {
		s.answered = true
		s.log.Info("Claude Code asks its first-run question; accepting it", "prompt", p.Name)
		if err := a.AcceptFirstRunPrompt(); err != nil {
			s.log.Warn("answering Claude Code's first-run question", "err", err)
			return
		}
		if err := s.rec.Note(ctx, s.key, fmt.Sprintf("The runner accepted Claude Code's first-run prompt: %s.", p.Name)); err != nil && ctx.Err() == nil {
			s.log.Warn("noting the first-run prompt", "err", err)
		}
		return
	}
	s.dialog = p.Name
	if s.toldJoin {
		return
	}
	s.toldJoin = true
	s.log.Warn("the Shift shows a Claude Code dialog the runner does not answer; it waits for a person", "prompt", p.Name, "after_first_turn", turned)
	note := fmt.Sprintf("Claude Code shows a first-run dialog after the agent's first turn; a person can answer it with darkory join %s.", s.key)
	if !turned {
		note = fmt.Sprintf("Claude Code shows %s, and the Runner accepts one first-run dialog a Shift; a person can answer it "+
			"with darkory join %s.", p.Name, s.key)
	}
	if err := s.rec.Note(ctx, s.key, note); err != nil && ctx.Err() == nil {
		s.log.Warn("noting the dialog left to a person", "err", err)
	}
}

// agentTurned says whether the agent's model has answered in this session yet: its transcript
// holds an assistant message. Once it has, it stays so; a transcript that cannot be read counts
// as answered.
func (s *session) agentTurned() bool {
	if s.turned {
		return true
	}
	path := s.progress
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) && s.transcript {
		if found := findTranscript(s.claudeDir, s.rec.Session()); found != "" {
			path = found
		}
	}
	turned, err := HasAssistantMessage(path)
	s.turned = turned || err != nil
	return s.turned
}

// holds says whether the session still holds the Task's Claim.
func (s *session) holds(d *client.TaskDetail) bool {
	return d.Task.State == client.TaskStateOpen && d.Task.Claim != nil && d.Task.Claim.ID == s.claimID
}

// turnEnded handles an agent waiting for input: a Claim ended or a question asked ends the
// session; otherwise it is nudged twice, Nudge apart, and released Nudge after the second.
func (s *session) turnEnded(ctx context.Context) bool {
	d, err := s.rec.Task(ctx, s.key)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Warn("reading the Task", "err", err)
		}
		return false
	}
	if !s.holds(d) {
		return s.finish(ctx, "ended")
	}
	if d.Task.Blocked {
		return s.asked(ctx, d)
	}
	since := time.Since(s.lastNudge)
	switch {
	case s.nudges < 2 && (s.lastNudge.IsZero() || since >= s.r.t.Nudge):
		s.nudges++
		s.lastNudge = time.Now()
		s.log.Info("the agent stopped without ending the Task; nudged it", "nudge", s.nudges)
		if err := s.proc.Type(Nudge); err != nil {
			s.log.Warn("nudging", "err", err)
		} else if err := s.rec.Nudged(ctx, s.key, s.nudges); err != nil && ctx.Err() == nil {
			s.log.Warn("recording the nudge", "err", err)
		}
	case s.nudges >= 2 && since >= s.r.t.Nudge:
		return s.giveUp(ctx, "")
	}
	return false
}

// exited handles the command ending by itself.
func (s *session) exited(ctx context.Context) {
	code := s.proc.ExitCode()
	d, err := s.rec.Task(ctx, s.key)
	switch {
	case err != nil:
		s.log.Warn("reading the Task after the Shift exited", "err", err)
		s.giveUp(ctx, "")
	case !s.holds(d):
		s.log.Info("the Shift exited after its Claim ended", "exit_code", code)
		s.attachLog(ctx)
	case d.Task.Blocked:
		s.asked(ctx, d)
	default:
		s.log.Info("the Shift exited without a decision", "exit_code", code)
		s.giveUp(ctx, "")
	}
}

// finish ends a session whose Claim ended: the agent completed, handed over or asked, or someone
// took it back, or it lapsed.
func (s *session) finish(ctx context.Context, how string) bool {
	s.log.Info("the Claim ended; ending the Shift", "how", strings.TrimPrefix(how, "task."))
	s.end(ctx, "")
	return true
}

// asked ends the session of an agent that filed a question blocking its Task, releasing the Task
// until the question is answered.
func (s *session) asked(ctx context.Context, d *client.TaskDetail) bool {
	var keys []string
	for _, b := range ptrSlice(d.Task.OpenBlockers) {
		keys = append(keys, b.Key)
	}
	s.log.Info("the agent asked a question; releasing the Task until it is answered", "questions", keys)
	s.end(ctx, fmt.Sprintf("Waiting for the answer to %s; the runner released the Task until then.", strings.Join(keys, ", ")))
	return true
}

func ptrSlice[T any](p *[]T) []T {
	if p == nil {
		return nil
	}
	return *p
}

// end stops the command, releases the Task with note unless note is empty, and attaches the log.
func (s *session) end(ctx context.Context, note string) {
	s.setState(StateEnding)
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.r.t.Exit+30*time.Second)
	defer cancel()
	s.stopCommand(bctx, s.r.t.Exit)
	if note != "" {
		s.release(bctx, note)
	}
	s.attachLog(bctx)
}

// giveUp releases a Task whose session ended without a decision, with a Note saying how, and on
// every third such release files a question to the Task's Owner that blocks the Task. why says
// what happened when the command did not run at all.
func (s *session) giveUp(ctx context.Context, why string) bool {
	s.setState(StateEnding)
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.r.t.Exit+30*time.Second)
	defer cancel()
	note := silentPrefix
	if why != "" {
		note += "; " + why + "."
	} else {
		screen := ""
		if s.proc != nil {
			screen = s.proc.Screen(20)
		}
		s.stopCommand(bctx, s.r.t.Exit)
		code := s.proc.ExitCode()
		if s.nudges > 0 {
			note += fmt.Sprintf(" after %d nudges", s.nudges)
		}
		if code >= 0 {
			note += fmt.Sprintf("; exit code %d", code)
		} else {
			note += "; the runner ended it"
		}
		note += "; last 20 lines:\n" + or(remote.Clean(screen), "(none)")
	}
	if d, err := s.rec.Task(bctx, s.key); err == nil && s.holds(d) {
		n := 1
		for _, nt := range d.Notes {
			if strings.HasPrefix(nt.Body, silentPrefix) || strings.HasPrefix(nt.Body, olderSilentPrefix) {
				n++
			}
		}
		if n%silentLimit == 0 {
			s.escalate(bctx, d, n)
		}
	}
	s.release(bctx, note)
	if s.proc != nil {
		s.attachLog(bctx)
	}
	return true
}

// escalate files a question aimed at the agent's manager on its Reporting line, or the Task's
// Owner when it has none, that blocks the Task, after the runner has released it n times without a
// decision (ADR 0013). The question joins the Task's Parent, or stands alone beside a Task with
// none. It is filed while the session still holds the Task, so nobody takes it in between.
func (s *session) escalate(ctx context.Context, d *client.TaskDetail, n int) {
	title := fmt.Sprintf("The Runner released %s %s times without a decision", s.key, map[int]string{3: "three"}[n])
	if n != silentLimit {
		title = fmt.Sprintf("The Runner released %s %d times without a decision", s.key, n)
	}
	body := fmt.Sprintf("Shifts of %s ended %d times without advancing %s, completing it or asking a question; "+
		"its Notes say how each ended. Answer here what the agent should do (or ask the Task's Owner to drop it), then complete "+
		"this question: %s stays blocked until then.", s.a.name(), n, s.key, s.key)
	to := s.manager(d)
	q, err := s.rec.File(ctx, client.FileTaskBody{Title: title, Description: &body, Aim: &to, Blocks: &s.key})
	if err != nil {
		s.log.Error("could not file the question to the agent's manager", "aim", to, "err", err)
		return
	}
	s.log.Info("filed a question to the agent's manager", "question", q.Key, "aim", to, "releases", n)
}

// manager is the Member the agent's questions go to: its manager on its Reporting line, else the
// Task's Owner.
func (s *session) manager(d *client.TaskDetail) string {
	if id := s.a.me.Member.ManagerID; id != nil && *id != "" {
		return *id
	}
	return d.Task.OwnerID
}

// release gives the Task up with note; a Claim that has ended already is no error.
func (s *session) release(ctx context.Context, note string) {
	err := s.rec.Release(ctx, s.key, note)
	switch {
	case err == nil:
		s.log.Info("released the Task", "note", firstLine(note))
	case refusedBy(err, client.ErrorCodeNotHolder, client.ErrorCodeEnded) || stopped(err):
	default:
		s.log.Error("could not release the Task", "err", err)
	}
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(s, "\n")
	return l
}

// stopCommand asks the command to exit, as a person typing /exit would, and kills it when it has
// not within wait.
func (s *session) stopCommand(ctx context.Context, wait time.Duration) {
	if s.proc == nil {
		return
	}
	select {
	case <-s.proc.Done():
		return
	default:
	}
	s.proc.Type("/exit")
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-s.proc.Done():
		return
	case <-t.C:
	case <-ctx.Done():
	}
	s.log.Info("the Shift did not exit; killing it")
	if err := s.proc.Kill(); err != nil {
		s.log.Warn("killing the Shift", "err", err)
	}
	select {
	case <-s.proc.Done():
	case <-time.After(5 * time.Second):
		s.log.Warn("the Shift is still running after it was killed")
	}
}

// shutdown ends the session because the runner is stopping: the Task goes back with a Note.
func (s *session) shutdown(ctx context.Context) {
	s.log.Info("the runner is stopping; ending the Shift")
	s.setState(StateEnding)
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	s.stopCommand(bctx, 2*time.Second)
	s.release(bctx, "The Runner stopped while the Shift ran; the Task goes back for another Shift.")
	s.attachLog(bctx)
}

// attachLog attaches the session's log to the Task as a log, the Claim's and not the Task's
// Evidence. When another Member holds the Task by now, as the next holder may as soon as the agent
// advanced it, the record takes attachments from that holder alone (plan invariant 6), so the log
// waits on disk and the runner attaches it the moment the Task is free (attachPending). It is named for the Task, the agent and the time the
// session began (UTC), so the builder's and the reviewer's logs of one Task tell apart.
func (s *session) attachLog(ctx context.Context) {
	b, err := readTail(s.logPath, maxLog)
	if err != nil || len(b) == 0 {
		if err != nil {
			s.log.Warn("reading the Shift's log", "err", err)
		}
		return
	}
	name := SessionLogName(s.key, s.a.name(), s.started)
	err = s.rec.Attach(ctx, s.key, name, client.EvidenceKindLog, b)
	switch {
	case err == nil:
		s.log.Info("attached the Shift's log", "evidence", name, "bytes", len(b))
	case refusedBy(err, client.ErrorCodeNotHolder):
		if err := s.r.keepLog(s.a, s.key, name, b); err != nil {
			s.log.Error("could not keep the Shift's log for later", "evidence", name, "err", err)
			return
		}
		s.log.Info("the Task is held by its next holder; the Shift's log is attached once it is free", "evidence", name)
	default:
		if err := s.r.keepLog(s.a, s.key, name, b); err != nil {
			s.log.Error("could not attach the Shift's log, nor keep it for later", "evidence", name, "err", err)
			return
		}
		s.log.Warn("could not attach the Shift's log; it is kept and tried again", "evidence", name, "err", err)
	}
}

// SessionLogName is the Evidence name of a Shift's log: shift-<KEY>-<agent>-<HHMMSS>.log.
func SessionLogName(task, agent string, started time.Time) string {
	return fmt.Sprintf("shift-%s-%s-%s.log", task, agent, started.UTC().Format("150405"))
}

func readTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(max(st.Size()-n, 0), io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}

// readPullRequests reads, once the Claim has ended, the pull requests of the Task's branch in each
// of its Workspaces in pull_request mode, which the agent may have opened or merged in its Shift,
// and writes the newest open or merged one that is the Task's (landing) on the Task, as the Shift.
func (s *session) readPullRequests(ctx context.Context) {
	for _, c := range s.checkouts {
		if c.Workspace.Mode != ModePullRequest {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, ghTimeout)
		log := s.log.With("workspace", c.Workspace.Name)
		prs, err := s.r.gh.PullRequestsForBranch(cctx, c.Workspace.Path, c.Branch)
		if err != nil {
			log.Warn("listing the pull requests of the Task's branch", "branch", c.Branch, "err", err)
		} else {
			prs = slices.DeleteFunc(prs, func(pr PullRequest) bool {
				why := s.r.notLanding(cctx, s.d, c.Workspace, pr)
				if why != "" {
					log.Info(why, "pr", pr.Number, "branch", pr.HeadRefName, "base", pr.BaseRefName)
				}
				return why != ""
			})
			if pr, ok := newestPullRequest(prs); ok {
				s.r.writePullRequest(cctx, s.rec, s.key, pullRequestBody(pr), log, "read the Task's pull request")
			}
		}
		cancel()
	}
}

// cleanUp removes the Task's worktrees once the Task has ended, keeping its branches.
func (s *session) cleanUp(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	d, err := s.rec.Task(cctx, s.key)
	if err != nil || d.Task.State == client.TaskStateOpen {
		return
	}
	s.r.RemoveCheckouts(cctx, s.key)
}

// stepName names the Step a Task is at; "" when it is at none.
func stepName(d *client.TaskDetail) string {
	if d.Step == nil {
		return ""
	}
	return d.Step.Name
}

// parentKey is a Task's Parent's key, or "" when it has none.
func parentKey(d *client.TaskDetail) string {
	if d.Parent == nil {
		return ""
	}
	return d.Parent.Key
}

// outcomes are the ways out of a Task's Step, in order, each into another Workflow named by that
// Workflow and the Step it reaches; wf is the Task's Project's Workflows, nil when no outcome
// leads to a Step.
func outcomes(d *client.TaskDetail, wf *client.Workflows) []PromptOutcome {
	steps, workflowOf, workflows := map[string]string{}, map[string]string{}, map[string]string{}
	if wf != nil {
		for _, w := range wf.Workflows {
			workflows[w.ID] = w.Name
		}
		for _, st := range wf.Steps {
			steps[st.ID], workflowOf[st.ID] = st.Name, st.WorkflowID
		}
	}
	from := ""
	if d.Step != nil {
		from = d.Step.WorkflowID
	}
	var out []PromptOutcome
	for _, k := range d.Connectors {
		o := PromptOutcome{Name: k.Name, Done: k.ToStepID == nil}
		if k.ToStepID != nil {
			if to := workflowOf[*k.ToStepID]; to != "" && to != from && workflows[to] != "" {
				o.To = workflows[to] + " › " + steps[*k.ToStepID]
			}
		}
		out = append(out, o)
	}
	return out
}

// leadsToAStep says some outcome of the Task's Step leads to a Step, not into Done: only then
// does the prompt need the Project's Workflows, to name one in another Workflow.
func leadsToAStep(d *client.TaskDetail) bool {
	for _, k := range d.Connectors {
		if k.ToStepID != nil {
			return true
		}
	}
	return false
}
