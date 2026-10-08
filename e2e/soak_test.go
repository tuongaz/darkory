package e2e

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/tuongaz/darkory/client"
)

// The soak: 40 agent Sessions of 4 Members with mixed Skills work 300 and more Tasks for a few
// minutes through the generated client, while two humans file Tasks with Break down and their
// Subtasks, complete the Parents whose Subtasks have ended, and readers follow the Activity
// stream. Agents take work by next and by claim, heartbeat, release, advance to another Step,
// complete, ask blocking questions, and sometimes go silent so their Claims lapse; some writes are
// sent twice under one Idempotency-Key, one after the other or at once. Then the record is
// checked: Claims on a Task never overlap; no Member held a Task under two Skills; a Task is at
// exactly one Step of its own Project's Workflow or none, and none when it is a Parent or has
// ended; Activity has no gaps and every stream saw all of it in order; no 5xx and no busy
// database anywhere; every Task's state agrees with its Claims; retries wrote nothing twice.
//
// DARKORY_E2E_SOAK sets how long the agents work (default 2m), and DARKORY_E2E_SOAK_TASKS how
// many Tasks the humans file (default 360), a quarter of them at once.
func TestSoak(t *testing.T) {
	needE2E(t)
	t.Run(engine(), func(t *testing.T) { soak(t, 1) })
	if engine() == "postgres" {
		t.Run("postgres-two-processes", func(t *testing.T) { soak(t, 2) })
	}
}

const (
	soakSessionsPerMember = 10
	soakClaimTimeout      = 3 // seconds
)

// soakTasks is how many Tasks the humans file in all.
func soakTasks(t *testing.T) int {
	if v := os.Getenv("DARKORY_E2E_SOAK_TASKS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 2 {
			t.Fatalf("DARKORY_E2E_SOAK_TASKS: %q", v)
		}
		return n
	}
	return 360
}

var soakSkills = []string{"s-a", "s-b", "s-c", "s-d"}

// soakSteps are the work Steps of the soak's Workflow, each carrying the Skill of soakSkills at
// its index.
var soakSteps = []string{"A", "B", "C", "D"}

// soakFlow is the soak's Workflow: Plan carrying breakdown and Retro carrying retro, each with one
// way into Done; and the work Steps A to D, each with one way into Done, "done", and one to every
// other work Step, "to-<step>", so a holder may complete a Task at any of them or advance it on.
func soakFlow() string {
	type step struct {
		Name     string `json:"name"`
		Skill    string `json:"skill"`
		Position int    `json:"position"`
	}
	type connector struct {
		From     string  `json:"from"`
		To       *string `json:"to,omitempty"`
		Name     string  `json:"name"`
		Position int     `json:"position"`
	}
	steps := []step{{"Plan", "breakdown", 1}}
	connectors := []connector{{From: "Plan", Name: "done", Position: 1}}
	for i, name := range soakSteps {
		steps = append(steps, step{name, soakSkills[i], i + 2})
		connectors = append(connectors, connector{From: name, Name: "done", Position: 1})
		for j, to := range soakSteps {
			if to != name {
				connectors = append(connectors, connector{From: name, To: ptr(to), Name: "to-" + strings.ToLower(to), Position: j + 2})
			}
		}
	}
	steps = append(steps, step{"Retro", "retro", len(soakSteps) + 2})
	connectors = append(connectors, connector{From: "Retro", Name: "done", Position: 1})
	b, _ := json.Marshal(map[string]any{"steps": steps, "connectors": connectors})
	return string(b)
}

// expected are the refusals a busy record gives honest callers who race each other.
var expected = []client.ErrorCode{client.ErrorCodeAlreadyClaimed, client.ErrorCodeNotTakeable, client.ErrorCodeNotHolder,
	client.ErrorCodeEnded, client.ErrorCodeTasksOpen}

func soakDuration(t *testing.T) time.Duration {
	if v := os.Getenv("DARKORY_E2E_SOAK"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			t.Fatalf("DARKORY_E2E_SOAK: %v", err)
		}
		return d
	}
	return 2 * time.Minute
}

// soakRun holds what a soak measures and what it found wrong.
type soakRun struct {
	t     *testing.T
	hc    *http.Client
	mu    sync.Mutex
	lat   map[string][]time.Duration
	codes map[string]int // op and refusal code
	// steps are each Project's Steps by id, read once the soak is over.
	steps    map[string]map[string]bool
	problems []string
	requests atomic.Int64
	writes   atomic.Int64
	// What happened, by kind.
	claims, completes, advances, releases, questions, silent, lapsedUnplanned, retries, parents atomic.Int64
	titles                                                                                      sync.Map // title → filer, to find duplicates
	// skillIDs are the soak's Skills' ids by name.
	skillIDs sync.Map
}

