package remote

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/shortid"
)

// Notice says what became of a Claim the Keeper was keeping alive: it lapsed, was taken back,
// ended some other way, or the Install no longer counts this Session as its holder.
type Notice struct {
	TaskID  string
	TaskKey string
	// Status is lapsed, taken_back or ended; empty when Err says why instead.
	Status client.HeartbeatStatus
	Err    error
}

func (n Notice) String() string {
	name := n.TaskKey
	if name == "" {
		name = n.TaskID
	}
	switch n.Status {
	case client.HeartbeatStatusLapsed:
		return fmt.Sprintf("your Claim on %s lapsed: no Heartbeat arrived in time. It is no longer yours; stop working it, and claim it again if it is still takeable.", name)
	case client.HeartbeatStatusTakenBack:
		return fmt.Sprintf("your Claim on %s was taken back by someone on your Reporting line or the Task's Owner, or the Task was moved to another Step. Stop working it.", name)
	case client.HeartbeatStatusEnded:
		return fmt.Sprintf("your Claim on %s has ended (released, advanced, completed, dropped, split into Subtasks or revoked). Stop working it.", name)
	}
	return fmt.Sprintf("the Heartbeat for %s was refused (%v). Stop working it.", name, n.Err)
}

// Keeper sends Heartbeats for every Claim this Session holds that carries a heartbeat timeout, at
// a third of each timeout (ADR 0005). It finds the Claims by listing the Tasks the Member holds
// and keeping those its Session made, so Claims made by other processes sharing the Session are
// kept too; Track adds one the moment it is made.
type Keeper struct {
	Conn *Conn
	// Every says how often to heartbeat a Claim with the given timeout; nil means a third of it.
	Every func(timeout time.Duration) time.Duration
	// ListEvery is how often to look for this Session's Claims; zero means every 5 s.
	ListEvery time.Duration
	// OnNotice is told when a kept Claim ends: lapsed, taken back, ended, or refused.
	OnNotice func(Notice)
	// OnError is told of a failed request the Keeper will try again.
	OnError func(error)

	mu       sync.Mutex
	claims   map[string]*kept // by Task id
	memberID string
	wake     chan struct{}
	// shortest is the shortest heartbeat timeout this Session's Claims are known to take: its
	// token's default and every Claim kept so far. Zero while none is known.
	shortest time.Duration
}

type kept struct {
	taskID, key, claimID string
	timeout              time.Duration
	next                 time.Time
}

// ErrStopped is returned by Run when the Install no longer accepts the token or Session.
var ErrStopped = errors.New("the Install no longer accepts this token or Session")

// Track starts keeping t's Claim alive, if this Session made it with a heartbeat timeout.
func (k *Keeper) Track(t client.Task) {
	c := t.Claim
	if c == nil || !sameSession(c.SessionID, k.Conn.Settings.Session) || c.HeartbeatTimeoutSeconds == nil || *c.HeartbeatTimeoutSeconds <= 0 {
		return
	}
	k.mu.Lock()
	k.init()
	timeout := time.Duration(*c.HeartbeatTimeoutSeconds) * time.Second
	k.noteTimeout(timeout)
	if h, ok := k.claims[t.ID]; !ok || h.claimID != c.ID {
		k.claims[t.ID] = &kept{taskID: t.ID, key: t.Key, claimID: c.ID, timeout: timeout, next: time.Now().Add(k.every(timeout))}
	}
	k.mu.Unlock()
	k.poke()
}

// Forget stops keeping the Claim on a Task, named by id or display key, as after this Session
// released, handed over or completed it.
func (k *Keeper) Forget(task string) {
	k.mu.Lock()
	k.init()
	for id, h := range k.claims {
		if id == task || h.key == task {
			delete(k.claims, id)
		}
	}
	k.mu.Unlock()
}

// Held lists the keys of the Tasks whose Claims are being kept, sorted.
func (k *Keeper) Held() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	var keys []string
	for _, h := range k.claims {
		keys = append(keys, h.key)
	}
	sort.Strings(keys)
	return keys
}

