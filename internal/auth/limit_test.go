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
	for i := range pruneAbove {
		l.Allow(strconv.Itoa(i))
	}
	l.Allow("busy")
	l.Allow("busy")
	// A minute on, the others are full again and "busy" is not.
	c.Advance(time.Minute)
	l.Allow("new")
	if n := len(l.buckets); n != 2 {
		t.Fatalf("holds %d keys, want the two it saw last", n)
	}
	// Forgetting a full bucket changes nothing for its key.
	if !l.Allow("0") || !l.Allow("0") || l.Allow("0") {
		t.Fatal("a forgotten key did not start with a full burst")
	}
}
