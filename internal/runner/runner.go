// Package runner is the Runner of a Local Install (ADR 0013): for each agent Member it has a
// token for, it pulls Tasks through `next`, prepares the Workspaces, starts the agent's command
// with a prompt from the record, keeps the Claim's Heartbeats while the session shows progress,
// nudges a session that stops without a decision, and ends the session when the Claim ends,
// attaching its log as Evidence. It merges a Task's branch into its Parent's, or the default
// branch, when the Task ends Done, and a Parent's into the default branch when it completes
// (ADR 0015). It is a client of the record (plan invariant 9), never a second scheduler.
package runner

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/cli/remote"
	"github.com/tuongaz/darkory/internal/runnerapi"
)

// Timings are the runner's clocks. The defaults are the plan's; tests shorten them through
// DARKORY_RUNNER_TIMINGS.
type Timings struct {
	// Wait is how long one `next` waits for a takeable Task.
	Wait time.Duration
	// ClaimTimeout is the Claims' heartbeat timeout.
	ClaimTimeout time.Duration
	// Tick is how often a session's progress is read and a Heartbeat sent.
	Tick time.Duration
	// Stale is how long a progress file may go unchanged before Heartbeats stop.
	Stale time.Duration
	// Nudge is the time between nudges, and between the last nudge and the release.
	Nudge time.Duration
	// Exit is how long a session has to exit after /exit before it is killed.
	Exit time.Duration
	// Poll is how often merged pull requests are looked for.
	Poll time.Duration
	// Retry is the pause after a failed request.
	Retry time.Duration
}

// DefaultTimings are the plan's: next waits 30 s, Claims time out after 5 minutes, progress is
// read every 30 s and goes stale after 2 minutes, nudges come 2 minutes apart, a session has 30 s
// to exit, and merged pull requests are looked for every minute.
var DefaultTimings = Timings{Wait: 30 * time.Second, ClaimTimeout: 5 * time.Minute, Tick: 30 * time.Second, Stale: 2 * time.Minute,
	Nudge: 2 * time.Minute, Exit: 30 * time.Second, Poll: time.Minute, Retry: 5 * time.Second}

// ParseTimings reads timings over DefaultTimings from a list such as "wait=1s,timeout=5s,tick=200ms".
// The names are wait, timeout, tick, stale, nudge, exit, poll and retry.
func ParseTimings(s string) (Timings, error) {
	t := DefaultTimings
	for item := range strings.SplitSeq(s, ",") {
		if item = strings.TrimSpace(item); item == "" {
			continue
		}
		name, val, ok := strings.Cut(item, "=")
		d, err := time.ParseDuration(strings.TrimSpace(val))
		if !ok || err != nil || d <= 0 {
			return Timings{}, fmt.Errorf("runner timings: %q is not name=duration", item)
		}
		into := map[string]*time.Duration{"wait": &t.Wait, "timeout": &t.ClaimTimeout, "tick": &t.Tick, "stale": &t.Stale,
			"nudge": &t.Nudge, "exit": &t.Exit, "poll": &t.Poll, "retry": &t.Retry}[strings.TrimSpace(name)]
		if into == nil {
			return Timings{}, fmt.Errorf("runner timings: no timing %q (wait, timeout, tick, stale, nudge, exit, poll, retry)", name)
		}
		*into = d
	}
	return t, nil
}

// Token is an agent Member's token, as the runner reads it from <data>/agents.
type Token struct {
	// Name is the file it came from, for messages.
	Name   string
	Secret string
}

// Config says what a Runner runs.
type Config struct {
	// URL is the Install's /v1 base URL.
	URL string
	// Data is the Install's data directory: <data>/sessions is the runner's, and <data>/workspaces
	// holds its ledger of branches.
	Data string
	// Workspaces is where each Task's directory, with its checkouts, goes: <Workspaces>/<KEY>. Empty
	// is DefaultWorkspaces(Data).
	Workspaces string
	// Tokens are the agent Members' tokens; Members limits the runner to the agents of these names.
	Tokens  []Token
	Members []string
	Timings Timings
	// Tmux is auto (tmux when it is on the PATH), on or off.
	Tmux string
	// Darkory is the darkory binary sessions run `darkory mcp` with; the running one when empty.
	Darkory string
	Log     *slog.Logger
	// HTTP sends the requests; nil for one with no timeout, since `next` and Activity hold requests open.
	HTTP *http.Client
	// GitHub opens and reads pull requests; nil for the gh CLI.
	GitHub GitHub
	// Host starts sessions; nil chooses tmux or child processes by Tmux.
	Host Host
	// Dial reaches the Install as a Member in a Session; nil for Dial.
	Dial func(url, token, session string, hc *http.Client) (Record, error)
}