func (r *soakRun) problem(format string, a ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.problems) < 200 {
		r.problems = append(r.problems, fmt.Sprintf(format, a...))
	}
}

type response interface{ StatusCode() int }

// do sends one request and classifies its answer: ok when its status is one of okStatus, else
// the refusal's code, which is a problem unless expected. A failure after ctx ended is nobody's
// fault and returns ok false with no code.
func do[R response](ctx context.Context, r *soakRun, op string, write bool, f func() (R, error), okStatus ...int) (R, client.ErrorCode, bool) {
	start := time.Now()
	res, err := f()
	d := time.Since(start)
	r.requests.Add(1)
	if write {
		r.writes.Add(1)
	}
	if err != nil {
		if ctx.Err() == nil {
			r.problem("%s: %v", op, err)
		}
		return res, "", false
	}
	r.mu.Lock()
	r.lat[op] = append(r.lat[op], d)
	r.mu.Unlock()
	status := res.StatusCode()
	if slices.Contains(okStatus, status) {
		return res, "", true
	}
	body := bodyOf(res)
	var e client.Error
	if jsonErr := jsonUnmarshal(body, &e); jsonErr != nil || e.Code == "" {
		r.problem("%s: status %d: %s", op, status, body)
		return res, "", false
	}
	r.mu.Lock()
	r.codes[op+" "+string(e.Code)]++
	r.mu.Unlock()
	if status >= 500 || !slices.Contains(expected, e.Code) {
		r.problem("%s: status %d %s: %s", op, status, e.Code, e.Message)
	}
	return res, e.Code, false
}

// bodyOf is a generated response's raw body.
func bodyOf(res any) []byte {
	v := reflect.ValueOf(res)
	if v.Kind() == reflect.Pointer && v.IsNil() {
		return nil
	}
	return reflect.Indirect(v).FieldByName("Body").Bytes()
}

// dial makes a client acting as one Member in one Session, setting a fresh Idempotency-Key on
// every write that does not name one.
func (r *soakRun) dial(url, token, session string) *client.ClientWithResponses {
	c, err := client.NewClientWithResponses(url, client.WithHTTPClient(r.hc), client.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Darkory-Session", session)
		if req.Method != http.MethodGet && req.Header.Get("Idempotency-Key") == "" {
			req.Header.Set("Idempotency-Key", uuid.Must(uuid.NewV7()).String())
		}
		return nil
	}))
	if err != nil {
		r.t.Fatal(err)
	}
	return c
}

func key() *string { k := uuid.Must(uuid.NewV7()).String(); return &k }

// twice sends a write and, sometimes, sends it again under the same Idempotency-Key — after the
// first answer, or at the same moment — and checks that both answers are the same.
func twice[R response](ctx context.Context, r *soakRun, rng *rand.Rand, op string, f func(k *string) (R, error), okStatus ...int) (R, client.ErrorCode, bool) {
	k := key()
	if rng.Float64() >= 0.1 {
		return do(ctx, r, op, true, func() (R, error) { return f(k) }, okStatus...)
	}
	r.retries.Add(1)
	var res1, res2 R
	var code1 client.ErrorCode
	var ok1, ok2 bool
	if rng.Float64() < 0.5 {
		res1, code1, ok1 = do(ctx, r, op, true, func() (R, error) { return f(k) }, okStatus...)
		res2, _, ok2 = do(ctx, r, op+" (retry)", true, func() (R, error) { return f(k) }, okStatus...)
	} else {
		var wg sync.WaitGroup
		wg.Go(func() { res1, code1, ok1 = do(ctx, r, op, true, func() (R, error) { return f(k) }, okStatus...) })
		wg.Go(func() { res2, _, ok2 = do(ctx, r, op+" (retry)", true, func() (R, error) { return f(k) }, okStatus...) })
		wg.Wait()
	}
	if ok1 && ok2 && (res1.StatusCode() != res2.StatusCode() || !bytes.Equal(bodyOf(res1), bodyOf(res2))) {
		r.problem("%s retried under one key answered differently:\n%s\n%s", op, bodyOf(res1), bodyOf(res2))
	}
	if ok1 != ok2 && ctx.Err() == nil {
		// Under one key, a write that succeeded once must answer every retry with that success.
		r.problem("%s under one key succeeded once and was refused once:\n%s\n%s", op, bodyOf(res1), bodyOf(res2))
	}
	if !ok1 && ok2 {
		return res2, "", true
	}
	return res1, code1, ok1
}

