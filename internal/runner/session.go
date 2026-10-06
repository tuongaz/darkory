package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// silentPrefix starts the Note of every release for a session that ended without a decision, so
// the runner can count them on the Task (three file a question to the Feature owner).
const silentPrefix = "Session ended without a decision"

// silentLimit is how many releases without a decision file a question to the Feature owner.
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
	// progress is the file the agent writes as it works; empty when there is none to read.
	progress, claudeDir string
	transcript          bool

	ended chan string
	cmds  chan sessionCmd
	over  chan struct{}

	mu    sync.Mutex
	state string

	lastProgress time.Time
	stale        bool
	nudges       int
	lastNudge    time.Time
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
	return &session{r: a.r, a: a, rec: rec, d: d, set: set, key: d.Task.Key, taskID: d.Task.ID, claimID: claimID,
		started: time.Now(), log: a.r.log.With("agent", a.name(), "task", d.Task.Key), dir: dir, logPath: filepath.Join(dir, "pane.log"),
		ended: make(chan string, 1), cmds: make(chan sessionCmd), over: make(chan struct{}), state: StateRunning}
}

func (s *session) snapshot() RunnerSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	rs := RunnerSession{TaskID: s.taskID, Task: s.key, MemberID: s.a.me.Member.ID, Member: s.a.name(), SessionID: s.rec.Session(),
		Host: s.r.machine, StartedAt: s.started, State: s.state, LogPath: s.logPath}
	// A session being prepared on a tmux host is shown in tmux already: that is where it starts.
	if s.r.host.Tmux() && (s.proc == nil || s.proc.Tmux()) {
		rs.Tmux, rs.TmuxSession, rs.TmuxSocket = true, TmuxName(s.key), s.r.Socket()
	}
	return rs
}

func (s *session) setState(st string) {
	s.mu.Lock()
	s.state = st
	s.mu.Unlock()
}

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
		close(s.over)
		r.mu.Lock()
		delete(r.sessions, s.rec.Session())
		r.mu.Unlock()
		s.cleanUp(context.WithoutCancel(ctx))
	}()
	s.log.Info("took a Task", "title", s.d.Task.Title, "status", s.d.Status.Name, "session", s.rec.Session())
	err := s.waitForEarlier(ctx)
	if err == nil {
		err = s.start(ctx)
	}
	if err != nil {
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if ctx.Err() != nil {
			s.release(bctx, "The runner stopped before the session started.")
			return true
		}
		s.log.Error("could not start the session", "err", err)
		s.giveUp(bctx, fmt.Sprintf("the runner could not start it: %s", remote.CleanLine(err.Error())))
		return false
	}
	s.log.Info("started the session", "host", r.hostName(), "log", s.logPath, "progress", s.progress)
	s.watch(ctx)
	return true
}