// RunnerSession is a running session as the runner reports it.
type RunnerSession struct {
	TaskID    string
	Task      string
	MemberID  string
	Member    string
	SessionID string
	// Host is the machine's name.
	Host string
	// Tmux says the session runs in tmux, as TmuxSession on the runner's tmux server TmuxSocket,
	// so it can be joined; a child process cannot.
	Tmux        bool
	TmuxSession string
	TmuxSocket  string
	StartedAt   time.Time
	// State is running, waiting, stalled or ending, since StateSince.
	State      string
	StateSince time.Time
	LogPath    string
}

// Session states.
const (
	StateRunning = runnerapi.StateRunning
	StateWaiting = runnerapi.StateWaiting
	StateStalled = runnerapi.StateStalled
	StateEnding  = runnerapi.StateEnding
)

// ErrNoSession is a Task with no session running on this runner.
var ErrNoSession = runnerapi.ErrNoSession

// Runner runs agent sessions.
type Runner struct {
	cfg     Config
	t       Timings
	log     *slog.Logger
	host    Host
	gh      GitHub
	ledger  *ledger
	bin     string
	machine string

	mu       sync.Mutex
	sessions map[string]*session // by Session id
	agents   []*agent
	// merges is the queue of Activity the merger works through, in order.
	merges chan client.Activity
	// kept wakes attachKept, as a Claim ends.
	kept chan struct{}
	// reader is the Record the runner reads Activity and merges with.
	reader Record
	// skills names Skills by id.
	skills map[string]client.Skill
	// repos are the locks on the repositories the runner changes, by path.
	repos map[string]*sync.Mutex
	// tried are the Tasks whose branches the merger has tried to merge, by key, merged or not.
	tried map[string]bool
}

// New returns a Runner; nothing runs until Run.
func New(cfg Config) (*Runner, error) {
	if cfg.Timings == (Timings{}) {
		cfg.Timings = DefaultTimings
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Data == "" {
		return nil, errors.New("runner: no data directory")
	}
	data, err := filepath.Abs(cfg.Data)
	if err != nil {
		return nil, err
	}
	cfg.Data = data
	if cfg.Workspaces == "" {
		cfg.Workspaces = DefaultWorkspaces(data)
	}
	if cfg.Workspaces, err = filepath.Abs(cfg.Workspaces); err != nil {
		return nil, err
	}
	r := &Runner{cfg: cfg, t: cfg.Timings, log: cfg.Log.With("component", "runner"), host: cfg.Host, gh: cfg.GitHub,
		ledger: &ledger{path: TaskDir(cfg.Data, "branches.json")}, bin: cfg.Darkory,
		sessions: map[string]*session{}, merges: make(chan client.Activity, 1024), kept: make(chan struct{}, 1), skills: map[string]client.Skill{},
		repos: map[string]*sync.Mutex{}, tried: map[string]bool{}}
	if r.host == nil {
		switch cfg.Tmux {
		case "", "auto":
			if _, err := exec.LookPath("tmux"); err == nil {
				r.host = &tmuxHost{socket: TmuxSocket(cfg.Data)}
			} else {
				r.host = childHost{}
			}
		case "on":
			if _, err := exec.LookPath("tmux"); err != nil {
				return nil, errors.New("runner: tmux is on but not on the PATH")
			}
			r.host = &tmuxHost{socket: TmuxSocket(cfg.Data)}
		case "off":
			r.host = childHost{}
		default:
			return nil, fmt.Errorf("runner: tmux is auto, on or off, not %q", cfg.Tmux)
		}
	}
	if r.gh == nil {
		r.gh = ghCLI{}
	}
	if r.bin == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		r.bin = exe
	}
	r.machine, _ = os.Hostname()
	return r, nil
}

