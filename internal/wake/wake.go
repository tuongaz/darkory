// Package wake tells waiting `next` long-polls and Activity streams that an Organisation's record
// changed. On Local the wake is in-process; Postgres LISTEN/NOTIFY across processes comes later
// (ADR 0006).
package wake

import "sync"

// Notifier wakes everything waiting on an Organisation when a write to it commits.
type Notifier struct {
	mu    sync.Mutex
	chans map[string]chan struct{}
}

// New returns a Notifier with nobody waiting.
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

// Signal wakes everyone waiting on orgID. Call it after the write commits.
func (n *Notifier) Signal(orgID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if ch, ok := n.chans[orgID]; ok {
		close(ch)
		delete(n.chans, orgID)
	}
}