// soak runs the agents against an Install with procs server processes.
func soak(t *testing.T, procs int) {
	in := newInstall(t)
	for range procs - 1 {
		in.serve()
	}
	ada := in.ada
	for _, s := range soakSkills {
		ada.ok("skill", "create", s, "--kind", "generic", "--body", "Do "+s+".")
	}
	in.project("S1", "Soak one", soakFlow())
	in.project("S2", "Soak two", soakFlow())
	// Each agent has two work Skills, so every Skill is held in both Projects, and advancing to
	// another Step always has someone to go to.
	agents := []struct {
		name     string
		projects []string
		skills   []string
	}{
		{"m1", []string{"S1"}, []string{"s-a", "s-b", "breakdown", "retro"}},
		{"m2", []string{"S1", "S2"}, []string{"s-b", "s-c", "breakdown", "retro"}},
		{"m3", []string{"S1"}, []string{"s-c", "s-d", "breakdown"}},
		{"m4", []string{"S1", "S2"}, []string{"s-d", "s-a", "breakdown"}},
	}
	r := &soakRun{t: t, lat: map[string][]time.Duration{}, codes: map[string]int{},
		hc: &http.Client{Transport: &http.Transport{MaxIdleConns: 400, MaxIdleConnsPerHost: 200, IdleConnTimeout: time.Minute}}}
	type session struct {
		member string
		skills []string
		c      *client.ClientWithResponses
	}
	for _, name := range soakSkills {
		var sk client.SkillDetail
		ada.json(&sk, "skill", "show", name)
		r.skillIDs.Store(name, sk.Skill.ID)
	}
	var sessions []session
	for _, a := range agents {
		m := in.agent(a.name, a.projects, a.skills)
		for i := range soakSessionsPerMember {
			url := in.servers[i%len(in.servers)].url
			sessions = append(sessions, session{a.name, a.skills, r.dial(url, m.token, m.prime())})
		}
	}
	type filer struct {
		name, project string
		c             *client.ClientWithResponses
	}
	var filers []filer
	for i, f := range []struct{ name, project string }{{"f1", "S1"}, {"f2", "S2"}} {
		in.ada.ok("member", "create", f.name, "--kind", "human")
		in.ada.ok("project", "add", f.project, f.name)
		var tok client.IssuedToken
		in.ada.json(&tok, "token", "issue", f.name, "--name", f.name)
		filers = append(filers, filer{f.name, f.project, r.dial(in.servers[i%len(in.servers)].url, tok.Secret, uuid.NewString())})
	}

	// Readers follow the stream from the first entry, one per server.
	readCtx, stopReading := context.WithCancel(context.Background())
	defer stopReading()
	var readers []*sseReader
	for _, p := range in.servers {
		rd := &sseReader{url: p.url, token: ada.token, session: uuid.NewString(), hc: r.hc}
		readers = append(readers, rd)
		go rd.run(readCtx, r)
	}

	duration := soakDuration(t)
	start := time.Now()
	ctx, cancel := context.WithTimeout(t.Context(), duration)
	defer cancel()
	var wg sync.WaitGroup
	var filed atomic.Int64
	for i, f := range filers {
		wg.Go(func() {
			r.file(ctx, rand.New(rand.NewPCG(uint64(i), 1)), f.name, f.project, f.c, duration, soakTasks(t)/len(filers), &filed)
		})
	}
	for i, s := range sessions {
		wg.Go(func() { r.agent(ctx, rand.New(rand.NewPCG(uint64(i), 2)), s.skills, s.c) })
	}
	wg.Wait()
	elapsed := time.Since(start)

	// Quiesce: the Claims left behind lapse and the sweeper records them.
	time.Sleep((soakClaimTimeout + 2) * time.Second)
	check := r.dial(in.servers[0].url, ada.token, uuid.NewString())
	bg := context.Background()
	last := latestSeq(t, check)
	for _, rd := range readers {
		select {
		case <-rd.reached(last):
		case <-time.After(30 * time.Second):
			r.problem("the stream from %s reached seq %d of %d", rd.url, rd.last(), last)
		}
	}
	stopReading()

	r.checkActivity(bg, check, last, readers)
	tasks := r.checkTasks(bg, check)
	r.checkTables(in, last)
	r.report(t, procs, elapsed, filed.Load(), len(tasks))
	if n := len(tasks); n < soakTasks(t) {
		t.Errorf("only %d Tasks were filed, want %d or more", n, soakTasks(t))
	}
	if len(r.problems) > 0 {
		t.Errorf("%d problems, the first:\n%s", len(r.problems), strings.Join(r.problems[:min(len(r.problems), 30)], "\n"))
	}
}

