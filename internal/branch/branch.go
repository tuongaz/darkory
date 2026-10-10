// Package branch names the git branches a Task works on (ADR 0015), so the Runner that makes them
// and the server that asks it to merge one name them alike.
package branch

import (
	"regexp"
	"strings"
)

// Parent is the branch a Parent's Subtasks start from and merge into, and that merges into the
// default branch when the Parent completes: its key in lower case, main-7.
func Parent(key string) string { return strings.ToLower(key) }

// Task is the branch a Task works on: its key in lower case, then its title made short and plain,
// main-7-support-emoji. The Runner names it when it makes it, from the title then.
func Task(key, title string) string { return Prefix(key) + Slug(title) }

// Prefix starts the name of every branch of a Task, whatever its title said then: main-7-. No
// Parent's branch starts with it, since a Parent's is its key alone.
func Prefix(key string) string { return strings.ToLower(key) + "-" }

// Slug is title in lower case, with every run of other characters than letters and digits made
// one '-', cut at 40 characters on a word boundary; "task" when nothing is left.
func Slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r)
			dash = false
			continue
		}
		dash = true
	}
	s := b.String()
	if len(s) > 40 {
		s = s[:40]
		if i := strings.LastIndexByte(s, '-'); i > 20 {
			s = s[:i]
		}
		s = strings.TrimRight(s, "-")
	}
	if s == "" {
		return "task"
	}
	return s
}

// keyAtStart is a Task key at the start of a branch's name, in any case.
var keyAtStart = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]*-[0-9]+)(-|$)`)

// KeyOf is the key of the Task a branch belongs to, in upper case: the branch is the key exactly
// (a Parent's, Parent) or starts with the key and a dash (a Task's, Prefix), the key matched in
// any case. Any other branch belongs to no Task: "".
func KeyOf(head string) string {
	if m := keyAtStart.FindStringSubmatch(head); m != nil {
		return strings.ToUpper(m[1])
	}
	return ""
}

// IsTasks says whether head is a branch of Task key's own, not its Parent's: it starts with the
// key and a dash, in any case.
func IsTasks(head, key string) bool {
	return len(head) > len(Prefix(key)) && strings.EqualFold(head[:len(Prefix(key))], Prefix(key))
}
