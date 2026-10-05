package auth

import (
	"strconv"
	"testing"
	"time"

	"github.com/tuongaz/darkory/internal/clock"
)

func TestLimiterAllowsABurstThenOneAnInterval(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(3, time.Minute, c)
	for i := range 3 {
		if !l.Allow("a") {
			t.Fatalf("request %d of the burst refused", i+1)
		}
	}
	if l.Allow("a") {
		t.Fatal("a fourth request allowed")
	}
	if !l.Allow("b") {
		t.Fatal("another key was limited")
	}
	c.Advance(59 * time.Second)
	if l.Allow("a") {
		t.Fatal("allowed before the interval")
	}
	c.Advance(time.Second)
	if !l.Allow("a") || l.Allow("a") {
		t.Fatal("want one more after an interval")
	}
	// A long wait refills only up to the burst.
	c.Advance(time.Hour)
	for range 3 {
		if !l.Allow("a") {
			t.Fatal("refused within a refilled burst")
		}
	}
	if l.Allow("a") {
		t.Fatal("refilled past the burst")
	}
}

// A flood of new keys keeps the Limiter at its cap by evicting the keys used least recently; it
// never refuses a key for want of room, and the most recent keys stay.
func TestLimiterEvictsTheLeastRecentlyUsed(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	for i := range 10 * maxKeys {
		if !l.Allow(strconv.Itoa(i)) {
			t.Fatalf("new key %d refused", i)
		}
	}
	if n, m := l.recent.Len(), len(l.byKey); n != maxKeys || m != maxKeys {
		t.Fatalf("holds %d keys (%d in the map), want the cap %d", n, m, maxKeys)
	}
	for _, i := range []int{10*maxKeys - 1, 9 * maxKeys} {
		if _, ok := l.byKey[strconv.Itoa(i)]; !ok {
			t.Fatalf("recent key %d was evicted", i)
		}
	}
	if _, ok := l.byKey[strconv.Itoa(9*maxKeys-1)]; ok {
		t.Fatal("an old key was kept over a newer one")
	}
	// The last one used still has its bucket: one token left of two.
	last := strconv.Itoa(10*maxKeys - 1)
	if !l.Allow(last) || l.Allow(last) {
		t.Fatal("a kept key lost its bucket")
	}
}

// A limited key that keeps trying stays at the front, so a flood of other keys cannot evict it
// and hand it a fresh bucket.
func TestLimiterKeepsAHotLimitedKey(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	l.Allow("hot")
	l.Allow("hot")
	for i := range 10 * maxKeys {
		l.Allow(strconv.Itoa(i))
		if i%(maxKeys/2) == 0 && l.Allow("hot") {
			t.Fatalf("the limited key was let through after %d other keys", i)
		}
	}
	if l.Allow("hot") {
		t.Fatal("the limited key was let through after the flood")
	}
	// Left alone long enough, it is evicted, and comes back with a full bucket.
	for i := range maxKeys {
		l.Allow("later-" + strconv.Itoa(i))
	}
	if _, ok := l.byKey["hot"]; ok {
		t.Fatal("a key left alone through a cap's worth of others was kept")
	}
}

// Adding a key to a full Limiter costs about as much as checking a known one.
func BenchmarkLimiterFull(b *testing.B) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	for i := range maxKeys {
		l.Allow(strconv.Itoa(i))
	}
	i := 0
	for b.Loop() {
		l.Allow("new-" + strconv.Itoa(i))
		i++
	}
}