// file is a human filing Tasks for the length of the soak: a Task with Break down, then eight
// Subtasks under it at Steps picked at random, then another; a quarter of its share at once, the
// rest spread out, completing its Parents whose Subtasks have all ended.
func (r *soakRun) file(ctx context.Context, rng *rand.Rand, name, project string, c *client.ClientWithResponses, duration time.Duration, share int, filed *atomic.Int64) {
	share += 10
	pace := (duration - 20*time.Second) / time.Duration(share)
	var parent string
	var parents []string
	inParent := 0
	for n := 0; n < share && ctx.Err() == nil; n++ {
		if parent == "" || inParent == 8 {
			title := fmt.Sprintf("%s parent %d", name, n)
			res, _, ok := twice(ctx, r, rng, "file parent", func(k *string) (*client.FileTaskResponse, error) {
				return c.FileTaskWithResponse(ctx, &client.FileTaskParams{IdempotencyKey: k}, client.FileTaskBody{Project: &project, Title: title, Breakdown: ptr(true)})
			}, http.StatusCreated)
			if !ok {
				continue
			}
			r.noteTitle(title, name)
			r.parents.Add(1)
			parent, inParent = res.JSON201.Task.Key, 0
			parents = append(parents, parent)
		}
		title := fmt.Sprintf("%s task %d", name, n)
		step := soakSteps[rng.IntN(len(soakSteps))]
		_, code, ok := twice(ctx, r, rng, "file task", func(k *string) (*client.FileTaskResponse, error) {
			return c.FileTaskWithResponse(ctx, &client.FileTaskParams{IdempotencyKey: k}, client.FileTaskBody{Parent: &parent, Title: title, Step: &step})
		}, http.StatusCreated)
		if ok {
			r.noteTitle(title, name)
			filed.Add(1)
			inParent++
		} else if code == client.ErrorCodeEnded {
			parent = ""
		}
		if n%15 == 14 {
			parents = r.completeEnded(ctx, c, parents, &parent)
		}
		if n >= share/4 {
			select {
			case <-ctx.Done():
			case <-time.After(pace):
			}
		}
	}
	r.completeEnded(ctx, c, parents, &parent)
}

func (r *soakRun) noteTitle(title, by string) {
	if _, dup := r.titles.LoadOrStore(title, by); dup {
		r.problem("%q was filed twice", title)
	}
}

// completeEnded completes the filer's open Parents whose Subtasks have all ended, and returns
// those still open; current, the Parent the filer files under, is cleared when it ends.
func (r *soakRun) completeEnded(ctx context.Context, c *client.ClientWithResponses, parents []string, current *string) []string {
	var open []string
	for _, key := range parents {
		res, _, ok := do(ctx, r, "show parent", false, func() (*client.GetTaskResponse, error) {
			return c.GetTaskWithResponse(ctx, key)
		}, http.StatusOK)
		if !ok {
			open = append(open, key)
			continue
		}
		t := res.JSON200.Task
		if t.State != client.TaskStateOpen {
			continue
		}
		if t.SubtaskCounts == nil || t.SubtaskCounts.Open > 0 {
			open = append(open, key)
			continue
		}
		if key == *current {
			*current = ""
		}
		if _, _, ok := do(ctx, r, "complete parent", true, func() (*client.CompleteTaskResponse, error) {
			return c.CompleteTaskWithResponse(ctx, key, &client.CompleteTaskParams{}, client.CompleteTaskBody{})
		}, http.StatusOK); !ok {
			open = append(open, key)
		}
	}
	return open
}

func ptr[T any](v T) *T { return &v }

// agent is one Session working until ctx ends.
func (r *soakRun) agent(ctx context.Context, rng *rand.Rand, skills []string, c *client.ClientWithResponses) {
	timeout := soakClaimTimeout
	for ctx.Err() == nil {
		var held *client.TaskDetail
		if rng.Float64() < 0.3 {
			list, _, ok := do(ctx, r, "takeable", false, func() (*client.ListTakeableTasksResponse, error) {
				return c.ListTakeableTasksWithResponse(ctx, &client.ListTakeableTasksParams{Limit: ptr(5)})
			}, http.StatusOK)
			if ok && len(list.JSON200.Items) > 0 {
				pick := list.JSON200.Items[rng.IntN(len(list.JSON200.Items))]
				res, _, ok := twice(ctx, r, rng, "claim", func(k *string) (*client.ClaimTaskResponse, error) {
					return c.ClaimTaskWithResponse(ctx, pick.ID, &client.ClaimTaskParams{IdempotencyKey: k}, client.ClaimTaskBody{HeartbeatTimeoutSeconds: &timeout})
				}, http.StatusOK)
				if ok {
					held = res.JSON200
				}
			}
		} else {
			res, _, ok := do(ctx, r, "next", true, func() (*client.NextTaskResponse, error) {
				return c.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptr(0), HeartbeatTimeoutSeconds: &timeout})
			}, http.StatusOK, http.StatusNoContent)
			if ok && res.StatusCode() == http.StatusOK {
				held = res.JSON200
			}
		}
		if held == nil {
			// Nothing to take: wait for something, as an idle agent does.
			res, _, ok := do(ctx, r, "next (waiting)", true, func() (*client.NextTaskResponse, error) {
				return c.NextTaskWithResponse(ctx, &client.NextTaskParams{}, client.NextTaskBody{WaitSeconds: ptr(2), HeartbeatTimeoutSeconds: &timeout})
			}, http.StatusOK, http.StatusNoContent)
			if !ok || res.StatusCode() != http.StatusOK {
				continue
			}
			held = res.JSON200
		}
		r.claims.Add(1)
		r.work(ctx, rng, skills, c, held.Task)
	}
}

