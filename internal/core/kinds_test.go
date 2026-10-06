package core_test

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/core"
)

// activityKind matches a kind written as a literal in the core's source, in Go or in SQL.
var activityKind = regexp.MustCompile(`["'](feature|task|skill|member|team|token|session|login_link|statuses)\.([a-z_]+)["']`)

// Every kind of Activity the core writes is listed in core.ActivityKinds, which the API's
// ActivityKind enum mirrors (internal/server checks that), and its subject type is listed too.
// It reads the source rather than checking at run time, so a kind added elsewhere never panics.
func TestEveryActivityKindIsListed(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	written := map[string]bool{}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") || name == "activity.go" {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range activityKind.FindAllStringSubmatch(string(src), -1) {
			written[m[1]+"."+m[2]] = true
		}
	}
	if len(written) < 30 {
		t.Fatalf("found only %d kinds in the source; the pattern has drifted", len(written))
	}
	for kind := range written {
		if !slices.Contains(core.ActivityKinds, kind) {
			t.Errorf("%s is written but not listed in core.ActivityKinds", kind)
		}
	}
	for _, kind := range core.ActivityKinds {
		if !written[kind] {
			t.Errorf("%s is listed but never written", kind)
		}
		subject, _, _ := strings.Cut(kind, ".")
		if !slices.Contains(core.SubjectTypes, subject) {
			t.Errorf("%s names a subject type that is not listed", kind)
		}
	}
}
