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

func TestLimiterForgetsFullBuckets(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	for i := range maxKeys - 1 {
		l.Allow(strconv.Itoa(i))
	}
	l.Allow("busy")
	l.Allow("busy")
	// A minute on, the others are full again and "busy" is not.
	c.Advance(time.Minute)
	if !l.Allow("new") {
		t.Fatal("no room made for a new key")
	}
	if n := len(l.buckets); n != 2 {
		t.Fatalf("holds %d keys, want the two it saw last", n)
	}
	// Forgetting a full bucket changes nothing for its key.
	if !l.Allow("0") || !l.Allow("0") || l.Allow("0") {
		t.Fatal("a forgotten key did not start with a full burst")
	}
}

// A flood of new keys never grows the Limiter past its cap, refuses the keys it has no room for,
// and scans for room at most once every pruneEvery, not on every call.
func TestLimiterHoldsAtMostItsCap(t *testing.T) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	refused := 0
	for i := range 10 * maxKeys {
		if !l.Allow(strconv.Itoa(i)) {
			refused++
		}
	}
	if n := len(l.buckets); n > maxKeys {
		t.Fatalf("holds %d keys, cap %d", n, maxKeys)
	}
	if refused != 9*maxKeys {
		t.Fatalf("refused %d new keys past the cap, want %d", refused, 9*maxKeys)
	}
	if l.prunes != 1 {
		t.Fatalf("scanned %d times for %d keys past the cap in one interval, want once", l.prunes, 9*maxKeys)
	}

	// A second on, it looks again, but nothing has refilled: still no room.
	c.Advance(pruneEvery)
	if l.Allow("late") || len(l.buckets) > maxKeys {
		t.Fatal("a key was let in before any bucket refilled")
	}
	if l.Allow("later") || l.prunes != 2 {
		t.Fatalf("scanned %d times, want 2", l.prunes)
	}

	// Once the buckets have refilled, a scan makes room again.
	c.Advance(time.Minute)
	if !l.Allow("after") {
		t.Fatal("a new key was refused after the buckets refilled")
	}
	if n := len(l.buckets); n != 1 {
		t.Fatalf("holds %d keys after the refill, want 1", n)
	}
}

// Adding a key to a full Limiter costs about as much as checking a known one: no scan per call.
func BenchmarkLimiterFull(b *testing.B) {
	c := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	l := NewLimiter(2, time.Minute, c)
	for i := range maxKeys {
		l.Allow(strconv.Itoa(i))
	}
	keys := make([]string, 1000)
	for i := range keys {
		keys[i] = "new-" + strconv.Itoa(i)
	}
	i := 0
	for b.Loop() {
		l.Allow(keys[i%len(keys)])
		i++
	}
}
