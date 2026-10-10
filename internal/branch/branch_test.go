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

// KeyOf is the one rule for which Task a branch belongs to: <key> exactly, a Parent's, or
// <key>-..., a Task's, the key matched in any case and given in upper case.
func TestKeyOf(t *testing.T) {
	for head, want := range map[string]string{
		"dark-3":      "DARK-3",
		"dark-3-x":    "DARK-3",
		"DARK-3-x":    "DARK-3",
		"dark-30-x":   "DARK-30",
		"dark-3/x":    "",
		"dark-3x":     "",
		"dark-3:x":    "",
		"chore/bump":  "",
		"3-x":         "",
		"web2-12-fix": "WEB2-12",
	} {
		if got := KeyOf(head); got != want {
			t.Errorf("KeyOf(%q) = %q, want %q", head, got, want)
		}
	}
	if KeyOf("dark-30-x") == "DARK-3" {
		t.Error("dark-30-x is DARK-3's")
	}
}

func TestIsTasks(t *testing.T) {
	for head, want := range map[string]bool{"dark-3-x": true, "DARK-3-x": true, "dark-3": false, "dark-3-": false, "dark-30-x": false, "dark-3/x": false} {
		if got := IsTasks(head, "DARK-3"); got != want {
			t.Errorf("IsTasks(%q, DARK-3) = %v, want %v", head, got, want)
		}
	}
}
