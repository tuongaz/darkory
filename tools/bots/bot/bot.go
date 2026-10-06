// Package bot runs agent Members against a Darkory Install: programs that work as an agent such as
// Claude Code does, taking Tasks with next, heartbeating, writing Notes, attaching Evidence,
// asking questions, handing over and completing. The e2e suite runs them as scenario tests and
// tools/bots runs them as a live load. Bots talk to the Install through the generated client, and
// through the real darkory binary where what they prove is about the CLI (Stuck). The package
// imports nothing under internal/.
package bot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/tuongaz/darkory/client"
)

// Bot is one agent Member at work.
type Bot interface {
	Name() string
	// Run works until ctx ends, or until the bot is done (a Lapser that claims once, a Stuck taken
	// back with no Rest). It returns an error only when it cannot go on, such as a revoked token.
	Run(ctx context.Context) error
}

// Member is an agent Member as a running copy of it knows itself: its token, and the Session id
// it chose.
type Member struct {
	Name, ID, Token, Session string
}

// Config is what every bot of a run shares.
type Config struct {
	// URL is the Install's base URL.
	URL  string
	Pace Pace
	// Report is told of everything the bots do, from many goroutines at once.
	Report func(Event)
	// HTTP sends the requests; nil for http.DefaultClient.
	HTTP *http.Client
	// Binary is the darkory binary the bots that use the CLI run, with Env as their environment
	// besides the Install's URL, the token and the Session.
	Binary string
	Env    []string
}

// Pace is how fast the bots work: Fast for tests, Human for a live load people watch.
type Pace struct {
	Name string
	// Work is how long a Task takes a builder or reviewer, at random between the two.
	Work [2]time.Duration
	// Step is the pause between one write and the next, as a planner files a plan.
	Step time.Duration
	// Wait is how many seconds next waits for a takeable Task.
	Wait int
	// Poll is how often a bot looks again: the prober's next, a builder waiting for an answer.
	Poll time.Duration
	// Timeout is the heartbeat timeout of every Claim but the lapser's, in seconds, and Heartbeat
	// how often the bots send one.
	Timeout   int
	Heartbeat time.Duration
	// LapseTimeout is the lapser's Claim timeout in seconds; LapseEvery how often it claims again,
	// or 0 to claim once and exit.
	LapseTimeout int
	LapseEvery   time.Duration
	// Patience is how long a builder holds a Task blocked on its question before releasing it.
	Patience time.Duration
	// Rest is how long Stuck rests after a take-back before taking work again, or 0 to stop.
	Rest time.Duration
}

// Fast is the pace of the scenario tests: every bot finishes a Task within a second.
var Fast = Pace{Name: "fast", Work: [2]time.Duration{200 * time.Millisecond, 600 * time.Millisecond}, Step: 20 * time.Millisecond,
	Wait: 1, Poll: 100 * time.Millisecond, Timeout: 3, Heartbeat: 500 * time.Millisecond, LapseTimeout: 2, Patience: 2 * time.Minute}

// Human is the pace of a live load: a builder takes 30–90 s per Task and heartbeats every 15 s,
// the lapser lapses once a minute, and Stuck holds its Task until someone takes it back.
var Human = Pace{Name: "human", Work: [2]time.Duration{30 * time.Second, 90 * time.Second}, Step: 3 * time.Second,
	Wait: 30, Poll: 5 * time.Second, Timeout: 45, Heartbeat: 15 * time.Second, LapseTimeout: 20, LapseEvery: time.Minute,
	Patience: 3 * time.Minute, Rest: 2 * time.Minute}

// Event is one thing a bot did or met.
type Event struct {
	At  time.Time
	Bot string
	// What is a short verb phrase: took, nothing, noted, attached, asked, answered, observed,
	// handed over, completed, released, filed, blocked, moved, proposed, published, went silent,
	// lapsed, taken back, lost, refused, failed.
	What string
	// Task is the display key of the Task it is about, if any.
	Task string
	// Text says the rest, for people.
	Text string
	// Code is the CLI's exit status when a darkory command ended the step.
	Code int
	// Err is set on failed: something the bot did not expect.
	Err error
}

