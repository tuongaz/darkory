// Package wake tells waiting `next` long-polls and Activity streams that an Organisation's record
// changed. Within one process the wake is direct; with several server processes on one Postgres
// database, ListenPostgres carries it between them with LISTEN/NOTIFY (ADR 0006).
package wake

import "sync"

// Notifier wakes everything waiting on an Organisation when a write to it commits.
type Notifier struct {
	mu    sync.Mutex
	chans map[string]chan struct{}
	// publish, when set, tells the other server processes about a Signal.
	publish func(orgID string)
}

// New returns a Notifier with nobody waiting, which wakes waiters in this process only.
func New() *Notifier {
	return &Notifier{chans: map[string]chan struct{}{}}
}

// Wait returns a channel that is closed at the next Signal for orgID. Take it before reading the
// record, so a change committed between the read and the wait is not missed.
func (n *Notifier) Wait(orgID string) <-chan struct{} {
	n.mu.Lock()
	defer n.mu.Unlock()
	ch, ok := n.chans[orgID]
	if !ok {
		ch = make(chan struct{})
		n.chans[orgID] = ch
	}
	return ch
}

// Signal wakes everyone waiting on orgID, here and, when linked, in the other server processes.
// Call it after the write commits.
func (n *Notifier) Signal(orgID string) {
	n.mu.Lock()
	publish := n.publish
	n.wakeLocked(orgID)
	n.mu.Unlock()
	if publish != nil {
		publish(orgID)
	}
}

// wake wakes the waiters on orgID in this process only, for a Signal another process sent.
func (n *Notifier) wake(orgID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.wakeLocked(orgID)
}

func (n *Notifier) wakeLocked(orgID string) {
	if ch, ok := n.chans[orgID]; ok {
		close(ch)
		delete(n.chans, orgID)
	}
}

// wakeAll wakes every waiter in this process, of every Organisation. Each re-reads the record, so
// a Signal that may have been missed strands nobody.
func (n *Notifier) wakeAll() {
	n.mu.Lock()
	defer n.mu.Unlock()
	for org, ch := range n.chans {
		close(ch)
		delete(n.chans, org)
	}
}

func (n *Notifier) setPublish(fn func(orgID string)) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.publish = fn
}
