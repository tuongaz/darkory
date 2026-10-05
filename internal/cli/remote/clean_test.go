package remote

import (
	"encoding/json"
	"strings"
	"testing"
)

// hostile holds what a terminal could act on: OSC 52 (set the clipboard) ended by BEL, CSI clear
// screen, a carriage return, DEL, the 8-bit CSI U+009B, other C1 controls, bidi overrides and
// isolates, and a byte that is not UTF-8.
const hostile = "ok\x1b]52;c;ZXZpbA==\x07\x1b[2J\rfake\x7f\u009b31m\u0085\u202eevil\u2066x\u2069\xff"

// actable reports the first byte sequence in s a terminal could act on, or "".
func actable(s string) string {
	for i, r := range s {
		if (r < 0x20 && r != '\n' && r != '\t') || (r >= 0x7f && r <= 0x9f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return s[i:min(i+4, len(s))]
		}
	}
	for i := 0; i < len(s); i++ {
		if s[i] == 0xff {
			return s[i : i+1]
		}
	}
	return ""
}

func TestClean(t *testing.T) {
	got := Clean(hostile + "\nline two\tcolumn")
	if a := actable(got); a != "" {
		t.Fatalf("Clean left %q in %q", a, got)
	}
	want := "ok\\x1b]52;c;ZXZpbA==\\x07\\x1b[2J\\x0dfake\\x7f\\u009b31m\\u0085\\u202eevil\\u2066x\\u2069\\xff" + "\nline two\tcolumn"
	if got != want {
		t.Fatalf("Clean gave\n%q\nwant\n%q", got, want)
	}
	if line := CleanLine("title\nInjected: line\ttab"); line != `title\x0aInjected: line\x09tab` {
		t.Fatalf("CleanLine gave %q", line)
	}
	for _, s := range []string{"", "plain", "naïve 日本語 ✓", "\ufffd"} {
		if Clean(s) != s || CleanLine(s) != s {
			t.Errorf("%q was changed", s)
		}
	}
}

// CleanJSON leaves nothing a terminal could act on, and the document decodes exactly as before.
func TestCleanJSON(t *testing.T) {
	in := strings.ToValidUTF8(hostile, "\ufffd") + "\u2028\u2029"
	doc, err := json.Marshal(map[string]string{"title": in})
	if err != nil {
		t.Fatal(err)
	}
	out := CleanJSON(doc)
	if a := actable(string(out)); a != "" || strings.ContainsAny(string(out), "\u2028\u2029") {
		t.Fatalf("CleanJSON left %q in %s", a, out)
	}
	var back map[string]string
	if err := json.Unmarshal(out, &back); err != nil || back["title"] != in {
		t.Fatalf("decoded %q, %v; want %q", back["title"], err, in)
	}
	if plain := []byte(`{"a":"b"}`); &CleanJSON(plain)[0] != &plain[0] {
		t.Error("a clean document was copied")
	}
}