// work does something with a Task just claimed.
func (r *soakRun) work(ctx context.Context, rng *rand.Rand, skills []string, c *client.ClientWithResponses, t client.Task) {
	if rng.Float64() < 0.04 {
		r.silent.Add(1) // go silent: the Claim lapses
		return
	}
	// Work a while, heartbeating now and then.
	for range rng.IntN(3) {
		sleep(ctx, time.Duration(100+rng.IntN(700))*time.Millisecond)
		res, _, ok := do(ctx, r, "heartbeat", false, func() (*client.HeartbeatResponse, error) {
			return c.HeartbeatWithResponse(ctx, t.ID, &client.HeartbeatParams{})
		}, http.StatusOK)
		if !ok {
			return
		}
		if res.JSON200.Status != client.HeartbeatStatusOk {
			r.lapsedUnplanned.Add(1)
			return
		}
	}
	sleep(ctx, time.Duration(rng.IntN(300))*time.Millisecond)
	if ctx.Err() != nil {
		return
	}
	if rng.Float64() < 0.2 {
		do(ctx, r, "note", true, func() (*client.AddNoteResponse, error) {
			return c.AddNoteWithResponse(ctx, t.ID, &client.AddNoteParams{}, client.AddNoteBody{Body: "working on it"})
		}, http.StatusCreated)
	}
	if rng.Float64() < 0.1 {
		do(ctx, r, "observe", true, func() (*client.ObserveResponse, error) {
			return c.ObserveWithResponse(ctx, t.ID, &client.ObserveParams{}, client.ObserveBody{Outcome: client.Worked, Body: "fine"})
		}, http.StatusCreated)
	}
	note := func(code client.ErrorCode) {
		if code == client.ErrorCodeNotHolder {
			r.lapsedUnplanned.Add(1)
		}
	}
	x := rng.Float64()
	if t.Kind != client.Work {
		// A Breakdown or a Retrospective has one way out, into Done.
		x = 1
	}
	switch {
	case x < 0.10:
		_, code, ok := twice(ctx, r, rng, "release", func(k *string) (*client.ReleaseTaskResponse, error) {
			return c.ReleaseTaskWithResponse(ctx, t.ID, &client.ReleaseTaskParams{IdempotencyKey: k}, client.ReleaseTaskBody{})
		}, http.StatusOK)
		if ok {
			r.releases.Add(1)
		}
		note(code)
	case x < 0.28:
		// Advance to another work Step, mostly one whose Skill this Session lacks.
		var next string
		for {
			i := rng.IntN(len(soakSteps))
			next = soakSteps[i]
			if (t.SkillID == nil || !slices.Contains(skills, soakSkills[i]) || rng.Float64() < 0.3) && !r.atStep(t, next) {
				break
			}
		}
		outcome := "to-" + strings.ToLower(next)
		_, code, ok := twice(ctx, r, rng, "advance", func(k *string) (*client.AdvanceTaskResponse, error) {
			return c.AdvanceTaskWithResponse(ctx, t.ID, &client.AdvanceTaskParams{IdempotencyKey: k}, client.AdvanceTaskBody{Outcome: &outcome})
		}, http.StatusOK)
		if ok {
			r.advances.Add(1)
		}
		note(code)
	case x < 0.36:
		// A blocking question at some Step, beside the Task under its Parent, then release: the
		// Task waits for the answer.
		step := soakSteps[rng.IntN(len(soakSteps))]
		title := "question " + uuid.NewString()
		_, code, ok := twice(ctx, r, rng, "file question", func(k *string) (*client.FileTaskResponse, error) {
			return c.FileTaskWithResponse(ctx, &client.FileTaskParams{IdempotencyKey: k}, client.FileTaskBody{Title: title, Step: &step, Blocks: &t.ID})
		}, http.StatusCreated)
		note(code)
		if !ok {
			return
		}
		r.noteTitle(title, "question")
		r.questions.Add(1)
		_, code, ok = do(ctx, r, "release", true, func() (*client.ReleaseTaskResponse, error) {
			return c.ReleaseTaskWithResponse(ctx, t.ID, &client.ReleaseTaskParams{}, client.ReleaseTaskBody{Note: ptr("waiting for an answer")})
		}, http.StatusOK)
		if ok {
			r.releases.Add(1)
		}
		note(code)
	default:
		_, code, ok := twice(ctx, r, rng, "complete", func(k *string) (*client.CompleteTaskResponse, error) {
			return c.CompleteTaskWithResponse(ctx, t.ID, &client.CompleteTaskParams{IdempotencyKey: k}, client.CompleteTaskBody{})
		}, http.StatusOK)
		if ok {
			r.completes.Add(1)
		}
		note(code)
	}
}

