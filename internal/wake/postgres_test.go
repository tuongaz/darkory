package wake

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// Signals arriving while a NOTIFY is being sent go together in the next one, every Organisation
// signalled is sent after its last Signal, and a send that fails is sent again.
func TestPublisherCoalescesBurstsAndRetries(t *testing.T) {
	defer func(d time.Duration) { retryAfter = d }(retryAfter)
	retryAfter = 10 * time.Millisecond

	var mu sync.Mutex
	var sent [][]string
	release := make(chan struct{})
	failNext := false
	p := newPublisher(func(ctx context.Context, payloads []string) error {
		mu.Lock()
		first := len(sent) == 0
		fail := failNext
		failNext = false
		sent = append(sent, slices.Sorted(slices.Values(payloads)))
		mu.Unlock()
		if first {
			<-release
		}
		if fail {
			return errors.New("connection reset")
		}
		return nil
	}, "me", nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go p.run(ctx)

	p.publish("a")
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(sent) == 1 })
	for range 100 {
		p.publish("a")
		p.publish("b")
	}
	close(release)
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(sent) == 2 })
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if len(sent) != 2 || !slices.Equal(sent[0], []string{"a me"}) || !slices.Equal(sent[1], []string{"a me", "b me"}) {
		t.Fatalf("sent %q, want [a] then [a b]", sent)
	}
	failNext = true
	mu.Unlock()

	p.publish("c")
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(sent) == 4 })
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(sent[2], []string{"c me"}) || !slices.Equal(sent[3], []string{"c me"}) {
		t.Fatalf("a failed send was not repeated: %q", sent[2:])
	}
}

// process is one server process's Notifier, linked over Postgres.
type process struct {
	n  *Notifier
	pg *Postgres
	st *store.Store
}

func startProcess(t *testing.T, dsn string) process {
	t.Helper()
	st, err := store.Open(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	n := New()
	pg, err := ListenPostgres(t.Context(), n, st, dsn, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pg.Close)
	select {
	case <-pg.probed:
	case <-time.After(5 * time.Second):
		t.Fatal("the LISTEN connection never received its own probe")
	}
	return process{n: n, pg: pg, st: st}
}

// A Signal in one process wakes the waiters of that Organisation in another, and no others.
func TestSignalWakesWaitersInOtherProcesses(t *testing.T) {
	dsn := storetest.DSN(t, store.Postgres)
	a, b := startProcess(t, dsn), startProcess(t, dsn)

	onX, onY := a.n.Wait("x"), a.n.Wait("y")
	b.n.Signal("x")
	woken(t, onX, time.Second, "a waiter on x in A, after a Signal in B")
	select {
	case <-onY:
		t.Fatal("a waiter on y was woken by a Signal for x")
	case <-time.After(100 * time.Millisecond):
	}
	// The other way round, and B's own waiters wake in B.
	onXinB, onYinA := b.n.Wait("x"), a.n.Wait("y")
	a.n.Signal("y")
	b.n.Signal("x")
	woken(t, onXinB, time.Second, "a waiter on x in B, after a Signal in B")
	woken(t, onYinA, time.Second, "a waiter on y in A, after a Signal in A")
}

// A LISTEN connection that idles past pingEvery is checked and kept, and still delivers.
func TestIdleListenConnectionKeepsDelivering(t *testing.T) {
	defer func(d time.Duration) { pingEvery = d }(pingEvery)
	pingEvery = 30 * time.Millisecond
	dsn := storetest.DSN(t, store.Postgres)
	a, b := startProcess(t, dsn), startProcess(t, dsn)
	pid := a.pg.pid.Load()
	for range 5 {
		time.Sleep(100 * time.Millisecond) // several timed-out waits and pings
		ch := a.n.Wait("x")
		b.n.Signal("x")
		woken(t, ch, time.Second, "a waiter in A after idle waits")
	}
	if got := a.pg.pid.Load(); got != pid {
		t.Fatalf("the LISTEN connection was replaced (%d, then %d); a timed-out wait should keep it", pid, got)
	}
}

// When the LISTEN connection is killed, every waiter is woken once it is listening again, with
// nobody signalling, and Signals from other processes reach it again.
func TestReconnectWakesEveryWaiter(t *testing.T) {
	dsn := storetest.DSN(t, store.Postgres)
	a, b := startProcess(t, dsn), startProcess(t, dsn)

	onX, onY := a.n.Wait("x"), a.n.Wait("y")
	pid := a.pg.pid.Load()
	terminate(t, b.st, pid)
	woken(t, onX, 5*time.Second, "a waiter on x after the LISTEN connection was killed")
	woken(t, onY, time.Second, "a waiter on y after the LISTEN connection was killed")
	if got := a.pg.pid.Load(); got == 0 || got == pid {
		t.Fatalf("LISTEN pid %d after reconnecting, was %d", got, pid)
	}
	ch := a.n.Wait("x")
	b.n.Signal("x")
	woken(t, ch, time.Second, "a waiter in A after reconnecting, on a Signal in B")
}

func terminate(t *testing.T, st *store.Store, pid uint32) {
	t.Helper()
	var ok bool
	if err := st.QueryRow(t.Context(), `SELECT pg_terminate_backend($1)`, int(pid)).Scan(&ok); err != nil || !ok {
		t.Fatalf("terminate backend %d: %v %v", pid, ok, err)
	}
}

func woken(t *testing.T, ch <-chan struct{}, within time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(within):
		t.Fatalf("%s was not woken within %s", what, within)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
