package remote

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Text from the Install — titles, Notes, names, filenames, Activity payloads — is written by other
// Members, so it may carry terminal escape sequences that rewrite the screen, hide text or set the
// clipboard (OSC 52), or bidi overrides that make text read other than it is. Clean, CleanLine and
// CleanJSON make it safe to print.

// unsafe reports whether r must not reach a terminal as itself: C0 controls, DEL, C1 controls
// (including the 8-bit CSI U+009B), and the bidi embeddings, overrides and isolates.
func unsafe(r rune) bool {
	return r < 0x20 || (r >= 0x7f && r <= 0x9f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069)
}

// clean escapes every unsafe rune, and every byte that is not UTF-8, except the runes keep allows.
func clean(s string, keep func(rune) bool) string {
	i := strings.IndexFunc(s, func(r rune) bool { return r == utf8.RuneError || (unsafe(r) && !keep(r)) })
	if i < 0 {
		return s
	}
	var b strings.Builder
	b.WriteString(s[:i])
	for s = s[i:]; s != ""; {
		r, n := utf8.DecodeRuneInString(s)
		switch {
		case r == utf8.RuneError && n == 1:
			fmt.Fprintf(&b, `\x%02x`, s[0])
		case unsafe(r) && keep(r):
			b.WriteRune(r)
		case unsafe(r) && r < 0x80:
			fmt.Fprintf(&b, `\x%02x`, r)
		case unsafe(r):
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteString(s[:n])
		}
		s = s[n:]
	}
	return b.String()
}

// Clean returns s safe to print in a terminal: controls other than newline and tab, DEL, C1
// controls, bidi overrides and isolates, and bytes that are not UTF-8 are shown escaped, as \x1b
// or \u202e.
func Clean(s string) string {
	return clean(s, func(r rune) bool { return r == '\n' || r == '\t' })
}

// CleanLine is Clean for text printed on one line, such as a title or a name: newlines and tabs
// are escaped too, so the text cannot pass for further lines of output.
func CleanLine(s string) string {
	return clean(s, func(rune) bool { return false })
}

// CleanJSON returns a JSON document with DEL, C1 controls, bidi overrides and isolates, and line
// and paragraph separators written as \u escapes. They can only stand inside strings, and the
// escape means the same character, so the document decodes exactly as before; encoding/json
// already escapes the C0 controls.
func CleanJSON(doc []byte) []byte {
	s := string(doc)
	if !strings.ContainsFunc(s, jsonUnsafe) {
		return doc
	}
	var b strings.Builder
	for _, r := range s {
		if jsonUnsafe(r) {
			fmt.Fprintf(&b, `\u%04x`, r)
			continue
		}
		b.WriteRune(r)
	}
	return []byte(b.String())
}

func jsonUnsafe(r rune) bool {
	return (r >= 0x7f && r <= 0x9f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0x2028 || r == 0x2029
}