// atStep says whether t, as claimed, is at the work Step named step.
func (r *soakRun) atStep(t client.Task, step string) bool {
	if t.SkillID == nil {
		return false
	}
	i := slices.Index(soakSteps, step)
	id, _ := r.skillIDs.Load(soakSkills[i])
	return id == *t.SkillID
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// sseReader follows the Activity stream from the first entry, reopening it after the last entry
// seen when it drops, and records every sequence number in the order it arrived.
type sseReader struct {
	url, token, session string
	hc                  *http.Client
	mu                  sync.Mutex
	seqs                []int64
}

func (s *sseReader) last() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.seqs) == 0 {
		return 0
	}
	return s.seqs[len(s.seqs)-1]
}

// reached is closed once the reader has seen seq.
func (s *sseReader) reached(seq int64) <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		for s.last() < seq {
			time.Sleep(20 * time.Millisecond)
		}
		close(ch)
	}()
	return ch
}

func (s *sseReader) run(ctx context.Context, r *soakRun) {
	for ctx.Err() == nil {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url+"/v1/activity/stream?after="+strconv.FormatInt(s.last(), 10), nil)
		if err != nil {
			r.problem("stream: %v", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.token)
		req.Header.Set("Darkory-Session", s.session)
		res, err := s.hc.Do(req)
		if err != nil {
			if ctx.Err() == nil {
				r.problem("stream from %s: %v", s.url, err)
				sleep(ctx, 200*time.Millisecond)
			}
			continue
		}
		if res.StatusCode != http.StatusOK {
			r.problem("stream from %s: status %d", s.url, res.StatusCode)
			res.Body.Close()
			sleep(ctx, 200*time.Millisecond)
			continue
		}
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for sc.Scan() {
			id, ok := strings.CutPrefix(sc.Text(), "id: ")
			if !ok {
				continue
			}
			seq, err := strconv.ParseInt(id, 10, 64)
			if err != nil {
				r.problem("stream: id %q", id)
				continue
			}
			s.mu.Lock()
			s.seqs = append(s.seqs, seq)
			s.mu.Unlock()
		}
		res.Body.Close()
	}
}

func latestSeq(t *testing.T, c *client.ClientWithResponses) int64 {
	t.Helper()
	res, err := c.ListActivityWithResponse(context.Background(), &client.ListActivityParams{Before: ptr(int64(1) << 53), Limit: ptr(1)})
	if err != nil || res.JSON200 == nil {
		t.Fatalf("reading the latest Activity: %v %s", err, bodyOf(res))
	}
	return res.JSON200.LastSeq
}

// checkActivity reads every entry and checks the numbers run 1…last with no gap, that every
// stream saw them all in order, and that no Claim's lapse was recorded twice.
func (r *soakRun) checkActivity(ctx context.Context, c *client.ClientWithResponses, last int64, readers []*sseReader) {
	var after int64
	lapses := map[any]int{}
	for after < last {
		res, err := c.ListActivityWithResponse(ctx, &client.ListActivityParams{After: &after, Limit: ptr(500)})
		if err != nil || res.JSON200 == nil {
			r.problem("reading Activity after %d: %v %s", after, err, bodyOf(res))
			return
		}
		if len(res.JSON200.Items) == 0 {
			r.problem("Activity ends at %d, before %d", after, last)
			return
		}
		for _, en := range res.JSON200.Items {
			if en.Seq != after+1 {
				r.problem("Activity jumps from %d to %d", after, en.Seq)
			}
			after = en.Seq
			if en.Kind == client.ActivityKindTaskLapsed {
				lapses[en.Payload["claim_id"]]++
			}
		}
	}
	for claim, n := range lapses {
		if n > 1 {
			r.problem("the lapse of Claim %v was recorded %d times", claim, n)
		}
	}
	for _, rd := range readers {
		rd.mu.Lock()
		seqs := slices.Clone(rd.seqs)
		rd.mu.Unlock()
		if int64(len(seqs)) != last {
			r.problem("the stream from %s carried %d entries of %d", rd.url, len(seqs), last)
		}
		for i, s := range seqs {
			if s != int64(i)+1 {
				r.problem("the stream from %s carried seq %d at position %d", rd.url, s, i+1)
				break
			}
		}
	}
}

