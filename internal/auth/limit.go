package auth

import (
	"container/list"
	"sync"
	"time"

	"github.com/tuongaz/darkory/internal/clock"
)

// Limiter is a token bucket per key: each key may make burst requests at once, and gets one more
// every interval up to burst. It lives in one server process.
//
// It holds at most maxKeys keys. A new key in a full Limiter evicts the key used least recently,
// which comes back, if it does, with a full bucket. So a key is never refused for want of room,
// and only someone already using more keys than the cap gains by evicting one; a key being
// refused stays at the front for as long as it keeps trying.
type Limiter struct {
	burst    float64
	interval time.Duration
	clock    clock.Clock
	maxKeys  int

	mu sync.Mutex
	// recent orders the buckets from most to least recently used; byKey finds them.
	recent *list.List
	byKey  map[string]*list.Element
}

type bucket struct {
	key    string
	tokens float64
	at     time.Time
}

// maxKeys bounds the keys a Limiter holds.
const maxKeys = 10000

// NewLimiter returns a Limiter allowing burst requests per key, refilled one per interval.
func NewLimiter(burst int, interval time.Duration, c clock.Clock) *Limiter {
	return &Limiter{burst: float64(burst), interval: interval, clock: c, maxKeys: maxKeys,
		recent: list.New(), byKey: map[string]*list.Element{}}
}

// Allow takes a token from key's bucket, and reports whether there was one.
func (l *Limiter) Allow(key string) bool {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	var b *bucket
	if e, ok := l.byKey[key]; ok {
		l.recent.MoveToFront(e)
		b = e.Value.(*bucket)
	} else {
		if l.recent.Len() >= l.maxKeys {
			oldest := l.recent.Back()
			delete(l.byKey, oldest.Value.(*bucket).key)
			l.recent.Remove(oldest)
		}
		b = &bucket{key: key, tokens: l.burst, at: now}
		l.byKey[key] = l.recent.PushFront(b)
	}
	b.tokens = min(l.burst, b.tokens+float64(now.Sub(b.at))/float64(l.interval))
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Len is how many keys the Limiter holds.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.recent.Len()
}