func (e Event) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %-10s %-12s", e.At.Format("15:04:05.000"), e.Bot, e.What)
	if e.Task != "" {
		fmt.Fprintf(&b, " %s", e.Task)
	}
	if e.Text != "" {
		fmt.Fprintf(&b, " %s", e.Text)
	}
	if e.Err != nil {
		fmt.Fprintf(&b, ": %v", e.Err)
	}
	return b.String()
}

// APIError is a refusal or failure the Install answered with.
type APIError struct {
	Status  int
	Code    client.ErrorCode
	Message string
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("status %d: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Code returns err's error code, or "" when the Install did not answer with one.
func Code(err error) client.ErrorCode {
	var e *APIError
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

type response interface {
	StatusCode() int
	GetBody() []byte
}

// check turns a generated client call's result into an error unless its status is one of ok.
func check(res response, err error, ok ...int) error {
	if err != nil {
		return err
	}
	if slices.Contains(ok, res.StatusCode()) {
		return nil
	}
	var body client.Error
	if json.Unmarshal(res.GetBody(), &body) != nil || body.Code == "" {
		return &APIError{Status: res.StatusCode(), Message: strings.TrimSpace(string(res.GetBody()))}
	}
	return &APIError{Status: res.StatusCode(), Code: body.Code, Message: body.Message}
}

// Dial returns a client acting as m in m's Session, with a fresh Idempotency-Key on every write.
func Dial(url string, hc *http.Client, m Member) (*client.ClientWithResponses, error) {
	opts := []client.ClientOption{client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+m.Token)
		req.Header.Set("Darkory-Session", m.Session)
		if req.Method != http.MethodGet && req.Header.Get("Idempotency-Key") == "" {
			req.Header.Set("Idempotency-Key", uuid.Must(uuid.NewV7()).String())
		}
		return nil
	})}
	if hc != nil {
		opts = append(opts, client.WithHTTPClient(hc))
	}
	return client.NewClientWithResponses(url, opts...)
}

// NewSession returns a Session id, as darkory prime makes one.
func NewSession() string { return uuid.Must(uuid.NewV7()).String() }

// agent is what every bot has: who it is, how it talks to the Install and how it reports.
type agent struct {
	cfg   Config
	m     Member
	model string
	c     *client.ClientWithResponses
	rng   *rand.Rand

	mu    sync.Mutex
	names map[string]string // Status names by id
}

func newAgent(cfg Config, m Member, model string) agent {
	c, err := Dial(cfg.URL, cfg.HTTP, m)
	if err != nil {
		panic(err) // only a malformed URL fails, which is the caller's bug
	}
	return agent{cfg: cfg, m: m, model: model, c: c, rng: rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))}
}

func (a *agent) Name() string { return a.m.Name }

func (a *agent) say(what, task, format string, args ...any) {
	if a.cfg.Report != nil {
		a.cfg.Report(Event{At: time.Now(), Bot: a.m.Name, What: what, Task: task, Text: fmt.Sprintf(format, args...)})
	}
}

// fail reports err unless ctx has ended, which explains it.
func (a *agent) fail(ctx context.Context, task string, err error) {
	if ctx.Err() != nil || a.cfg.Report == nil {
		return
	}
	a.cfg.Report(Event{At: time.Now(), Bot: a.m.Name, What: "failed", Task: task, Err: err})
}

