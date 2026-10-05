package update

import "testing"

func TestDetectInstall(t *testing.T) {
	none := func(string) string { return "" }
	nothing := func(string) bool { return false }
	cases := []struct {
		name   string
		exe    string
		getenv func(string) string
		exists func(string) bool
		want   Install
	}{
		{"install script", "/home/ana/.local/bin/darkory", none, nothing, Standalone},
		{"install script under the Homebrew prefix", "/usr/local/bin/darkory", none, nothing, Standalone},
		{"Homebrew cask", "/opt/homebrew/Caskroom/darkory/1.2.0/darkory", none, nothing, Homebrew},
		{"Homebrew formula", "/home/linuxbrew/.linuxbrew/Cellar/darkory/1.2.0/bin/darkory", none, nothing, Homebrew},
		{"our image", "/darkory", func(k string) string {
			if k == "DARKORY_CONTAINER" {
				return "1"
			}
			return ""
		}, nothing, Container},
		{"docker", "/usr/bin/darkory", none, func(p string) bool { return p == "/.dockerenv" }, Container},
		{"podman", "/usr/bin/darkory", none, func(p string) bool { return p == "/run/.containerenv" }, Container},
	}
	for _, tc := range cases {
		if got := DetectInstall(tc.exe, tc.getenv, tc.exists); got != tc.want {
			t.Errorf("%s: DetectInstall(%s) = %v, want %v", tc.name, tc.exe, got, tc.want)
		}
	}
}