// checkTasks reads every Task with its Claims and checks the Claims against each other and the
// Task's state.
func (r *soakRun) checkTasks(ctx context.Context, c *client.ClientWithResponses) []client.Task {
	var tasks []client.Task
	params := &client.ListTasksParams{Limit: ptr(500)}
	for {
		res, err := c.ListTasksWithResponse(ctx, params)
		if err != nil || res.JSON200 == nil {
			r.t.Fatalf("listing Tasks: %v %s", err, bodyOf(res))
		}
		tasks = append(tasks, res.JSON200.Items...)
		if res.JSON200.NextCursor == nil {
			break
		}
		params.Cursor = res.JSON200.NextCursor
	}
	claims := 0
	for _, tk := range tasks {
		res, err := c.GetTaskWithResponse(ctx, tk.ID)
		if err != nil || res.JSON200 == nil {
			r.t.Fatalf("reading %s: %v %s", tk.Key, err, bodyOf(res))
		}
		d := res.JSON200
		claims += len(d.Claims)
		cs := slices.Clone(d.Claims)
		sort.Slice(cs, func(i, j int) bool { return cs[i].StartedAt.Before(cs[j].StartedAt) })
		skillsOf := map[string]map[string]bool{}
		for i, cl := range cs {
			if cl.EndedAt == nil || cl.HowEnded == nil {
				r.problem("%s: Claim %s by %s has not ended after the soak", tk.Key, cl.ID, cl.HolderID)
			}
			if i > 0 && (cs[i-1].EndedAt == nil || cs[i-1].EndedAt.After(cl.StartedAt)) {
				r.problem("%s: Claim %s (%s–%v) overlaps Claim %s from %s", tk.Key, cs[i-1].ID, cs[i-1].StartedAt, cs[i-1].EndedAt, cl.ID, cl.StartedAt)
			}
			if cl.SkillID != nil {
				if skillsOf[cl.HolderID] == nil {
					skillsOf[cl.HolderID] = map[string]bool{}
				}
				skillsOf[cl.HolderID][*cl.SkillID] = true
			}
		}
		for holder, sk := range skillsOf {
			if len(sk) > 1 {
				r.problem("%s: Member %s held it under %d Skills", tk.Key, holder, len(sk))
			}
		}
		parent := d.Task.SubtaskCounts != nil
		switch d.Task.State {
		case client.TaskStateOpen:
			if d.Task.Claim != nil || d.Task.EndedAt != nil {
				r.problem("%s is open with Claim %+v, ended %v", tk.Key, d.Task.Claim, d.Task.EndedAt)
			}
		case client.TaskStateDone:
			switch {
			case d.Task.Claim != nil || d.Task.EndedAt == nil:
				r.problem("%s is done with Claim %+v, ended %v", tk.Key, d.Task.Claim, d.Task.EndedAt)
			case parent && len(cs) > 0:
				r.problem("%s is a Parent with Claims %+v", tk.Key, cs)
			case !parent && (len(cs) == 0 || cs[len(cs)-1].HowEnded == nil || *cs[len(cs)-1].HowEnded != client.ClaimEndCompleted):
				r.problem("%s is done with Claims %+v", tk.Key, cs)
			}
		default:
			r.problem("%s is %s; nothing in the soak drops a Task", tk.Key, d.Task.State)
		}
		// A Task is at exactly one Step of its own Project's Workflow, or none: none once it has
		// ended or when it is a Parent (or aimed at a Member, which nothing in the soak is).
		steps := r.stepsOf(ctx, c, d.Task.ProjectID)
		switch {
		case d.Task.State != client.TaskStateOpen || parent || d.Task.AimedAtID != nil:
			if d.Task.StepID != nil || d.Step != nil {
				r.problem("%s (%s, Parent %v) is at Step %v", tk.Key, d.Task.State, parent, *d.Task.StepID)
			}
		case d.Task.StepID == nil || d.Step == nil || d.Step.ID != *d.Task.StepID:
			r.problem("%s is open and at no Step: %v, %+v", tk.Key, d.Task.StepID, d.Step)
		case !steps[*d.Task.StepID]:
			r.problem("%s is at Step %s, not one of its Project's", tk.Key, *d.Task.StepID)
		}
		if tk.Kind == client.Work && !strings.HasPrefix(tk.Title, "question ") {
			if _, ok := r.titles.Load(tk.Title); !ok {
				r.problem("%s %q was filed but no filer saw it filed", tk.Key, tk.Title)
			}
		}
	}
	if claims == 0 {
		r.problem("no Claims at all")
	}
	return tasks
}

// stepsOf is the set of a Project's Steps, by id.
func (r *soakRun) stepsOf(ctx context.Context, c *client.ClientWithResponses, project string) map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.steps == nil {
		r.steps = map[string]map[string]bool{}
	}
	if s, ok := r.steps[project]; ok {
		return s
	}
	res, err := c.GetWorkflowWithResponse(ctx, project)
	if err != nil || res.JSON200 == nil {
		r.t.Fatalf("reading the Workflow of %s: %v %s", project, err, bodyOf(res))
	}
	s := map[string]bool{}
	for _, st := range res.JSON200.Steps {
		s[st.ID] = true
	}
	r.steps[project] = s
	return s
}

