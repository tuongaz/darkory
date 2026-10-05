// Package mail sends email, which emailed sign-in uses to deliver login links (ADR 0008): an SMTP
// sender for Installs that set DARKORY_SMTP_URL, and a fake for tests.
package mail

import (
	"context"
	"sync"
	"time"
)

// Message is a plain-text email to one recipient.
type Message struct {
	To      string
	Subject string
	Text    string
}

// Sender sends email.
type Sender interface {
	Send(ctx context.Context, m Message) error
}

// Fake keeps what it is asked to send instead of sending it.
type Fake struct {
	mu   sync.Mutex
	sent []Message
	ch   chan Message
	// Block, when set, holds every Send until it is closed.
	Block chan struct{}
}

var _ Sender = (*Fake)(nil)

// NewFake returns a Fake with nothing sent.
func NewFake() *Fake { return &Fake{ch: make(chan Message, 1000)} }

// Send records m.
func (f *Fake) Send(ctx context.Context, m Message) error {
	if f.Block != nil {
		select {
		case <-f.Block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	f.sent = append(f.sent, m)
	f.mu.Unlock()
	f.ch <- m
	return nil
}

// Sent returns every message sent so far.
func (f *Fake) Sent() []Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Message(nil), f.sent...)
}

// Next waits up to within for the next message sent, and reports whether one came.
func (f *Fake) Next(within time.Duration) (Message, bool) {
	select {
	case m := <-f.ch:
		return m, true
	case <-time.After(within):
		return Message{}, false
	}
}
