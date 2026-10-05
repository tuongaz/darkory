package update

import (
	"regexp"
	"strings"

	"golang.org/x/mod/semver"
)

// gitDescribe matches the suffix `git describe` adds on a commit after a tag (v1.2.3-4-gabc1234).
var gitDescribe = regexp.MustCompile(`-[0-9]+-g[0-9a-f]{4,}$`)

// IsDevBuild reports whether version is not a release: "dev", anything that is not semver, a
// dirty or untagged `git describe`, or a goreleaser snapshot. Dev builds neither check for
// releases nor update.
func IsDevBuild(version string) bool {
	v := canonical(version)
	return version == "" || version == "dev" || !semver.IsValid(v) ||
		strings.Contains(v, "dirty") || strings.Contains(v, "SNAPSHOT") || gitDescribe.MatchString(v)
}

// Newer reports whether release a is newer than release b. Versions may omit the leading v.
func Newer(a, b string) bool {
	return semver.Compare(canonical(a), canonical(b)) > 0
}

// SameVersion reports whether a and b name the same release.
func SameVersion(a, b string) bool {
	return semver.Compare(canonical(a), canonical(b)) == 0
}

func canonical(v string) string {
	if v != "" && !strings.HasPrefix(v, "v") {
		return "v" + v
	}
	return v
}