func (k *Keeper) init() {
	if k.claims == nil {
		k.claims = map[string]*kept{}
	}
	if k.wake == nil {
		k.wake = make(chan struct{}, 1)
	}
}

func (k *Keeper) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *Keeper) every(timeout time.Duration) time.Duration {
	d := timeout / 3
	if k.Every != nil {
		d = k.Every(timeout)
	}
	return max(d, 50*time.Millisecond)
}

// noteTimeout records a heartbeat timeout a Claim of this Session takes. Call with k.mu held.
func (k *Keeper) noteTimeout(d time.Duration) {
	if d > 0 && (k.shortest == 0 || d < k.shortest) {
		k.shortest = d
	}
}

// listEvery is how often to look for Claims made elsewhere in this Session: ListEvery, or more
// often when a Claim may take a shorter timeout, so a Claim made after one list is found and
// heartbeated well before it can lapse.
func (k *Keeper) listEvery() time.Duration {
	d := k.ListEvery
	if d <= 0 {
		d = 5 * time.Second
	}
	k.mu.Lock()
	shortest := k.shortest
	k.mu.Unlock()
	if shortest > 0 {
		d = min(d, k.every(shortest))
	}
	return d
}

// Run keeps Claims alive until ctx ends. It returns ErrStopped when the token is revoked.
func (k *Keeper) Run(ctx context.Context) error {
	k.mu.Lock()
	k.init()
	k.mu.Unlock()
	var nextList time.Time
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		now := time.Now()
		if !now.Before(nextList) {
			if err := k.list(ctx); err != nil {
				if errors.Is(err, ErrStopped) || ctx.Err() != nil {
					return err
				}
				k.report(err)
			}
			nextList = time.Now().Add(k.listEvery())
		}
		for _, h := range k.due(time.Now()) {
			if err := k.beat(ctx, h); err != nil {
				if errors.Is(err, ErrStopped) || ctx.Err() != nil {
					return err
				}
				k.report(err)
			}
		}
		wait := time.Until(k.earliest(nextList))
		timer.Reset(max(wait, 0))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-k.wake:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
}

func (k *Keeper) report(err error) {
	if k.OnError != nil {
		k.OnError(err)
	}
}

// due returns the Claims whose Heartbeat is due by now.
func (k *Keeper) due(now time.Time) []kept {
	k.mu.Lock()
	defer k.mu.Unlock()
	var out []kept
	for _, h := range k.claims {
		if !now.Before(h.next) {
			out = append(out, *h)
		}
	}
	return out
}

func (k *Keeper) earliest(t time.Time) time.Time {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, h := range k.claims {
		if h.next.Before(t) {
			t = h.next
		}
	}
	return t
}

// list adopts this Session's timed Claims and marks every kept Claim no longer listed as due, so
// its next Heartbeat says what became of it.
func (k *Keeper) list(ctx context.Context) error {
	if err := k.member(ctx); err != nil {
		return err
	}
	k.mu.Lock()
	holder := k.memberID
	k.mu.Unlock()
	open := client.TaskStateOpen
	params := &client.ListTasksParams{Holder: &holder, State: &open}
	seen := map[string]bool{}
	var found []client.Task
	for {
		res, err := k.Conn.ListTasksWithResponse(ctx, params)
		if err := k.check(res, err); err != nil {
			return err
		}
		for _, t := range res.JSON200.Items {
			if c := t.Claim; c != nil && sameSession(c.SessionID, k.Conn.Settings.Session) && c.HeartbeatTimeoutSeconds != nil && *c.HeartbeatTimeoutSeconds > 0 {
				found = append(found, t)
				seen[t.ID] = true
			}
		}
		if res.JSON200.NextCursor == nil {
			break
		}
		params.Cursor = res.JSON200.NextCursor
	}
	now := time.Now()
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, t := range found {
		timeout := time.Duration(*t.Claim.HeartbeatTimeoutSeconds) * time.Second
		k.noteTimeout(timeout)
		if h, ok := k.claims[t.ID]; !ok || h.claimID != t.Claim.ID {
			k.claims[t.ID] = &kept{taskID: t.ID, key: t.Key, claimID: t.Claim.ID, timeout: timeout, next: now}
		}
	}
	for id, h := range k.claims {
		if !seen[id] {
			h.next = now
		}
	}
	return nil
}

