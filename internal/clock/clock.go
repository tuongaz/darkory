// Package clock gives the server its idea of now, so tests can move time and watch Claims lapse
// without sleeping (plan invariant 3).
package clock

import (
	"sync"
	"time"
)

// Clock tells the time. Everything that decides whether a Claim has lapsed asks it.
type Clock interface {
	Now() time.Time
}

// Real is the wall clock.
type Real struct{}

// Now returns the current time, to the millisecond the database keeps.
func (Real) Now() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// Fake is a clock that moves only when told to.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

// NewFake returns a Fake clock reading t.
func NewFake(t time.Time) *Fake { return &Fake{now: t.UTC().Truncate(time.Millisecond)} }

// Now returns the Fake clock's time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Advance moves the Fake clock forward by d.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d).Truncate(time.Millisecond)
}