// Run works until ctx ends, then ends the sessions it is running, closes its Darkory Sessions and
// returns. It returns an error when none of its tokens belongs to an agent it may run.
func (r *Runner) Run(ctx context.Context) error {
	defer func() {
		// Every Session the runner opened ends with it: each agent's own (the reader's among them);
		// the agents' loops close theirs before wg.Wait returns.
		for _, a := range r.agents {
			r.closeSession(ctx, a.rec, "the agent's Darkory Session", "agent", a.name())
		}
	}()
	for _, tok := range r.cfg.Tokens {
		rec, err := r.dial(tok.Secret, remote.NewSessionID())
		if err != nil {
			return err
		}
		me, err := retry(ctx, r.t.Retry, func() (*client.Me, error) { return rec.Me(ctx) })
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			r.log.Warn("skipped a token the Install does not accept", "token", tok.Name, "err", err)
			continue
		}
		// A token the runner does not run with has still started a Session, reading `me`: close it.
		if me.Member.Kind != client.Agent {
			r.log.Warn("skipped a token of a human Member; the runner runs agents only", "token", tok.Name, "member", me.Member.Name)
			r.closeSession(ctx, rec, "a skipped token's Session")
			continue
		}
		if len(r.cfg.Members) > 0 && !slices.Contains(r.cfg.Members, me.Member.Name) {
			r.closeSession(ctx, rec, "a skipped token's Session")
			continue
		}
		if slices.ContainsFunc(r.agents, func(a *agent) bool { return a.me.Member.ID == me.Member.ID }) {
			r.closeSession(ctx, rec, "a skipped token's Session")
			continue
		}
		r.agents = append(r.agents, &agent{r: r, token: tok.Secret, me: *me, rec: rec})
	}
	if len(r.agents) == 0 {
		return errors.New("runner: no agent Member to run; give it agent tokens in <data>/agents or with --token")
	}
	r.reader = r.agents[0].rec
	names := make([]string, len(r.agents))
	for i, a := range r.agents {
		names[i] = a.me.Member.Name
	}
	r.log.Info("the runner is running agents", "agents", names, "host", r.hostName(), "url", r.cfg.URL, "workspaces", r.cfg.Workspaces)

	var wg sync.WaitGroup
	after, err := retry(ctx, r.t.Retry, func() (int64, error) { return r.reader.LastSeq(ctx) })
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("runner: reading Activity as %s: %w", r.agents[0].name(), err)
	}
	wg.Go(func() { r.follow(ctx, after) })
	wg.Go(func() { r.merger(ctx) })
	wg.Go(func() { r.pollPullRequests(ctx) })
	wg.Go(func() { r.attachKept(ctx) })
	for _, a := range r.agents {
		wg.Go(func() { a.run(ctx) })
	}
	wg.Wait()
	return nil
}

// closeSession closes a Darkory Session the runner is done with, even once ctx has ended, so a
// runner that stops leaves none open. A Session the Install has already ended needs nothing.
func (r *Runner) closeSession(ctx context.Context, rec Record, what string, attrs ...any) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := rec.CloseSession(cctx); err != nil && !stopped(err) && !refusedBy(err, client.ErrorCodeNotFound) {
		r.log.Warn("closing "+what, append(attrs, "session", rec.Session(), "err", err)...)
	}
}

func (r *Runner) hostName() string {
	if r.host.Tmux() {
		return "tmux"
	}
	return "child processes"
}

// retry calls f until it succeeds or ctx ends, pausing Retry between tries.
func retry[T any](ctx context.Context, pause time.Duration, f func() (T, error)) (T, error) {
	for {
		v, err := f()
		if err == nil || answered(err) && !refusedBy(err, client.ErrorCodeTooManyRequests) {
			return v, err
		}
		if !sleep(ctx, pause) {
			var zero T
			return zero, ctx.Err()
		}
	}
}