// waitForEarlier waits, heartbeating, while an earlier session of the Task ends, as the builder's
// does after it hands over to a review this runner takes at once: the two share the Task's
// worktree, log and tmux session.
func (s *session) waitForEarlier(ctx context.Context) error {
	for {
		s.r.mu.Lock()
		busy := false
		for _, o := range s.r.sessions {
			busy = busy || o != s && o.taskID == s.taskID
		}
		s.r.mu.Unlock()
		if !busy {
			return nil
		}
		if !sleep(ctx, s.r.t.Tick) {
			return ctx.Err()
		}
		if _, err := s.rec.Heartbeat(ctx, s.key); err != nil && ctx.Err() == nil {
			s.log.Warn("heartbeat while an earlier session ends", "err", err)
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
	f, err := s.rec.Feature(ctx, s.d.Feature.Key)
	if err != nil {
		return fmt.Errorf("reading Feature %s: %w", s.d.Feature.Key, err)
	}
	wss, err := s.rec.Workspaces(ctx, s.d)
	if err != nil {
		return fmt.Errorf("reading the Task's Workspaces: %w", err)
	}
	checkouts, err := r.Prepare(ctx, s.key, f.Key, PlanCheckouts(r.cfg.Data, s.key, s.d.Task.Title, f.Key, f.Quick, wss))
	if err != nil {
		return fmt.Errorf("preparing the Workspaces: %w", err)
	}
	cwd := TaskDir(r.cfg.Data, s.key)
	if len(checkouts) > 0 {
		cwd = checkouts[0].Dir
	}
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		return err
	}
	p, err := s.prompt(ctx, f, checkouts)
	if err != nil {
		return err
	}
	promptFile := filepath.Join(s.dir, "prompt.md")
	if err := os.WriteFile(promptFile, []byte(BuildPrompt(p)), 0o600); err != nil {
		return err
	}
	// The darkory the runner is goes first on the PATH, so the session's CLI is the same release.
	env := []string{remote.EnvURL + "=" + r.cfg.URL, remote.EnvToken + "=" + s.a.token, remote.EnvSession + "=" + s.rec.Session(),
		"PATH=" + filepath.Dir(r.bin) + string(os.PathListSeparator) + os.Getenv("PATH")}
	mcpFile := filepath.Join(s.dir, "mcp.json")
	if err := s.writeMCPConfig(mcpFile, TaskDir(r.cfg.Data, s.key)); err != nil {
		return err
	}
	v := Values{PromptFile: promptFile, Workspace: cwd, SessionID: s.rec.Session(), Model: s.set.Model, MCPConfig: mcpFile, Task: s.key}
	argv, err := Render(s.set.Command, s.set.Args, s.set.Unattended, v)
	if err != nil {
		return err
	}
	switch {
	case s.set.ProgressFile != "":
		if s.progress, err = Expand(s.set.ProgressFile, v); err != nil {
			return err
		}
		if !filepath.IsAbs(s.progress) {
			s.progress = filepath.Join(cwd, s.progress)
		}
	case IsClaude(s.set.Command):
		s.claudeDir = ClaudeDir(s.set.Env)
		s.progress, s.transcript = TranscriptPath(s.claudeDir, cwd, s.rec.Session()), true
	}
	keys := make([]string, 0, len(s.set.Env))
	for k := range s.set.Env {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		env = append(env, k+"="+s.set.Env[k])
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
func (s *session) prompt(ctx context.Context, f *FeatureInfo, checkouts []Checkout) (Prompt, error) {
	members, err := s.rec.Members(ctx)
	if err != nil {
		return Prompt{}, err
	}
	names := map[string]string{}
	for _, m := range members {
		names[m.ID] = m.Name
	}
	manager := f.Owner
	if id := s.a.me.Member.ManagerID; id != nil && names[*id] != "" {
		manager = names[*id]
	}
	d := s.d
	p := Prompt{Agent: s.a.name(), Manager: manager, Dir: TaskDir(s.r.cfg.Data, s.key), Checkouts: checkouts, Rules: remote.Rules,
		Task:    PromptTask{Key: d.Task.Key, Title: d.Task.Title, Description: d.Task.Description, Status: d.Status.Name, Kind: string(d.Task.Kind)},
		Feature: PromptFeature{Key: f.Key, Title: f.Title, Description: f.Description, Owner: f.Owner, Quick: f.Quick}}
	if id := d.Task.SkillID; id != nil {
		sk, err := s.rec.Skill(ctx, *id)
		if err != nil {
			return Prompt{}, err
		}
		p.Task.Skill = sk.Skill.Name
		texts := []*client.SkillDetail{sk}
		if sk.Skill.Kind == client.Company && sk.Skill.BaseSkillID != nil {
			if base, err := s.rec.Skill(ctx, *sk.Skill.BaseSkillID); err == nil {
				texts = append(texts, base)
			}
		} else {
			// The company's version of a generic Skill, when the agent has one, comes first.
			for _, own := range s.a.me.Skills {
				if own.Kind == client.Company && own.BaseSkillID != nil && *own.BaseSkillID == sk.Skill.ID {
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
		if e.TaskID != nil && *e.TaskID == d.Task.ID {
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
				s.log.Info("an admin stopped the session")
				c.done <- nil
				s.end(ctx, "An admin stopped the session; the Task goes back for another.")
				return
			}
			s.log.Info("nudged by an admin")
			s.setState(StateNudged)
			c.done <- s.proc.Type(Nudge)
		case <-t.C:
			if s.check(ctx) {
				return
			}
		}
	}
}

// check reads the session's progress: a Heartbeat while it is fresh, none once it is stale, and a
// nudge when the agent's turn ended with the Claim still held. It says whether the session ended.
func (s *session) check(ctx context.Context) bool {
	var rd Reading
	if s.progress == "" {
		// Nothing to read: the session counts as working while its command runs.
		s.lastProgress = time.Now()
	} else {
		var err error
		rd, err = ReadProgress(s.progress)
		if err != nil {
			s.log.Warn("reading the session's progress", "file", s.progress, "err", err)
		}
		if !rd.Exists && s.transcript {
			if found := findTranscript(s.claudeDir, s.rec.Session()); found != "" && found != s.progress {
				s.log.Info("found the session's transcript elsewhere", "file", found)
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
	if time.Since(s.lastProgress) < s.r.t.Stale {
		if s.stale {
			s.log.Info("the session shows progress again; sending Heartbeats")
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
			s.log.Info("the session's progress went stale; no more Heartbeats, so the Claim lapses unless it moves again",
				"last_progress", s.lastProgress.Format(time.RFC3339))
			s.stale = true
		}
		// The lapse comes on the Activity stream; this catches it should the stream miss it.
		if d, err := s.rec.Task(ctx, s.key); err == nil && !s.holds(d) {
			return s.finish(ctx, "lapsed")
		}
	}
	if !rd.Ended {
		return false
	}
	return s.turnEnded(ctx)
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
		s.setState(StateNudged)
		s.log.Info("the agent stopped without ending the Task; nudged it", "nudge", s.nudges)
		if err := s.proc.Type(Nudge); err != nil {
			s.log.Warn("nudging", "err", err)
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
		s.log.Warn("reading the Task after the session exited", "err", err)
		s.giveUp(ctx, "")
	case !s.holds(d):
		s.log.Info("the session exited after its Claim ended", "exit_code", code)
		s.attachLog(ctx)
	case d.Task.Blocked:
		s.asked(ctx, d)
	default:
		s.log.Info("the session exited without a decision", "exit_code", code)
		s.giveUp(ctx, "")
	}
}

// finish ends a session whose Claim ended: the agent completed, handed over or asked, or someone
// took it back, or it lapsed.
func (s *session) finish(ctx context.Context, how string) bool {
	s.log.Info("the Claim ended; ending the session", "how", strings.TrimPrefix(how, "task."))
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
// every third such release files a question to the Feature owner that blocks the Task. why says
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
			if strings.HasPrefix(nt.Body, silentPrefix) {
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

// escalate files a question aimed at the Feature owner that blocks the Task, after the runner has
// released it n times without a decision. It is filed while the session still holds the Task, so
// nobody takes it in between.
func (s *session) escalate(ctx context.Context, d *client.TaskDetail, n int) {
	title := fmt.Sprintf("The runner released %s %s times without a decision", s.key, map[int]string{3: "three"}[n])
	if n != silentLimit {
		title = fmt.Sprintf("The runner released %s %d times without a decision", s.key, n)
	}
	body := fmt.Sprintf("Sessions of %s ended %d times without completing %s, handing it over or asking a question; "+
		"its Notes say how each ended. Answer here what the agent should do (or drop the Task), then complete this "+
		"question: %s stays blocked until then.", s.a.name(), n, s.key, s.key)
	owner := d.Feature.OwnerID
	q, err := s.rec.File(ctx, client.FileTaskBody{Title: title, Description: &body, AimedAt: &owner, Blocks: &s.key})
	if err != nil {
		s.log.Error("could not file the question to the Feature owner", "err", err)
		return
	}
	s.log.Info("filed a question to the Feature owner", "question", q.Key, "releases", n)
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
	s.log.Info("the session did not exit; killing it")
	if err := s.proc.Kill(); err != nil {
		s.log.Warn("killing the session", "err", err)
	}
	select {
	case <-s.proc.Done():
	case <-time.After(5 * time.Second):
		s.log.Warn("the session is still running after it was killed")
	}
}

// shutdown ends the session because the runner is stopping: the Task goes back with a Note.
func (s *session) shutdown(ctx context.Context) {
	s.log.Info("the runner is stopping; ending the session")
	s.setState(StateEnding)
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	s.stopCommand(bctx, 2*time.Second)
	s.release(bctx, "The runner stopped while the session ran; the Task goes back for another session.")
	s.attachLog(bctx)
}

// attachLog attaches the session's log as Evidence, on the Task, or on its Feature when someone
// else holds the Task by now.
func (s *session) attachLog(ctx context.Context) {
	b, err := readTail(s.logPath, maxLog)
	if err != nil || len(b) == 0 {
		if err != nil {
			s.log.Warn("reading the session's log", "err", err)
		}
		return
	}
	name := "session-" + s.key + ".log"
	onFeature, err := s.rec.Attach(ctx, s.key, s.d.Feature.Key, name, b)
	switch {
	case err != nil:
		s.log.Error("could not attach the session's log", "err", err)
	case onFeature:
		s.log.Info("attached the session's log to the Feature; the Task is held by someone else", "feature", s.d.Feature.Key, "evidence", name)
	default:
		s.log.Info("attached the session's log", "evidence", name, "bytes", len(b))
	}
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