// stopped says whether err means the Install no longer accepts this bot: its token was revoked,
// its Session closed or its Member deactivated.
func stopped(err error) bool {
	switch Code(err) {
	case client.ErrorCodeUnauthenticated, client.ErrorCodeSessionRequired:
		return true
	}
	return false
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

// work is how long the next Task takes, at random within the pace's range.
func (a *agent) work() time.Duration {
	lo, hi := a.cfg.Pace.Work[0], a.cfg.Pace.Work[1]
	if hi <= lo {
		return lo
	}
	return lo + time.Duration(a.rng.Int64N(int64(hi-lo)))
}

// next asks for a takeable Task, waiting up to wait seconds, and claims it with a heartbeat
// timeout of timeout seconds and the bot's model label. It returns nil when nothing came.
func (a *agent) next(ctx context.Context, wait, timeout int) (*client.TaskDetail, error) {
	body := client.NextTaskBody{WaitSeconds: &wait, HeartbeatTimeoutSeconds: &timeout}
	if a.model != "" {
		body.ModelLabel = &a.model
	}
	res, err := a.c.NextTaskWithResponse(ctx, &client.NextTaskParams{}, body)
	if err := check(res, err, http.StatusOK, http.StatusNoContent); err != nil {
		return nil, err
	}
	if res.StatusCode() == http.StatusNoContent {
		return nil, nil
	}
	return res.JSON200, nil
}

// took reports a Task just claimed.
func (a *agent) took(d *client.TaskDetail) {
	c := d.Task.Claim
	hb := "no heartbeat timeout"
	if c != nil && c.HeartbeatTimeoutSeconds != nil {
		hb = fmt.Sprintf("heartbeat timeout %ds", *c.HeartbeatTimeoutSeconds)
	}
	a.say("took", d.Task.Key, "%q (%s, now %s; %s, model %s)", d.Task.Title, d.Task.Kind, d.Status.Name, hb, or(a.model, "none"))
}

// count says n things, as "1 Note" or "2 Notes".
func count(n int, thing string) string {
	if n == 1 {
		return "1 " + thing
	}
	return fmt.Sprintf("%d %ss", n, thing)
}

func or(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// hold heartbeats the Claim on d's Task every Pace.Heartbeat until stop is called. The context it
// returns ends when the Claim is gone (lapsed, taken back or ended some other way), which it
// reports as lost, and when stop is called. stop waits for the last Heartbeat, so a write made
// after it, on the parent context, never races one.
func (a *agent) hold(ctx context.Context, d *client.TaskDetail) (context.Context, func()) {
	hctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	quit := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(a.cfg.Pace.Heartbeat)
		defer t.Stop()
		for {
			select {
			case <-quit:
				return
			case <-hctx.Done():
				return
			case <-t.C:
			}
			res, err := a.c.HeartbeatWithResponse(hctx, d.Task.ID, &client.HeartbeatParams{})
			if err := check(res, err, http.StatusOK); err != nil {
				select {
				case <-quit:
					return
				default:
				}
				if Code(err) == client.ErrorCodeNotHolder || stopped(err) {
					a.say("lost", d.Task.Key, "the Heartbeat was refused (%v); stopping work on it", err)
					cancel()
					return
				}
				a.fail(hctx, d.Task.Key, fmt.Errorf("heartbeat: %w", err))
				continue
			}
			if s := res.JSON200.Status; s != client.HeartbeatStatusOk {
				a.say("lost", d.Task.Key, "the Heartbeat answered %s; stopping work on it", s)
				cancel()
				return
			}
		}
	}()
	var once sync.Once
	return hctx, func() {
		once.Do(func() { close(quit) })
		<-done
		cancel()
	}
}

// listStatuses reads the Organisation's Statuses, in order, and remembers their names.
func (a *agent) listStatuses(ctx context.Context) ([]client.Status, error) {
	res, err := a.c.ListStatusesWithResponse(ctx)
	if err := check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.names = map[string]string{}
	for _, s := range res.JSON200.Items {
		a.names[s.ID] = s.Name
	}
	return res.JSON200.Items, nil
}

// statusName names a Status by id for the bot's reports.
func (a *agent) statusName(ctx context.Context, id string) string {
	a.mu.Lock()
	n, ok := a.names[id]
	a.mu.Unlock()
	if !ok {
		a.listStatuses(ctx)
		a.mu.Lock()
		n, ok = a.names[id]
		a.mu.Unlock()
	}
	if !ok {
		return id
	}
	return n
}

// firstOfKind returns the id and name of the first Status of kind, or empty strings when the
// Organisation has none.
func firstOfKind(list []client.Status, kind client.StatusKind) (string, string) {
	for _, s := range list {
		if s.Kind == kind {
			return s.ID, s.Name
		}
	}
	return "", ""
}

// skill reads a Skill by id or name.
func (a *agent) skill(ctx context.Context, ref string) (*client.SkillDetail, error) {
	res, err := a.c.GetSkillWithResponse(ctx, ref)
	if err := check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	return res.JSON200, nil
}

// gone returns nil when wctx, the context a Claim's work runs in, has ended: the Claim was lost
// (reported already) or the bot is stopping. Otherwise it returns err.
func gone(wctx context.Context, err error) error {
	if wctx.Err() != nil {
		return nil
	}
	return err
}

func (a *agent) note(ctx context.Context, key, body string) error {
	res, err := a.c.AddNoteWithResponse(ctx, key, &client.AddNoteParams{}, client.AddNoteBody{Body: body})
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	a.say("noted", key, "%q", body)
	return nil
}

func (a *agent) attach(ctx context.Context, key, filename, content string) error {
	res, err := a.c.AttachTaskEvidenceWithBodyWithResponse(ctx, key, &client.AttachTaskEvidenceParams{Filename: filename},
		"text/plain; charset=utf-8", bytes.NewReader([]byte(content)))
	if err := check(res, err, http.StatusCreated); err != nil {
		return err
	}
	a.say("attached", key, "%s (%d bytes)", filename, res.JSON201.Size)
	return nil
}

func (a *agent) complete(ctx context.Context, key, note string) (*client.Task, error) {
	res, err := a.c.CompleteTaskWithResponse(ctx, key, &client.CompleteTaskParams{}, client.CompleteTaskBody{Note: &note})
	if err := check(res, err, http.StatusOK); err != nil {
		return nil, err
	}
	a.say("completed", key, "with the Note %q; now %s", note, a.statusName(ctx, res.JSON200.StatusID))
	return res.JSON200, nil
}

func (a *agent) handover(ctx context.Context, key, skill, status, note string) error {
	body := client.HandoverTaskBody{Skill: skill, Note: &note}
	if status != "" {
		body.Status = &status
	}
	res, err := a.c.HandoverTaskWithResponse(ctx, key, &client.HandoverTaskParams{}, body)
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	a.say("handed over", key, "to %s, now %s, with the Note %q", skill, a.statusName(ctx, res.JSON200.StatusID), note)
	return nil
}

func (a *agent) release(ctx context.Context, key, note string) error {
	res, err := a.c.ReleaseTaskWithResponse(ctx, key, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: &note})
	if err := check(res, err, http.StatusOK); err != nil {
		return err
	}
	a.say("released", key, "with the Note %q; now %s", note, a.statusName(ctx, res.JSON200.StatusID))
	return nil
}

// loop runs step until ctx ends, pausing a Poll after a failure. step returns false when the bot
// is done; an error that means the Install no longer accepts the bot ends the loop with it.
func (a *agent) loop(ctx context.Context, step func() (bool, error)) error {
	for ctx.Err() == nil {
		more, err := step()
		if err != nil {
			if stopped(err) {
				a.say("stopped", "", "the Install no longer accepts this bot: %v", err)
				return err
			}
			a.fail(ctx, "", err)
			sleep(ctx, a.cfg.Pace.Poll)
		}
		if !more {
			return nil
		}
	}
	return nil
}
