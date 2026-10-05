package wake

import (
	"testing"
	"time"
)

func TestSignalWakesEveryWaiterOfThatOrganisationOnly(t *testing.T) {
	n := New()
	a1, a2, b := n.Wait("a"), n.Wait("a"), n.Wait("b")
	n.Signal("a")
	for _, ch := range []<-chan struct{}{a1, a2} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("waiter on a was not woken")
		}
	}
	select {
	case <-b:
		t.Fatal("waiter on b was woken by a signal to a")
	default:
	}
	// A wait taken after the signal waits for the next one.
	select {
	case <-n.Wait("a"):
		t.Fatal("a new wait was already woken")
	default:
	}
}
