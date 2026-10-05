package update

import "testing"

func TestIsDevBuild(t *testing.T) {
	for v, want := range map[string]bool{
		"":                        true,
		"dev":                     true,
		"abc1234":                 true,
		"v1.2.3-dirty":            true,
		"v1.2.3-4-gabc1234":       true,
		"v1.2.3-4-gabc1234-dirty": true,
		"1.2.4-SNAPSHOT-abc1234":  true,
		"v1.2.3":                  false,
		"1.2.3":                   false,
		"v1.3.0-rc.1":             false,
	} {
		if got := IsDevBuild(v); got != want {
			t.Errorf("IsDevBuild(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v1.3.0", "v1.2.9", true},
		{"1.10.0", "v1.9.0", true},
		{"v1.3.0", "v1.3.0-rc.1", true},
		{"v1.2.0", "v1.2.0", false},
		{"v1.2.0", "v1.3.0", false},
		{"v2.0.0", "2.0.0", false},
	}
	for _, tc := range cases {
		if got := Newer(tc.a, tc.b); got != tc.want {
			t.Errorf("Newer(%s, %s) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
