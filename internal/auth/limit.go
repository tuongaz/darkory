package auth

import (
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/clock"
)

// Limiter is a token bucket per key: each key may make burst requests at once, and gets one more
// every interval up to burst. It lives in one server process.
type Limiter struct {
	burst    float64
	interval time.Duration
	clock    clock.Clock

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	at     time.Time
}

// pruneAbove is how many keys a Limiter holds before it forgets those whose buckets are full
// again, which it would treat the same as a key it never saw.
const pruneAbove = 10000

// NewLimiter returns a Limiter allowing burst requests per key, refilled one per interval.
func NewLimiter(burst int, interval time.Duration, c clock.Clock) *Limiter {
	return &Limiter{burst: float64(burst), interval: interval, clock: c, buckets: map[string]*bucket{}}
}

// Allow takes a token from key's bucket, and reports whether there was one.
func (l *Limiter) Allow(key string) bool {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= pruneAbove {
			for k, b := range l.buckets {
				if l.refill(b, now) >= l.burst {
					delete(l.buckets, k)
				}
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

func (l *Limiter) refill(b *bucket, now time.Time) float64 {
	return min(l.burst, b.tokens+float64(now.Sub(b.at))/float64(l.interval))
}
