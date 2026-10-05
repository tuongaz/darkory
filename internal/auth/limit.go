package auth

import (
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/clock"
)

// Limiter is a token bucket per key: each key may make burst requests at once, and gets one more
// every interval up to burst. It lives in one server process.
//
// It holds at most maxKeys keys. When it is full, a new key makes it forget the keys whose
// buckets have refilled, which it would treat the same as keys it never saw. It looks for them at
// most once every pruneEvery, so a flood of new keys costs one scan per period, not one per
// request. A new key that finds no room is refused: the Limiter fails closed rather than growing.
type Limiter struct {
	burst    float64
	interval time.Duration
	clock    clock.Clock
	maxKeys  int

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastPrune time.Time
	// prunes counts the scans, for tests.
	prunes int
}

type bucket struct {
	tokens float64
	at     time.Time
}

const (
	// maxKeys bounds the keys a Limiter holds.
	maxKeys = 10000
	// pruneEvery is the least time between two scans for refilled buckets.
	pruneEvery = time.Second
)

// NewLimiter returns a Limiter allowing burst requests per key, refilled one per interval.
func NewLimiter(burst int, interval time.Duration, c clock.Clock) *Limiter {
	return &Limiter{burst: float64(burst), interval: interval, clock: c, maxKeys: maxKeys, buckets: map[string]*bucket{}}
}

// Allow takes a token from key's bucket, and reports whether there was one. A key the Limiter
// has no room for is refused.
func (l *Limiter) Allow(key string) bool {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.maxKeys {
			l.prune(now)
			if len(l.buckets) >= l.maxKeys {
				return false
			}
		}
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[key] = b
	}
	b.tokens, b.at = l.refill(b, now), now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// prune forgets the keys whose buckets are full again, unless it last looked within pruneEvery.
func (l *Limiter) prune(now time.Time) {
	if !l.lastPrune.IsZero() && now.Sub(l.lastPrune) < pruneEvery {
		return
	}
	l.lastPrune = now
	l.prunes++
	for k, b := range l.buckets {
		if l.refill(b, now) >= l.burst {
			delete(l.buckets, k)
		}
	}
}

func (l *Limiter) refill(b *bucket, now time.Time) float64 {
	return min(l.burst, b.tokens+float64(now.Sub(b.at))/float64(l.interval))
}
