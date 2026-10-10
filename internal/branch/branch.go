// Package branch names the git branches a Task works on (ADR 0015), so the Runner that makes them
// and the server that asks it to merge one name them alike.
package branch

import "strings"

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