// sleep waits d or until ctx ends, and says whether ctx is still alive.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// follow reads the Activity stream from after until ctx ends, opening it again where it dropped,
// and hands each entry to the session it is about and to the merger.
func (r *Runner) follow(ctx context.Context, after int64) {
	backoff := time.Second
	for ctx.Err() == nil {
		last, err := r.reader.Activity(ctx, after, r.dispatch)
		if last > after {
			after, backoff = last, time.Second
		}
		if ctx.Err() != nil {
			return
		}
		if stopped(err) {
			r.log.Error("the Install no longer accepts the runner's Activity stream", "err", err)
			return
		}
		r.log.Debug("the Activity stream dropped; reopening", "after", after, "err", err)
		if !sleep(ctx, backoff) {
			return
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// claimEnds are the Activity kinds that end a Claim; each carries the Claim's id.
var claimEnds = []client.ActivityKind{client.ActivityKindTaskCompleted, client.ActivityKindTaskAdvanced, client.ActivityKindTaskMoved,
	client.ActivityKindTaskSplit,
	client.ActivityKindTaskReleased, client.ActivityKindTaskTakenBack, client.ActivityKindTaskLapsed,
	client.ActivityKindTaskClaimEnded, client.ActivityKindTaskDropped}

func (r *Runner) dispatch(a client.Activity) {
	if slices.Contains(claimEnds, a.Kind) {
		claim, _ := a.Payload["claim_id"].(string)
		r.mu.Lock()
		for _, s := range r.sessions {
			if s.taskID == a.SubjectID && claim != "" && claim == s.claimID {
				s.claimEnded(string(a.Kind))
			}
		}
		r.mu.Unlock()
		r.wakeKept()
	}
	switch a.Kind {
	case client.ActivityKindTaskCompleted, client.ActivityKindTaskDropped:
		select {
		case r.merges <- a:
		default:
			r.log.Error("the merge queue is full; an Activity entry was not looked at", "seq", a.Seq, "kind", a.Kind)
		}
	}
}

// dial reaches the Install as the Member token belongs to, in Session session.
func (r *Runner) dial(token, session string) (Record, error) {
	if r.cfg.Dial != nil {
		return r.cfg.Dial(r.cfg.URL, token, session, r.cfg.HTTP)
	}
	return Dial(r.cfg.URL, token, session, r.cfg.HTTP)
}

var _ runnerapi.Runner = (*Runner)(nil)

// Sessions are the sessions running now, oldest first, as the server serves them.
func (r *Runner) Sessions() []runnerapi.Session {
	running := r.Running()
	out := make([]runnerapi.Session, len(running))
	for i, s := range running {
		out[i] = runnerapi.Session{TaskID: s.TaskID, MemberID: s.MemberID, SessionID: s.SessionID, Host: s.Host,
			Tmux: s.TmuxSession, StartedAt: s.StartedAt, State: s.State, StateSince: s.StateSince, LogPath: s.LogPath}
	}
	return out
}

// Running are the sessions running now, oldest first.
func (r *Runner) Running() []RunnerSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RunnerSession, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s.snapshot())
	}
	slices.SortFunc(out, func(a, b RunnerSession) int { return a.StartedAt.Compare(b.StartedAt) })
	return out
}

// session finds the latest session of a Task, by id or key. Two can run for a moment: one ending
// after its agent advanced the Task, the next starting.
func (r *Runner) session(task string) *session {
	r.mu.Lock()
	defer r.mu.Unlock()
	var latest *session
	for _, s := range r.sessions {
		if (s.taskID == task || s.key == task) && (latest == nil || s.started.After(latest.started)) {
			latest = s
		}
	}
	return latest
}

// Nudge types the nudge into a Task's session now.
func (r *Runner) Nudge(task string) error {
	s := r.session(task)
	if s == nil {
		return ErrNoSession
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.command(ctx, cmdNudge)
}

// Stop ends a Task's session and releases the Task with a Note. It returns once the session is
// stopping; the release and the log follow.
func (r *Runner) Stop(task string) error {
	s := r.session(task)
	if s == nil {
		return ErrNoSession
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.command(ctx, cmdStop)
}

// Merge merges a Task's open pull request on GitHub for by, the Member who asked. Not yet: until
// the Runner reads pull requests it finds none (docs/build/dogfood-followups-plan.md, Task 2).
func (r *Runner) Merge(_ context.Context, _, _ string) error {
	return runnerapi.ErrNoPullRequest
}

// Socket is the tmux server the runner's sessions run on, for `tmux -L`.
func (r *Runner) Socket() string { return TmuxSocket(r.cfg.Data) }

// skill finds a Skill by id, reading the Skills again when it does not know it.
func (r *Runner) skill(ctx context.Context, rec Record, id string) (client.Skill, bool) {
	r.mu.Lock()
	s, ok := r.skills[id]
	r.mu.Unlock()
	if ok {
		return s, true
	}
	list, err := rec.Skills(ctx)
	if err != nil {
		return client.Skill{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, sk := range list {
		r.skills[sk.ID] = sk
	}
	s, ok = r.skills[id]
	return s, ok
}