// checkTables reads the database, read-only, for what the API does not show: every Claim row
// ended, no Task pointing at a Claim, and the counter at the last Activity number.
func (r *soakRun) checkTables(in *install, last int64) {
	driver, dsn := "sqlite", "file:"+in.db+"?mode=ro&_pragma=busy_timeout(5000)"
	if engine() == "postgres" {
		driver, dsn = "pgx", in.db
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		r.t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []struct {
		what  string
		query string
		want  int64
	}{
		{"Claims not ended", `SELECT COUNT(*) FROM claims WHERE ended_at IS NULL`, 0},
		{"Tasks pointing at a Claim", `SELECT COUNT(*) FROM tasks WHERE claim_id IS NOT NULL OR claim_holder_id IS NOT NULL`, 0},
		{"Claims ended before they started", `SELECT COUNT(*) FROM claims WHERE ended_at < started_at`, 0},
		{"ended Tasks at a Step", `SELECT COUNT(*) FROM tasks WHERE state <> 'open' AND step_id IS NOT NULL`, 0},
		{"Parents at a Step", `SELECT COUNT(*) FROM tasks p WHERE p.step_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id)`, 0},
		{"Tasks at another Project's Step", `SELECT COUNT(*) FROM tasks t JOIN steps s ON s.id = t.step_id WHERE s.project_id <> t.project_id`, 0},
		{"open Tasks at no Step", `SELECT COUNT(*) FROM tasks t WHERE t.state = 'open' AND t.step_id IS NULL AND t.aimed_at_id IS NULL
AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)`, 0},
		{"Subtasks of Subtasks", `SELECT COUNT(*) FROM tasks c JOIN tasks p ON p.id = c.parent_id WHERE p.parent_id IS NOT NULL`, 0},
		{"Activity entries", `SELECT COUNT(*) FROM activity`, last},
		{"the counter", `SELECT MAX(seq) FROM organisations`, last},
		{"claims without their task.claimed", `SELECT (SELECT COUNT(*) FROM claims) - (SELECT COUNT(*) FROM activity WHERE kind = 'task.claimed')`, 0},
		{"lapsed Claims without their task.lapsed", `SELECT (SELECT COUNT(*) FROM claims WHERE how_ended = 'lapsed') - (SELECT COUNT(*) FROM activity WHERE kind = 'task.lapsed')`, 0},
	} {
		var n int64
		if err := db.QueryRow(q.query).Scan(&n); err != nil {
			r.t.Fatalf("%s: %v", q.what, err)
		}
		if n != q.want {
			r.problem("%s: %d, want %d", q.what, n, q.want)
		}
	}
}

func (r *soakRun) report(t *testing.T, procs int, elapsed time.Duration, filed int64, tasks int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pct := func(op string, p float64) (time.Duration, int) {
		l := slices.Clone(r.lat[op])
		if len(l) == 0 {
			return 0, 0
		}
		slices.Sort(l)
		return l[min(len(l)-1, int(float64(len(l))*p))], len(l)
	}
	t.Logf("soak on %s with %d server process(es), %s: %d Sessions, %d Tasks (%d filed by humans)",
		engine(), procs, elapsed.Round(time.Second), 4*soakSessionsPerMember, tasks, filed)
	t.Logf("  %d requests, %.0f/s; %d writes, %.0f/s", r.requests.Load(), float64(r.requests.Load())/elapsed.Seconds(),
		r.writes.Load(), float64(r.writes.Load())/elapsed.Seconds())
	t.Logf("  claims %d, completes %d, advances %d, releases %d, questions %d, Parents %d, gone silent %d, lapsed unplanned %d, retried writes %d",
		r.claims.Load(), r.completes.Load(), r.advances.Load(), r.releases.Load(), r.questions.Load(), r.parents.Load(), r.silent.Load(),
		r.lapsedUnplanned.Load(), r.retries.Load())
	for _, op := range []string{"claim", "next", "heartbeat", "complete", "advance", "file task", "complete parent"} {
		p50, n := pct(op, 0.50)
		p99, _ := pct(op, 0.99)
		t.Logf("  %-10s n=%-6d p50 %-8s p99 %s", op, n, p50.Round(10*time.Microsecond), p99.Round(10*time.Microsecond))
	}
	var codes []string
	for k, n := range r.codes {
		codes = append(codes, fmt.Sprintf("%s=%d", k, n))
	}
	sort.Strings(codes)
	t.Logf("  refusals: %s", strings.Join(codes, ", "))
}

func jsonUnmarshal(b []byte, v any) error {
	if len(b) == 0 {
		return errors.New("empty body")
	}
	return json.Unmarshal(b, v)
}