func (k *Keeper) member(ctx context.Context) error {
	k.mu.Lock()
	known := k.memberID != ""
	k.mu.Unlock()
	if known {
		return nil
	}
	res, err := k.Conn.GetMeWithResponse(ctx)
	if err := k.check(res, err); err != nil {
		return err
	}
	me := res.JSON200
	// The token's default timeout is what `next` and `claim` give a Claim unless told otherwise;
	// knowing it, the first Claim made after a list is found in time.
	if tokenID := me.Session.TokenID; tokenID != nil {
		tokens, err := k.Conn.ListTokensWithResponse(ctx, me.Member.ID)
		if err := k.check(tokens, err); err != nil {
			if errors.Is(err, ErrStopped) {
				return err
			}
			k.report(fmt.Errorf("reading this token's default heartbeat timeout: %w", err))
		} else {
			for _, tk := range tokens.JSON200.Items {
				if tk.ID == *tokenID && tk.DefaultHeartbeatTimeoutSeconds != nil {
					k.mu.Lock()
					k.noteTimeout(time.Duration(*tk.DefaultHeartbeatTimeoutSeconds) * time.Second)
					k.mu.Unlock()
				}
			}
		}
	}
	k.mu.Lock()
	k.memberID = me.Member.ID
	k.mu.Unlock()
	return nil
}

// beat sends one Heartbeat and acts on the reply.
func (k *Keeper) beat(ctx context.Context, h kept) error {
	res, err := k.Conn.HeartbeatWithResponse(ctx, h.taskID, &client.HeartbeatParams{})
	err = k.check(res, err)
	var e *Error
	switch {
	case err == nil && res.JSON200.Status == client.HeartbeatStatusOk:
		k.reschedule(h, k.every(h.timeout))
		return nil
	case err == nil:
		k.end(h, Notice{TaskID: h.taskID, TaskKey: h.key, Status: res.JSON200.Status})
		return nil
	case errors.As(err, &e) && (e.Code == client.ErrorCodeNotHolder || e.Code == client.ErrorCodeNotFound):
		k.end(h, Notice{TaskID: h.taskID, TaskKey: h.key, Err: err})
		return nil
	}
	// Try again soon: a missed Heartbeat is only fatal once the timeout passes.
	k.reschedule(h, min(k.every(h.timeout)/2, time.Second))
	return fmt.Errorf("heartbeat %s: %w", h.key, err)
}

func (k *Keeper) reschedule(h kept, after time.Duration) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if cur, ok := k.claims[h.taskID]; ok && cur.claimID == h.claimID {
		cur.next = time.Now().Add(after)
	}
}

func (k *Keeper) end(h kept, n Notice) {
	k.mu.Lock()
	cur, ok := k.claims[h.taskID]
	if ok && cur.claimID == h.claimID {
		delete(k.claims, h.taskID)
	}
	k.mu.Unlock()
	if ok && cur.claimID == h.claimID && k.OnNotice != nil {
		k.OnNotice(n)
	}
}

// check is Check for a 200, turning a refused credential into ErrStopped.
func (k *Keeper) check(res Response, err error) error {
	err = Check(res, err, http.StatusOK)
	switch CodeOf(err) {
	case client.ErrorCodeUnauthenticated, client.ErrorCodeSessionRequired:
		return fmt.Errorf("%w: %v", ErrStopped, err)
	}
	return err
}

// sameSession reports whether the Session id the API wrote (short, when it is a UUID) names the
// one this copy chose (ADR 0017).
func sameSession(api, chosen string) bool { return shortid.Canonical(api) == shortid.Canonical(chosen) }
