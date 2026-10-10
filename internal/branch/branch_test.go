package branch

import "testing"

func TestNames(t *testing.T) {
	if got := Task("MAIN-7", "Support emoji!"); got != "main-7-support-emoji" {
		t.Errorf("Task: %q", got)
	}
	if got := Parent("MAIN-7"); got != "main-7" {
		t.Errorf("Parent: %q", got)
	}
	if got := Slug("???"); got != "task" {
		t.Errorf("Slug of nothing: %q", got)
	}
}
