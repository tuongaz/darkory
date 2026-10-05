package config

import (
	"io"
	"path/filepath"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadServe(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want Serve
	}{
		{"defaults", nil, nil, Serve{Listen: DefaultListen, Store: Store{".", filepath.Join(".", "darkory.db")}, EvidenceMaxMB: 100}},
		{"environment", nil,
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DATA": "/var/lib/darkory", "DARKORY_PUBLIC_URL": "https://dk.example.com",
				"DARKORY_NO_BROWSER": "1", "DARKORY_NO_LOGIN_LINK": "1", "DARKORY_EVIDENCE_MAX_MB": "20"},
			Serve{":8080", Store{"/var/lib/darkory", "/var/lib/darkory/darkory.db"}, "https://dk.example.com", true, true, 20}},
		{"flags win", []string{"--listen", ":9000", "--db", "postgres://x/y", "--no-browser", "--no-login-link", "--evidence-max-mb", "5"},
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DB": "other.db", "DARKORY_EVIDENCE_MAX_MB": "20"},
			Serve{Listen: ":9000", Store: Store{".", "postgres://x/y"}, NoBrowser: true, NoLoginLink: true, EvidenceMaxMB: 5}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := LoadServe(c.args, env(c.env), io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
	if _, err := LoadServe([]string{"extra"}, env(nil), io.Discard); err == nil {
		t.Fatal("accepted a stray argument")
	}
	if _, err := LoadServe([]string{"--evidence-max-mb", "0"}, env(nil), io.Discard); err == nil {
		t.Fatal("accepted an Evidence limit of nothing")
	}
}

func TestLoadInit(t *testing.T) {
	got, err := LoadInit([]string{"--org", "Acme", "--data", "/d"}, env(map[string]string{"USER": "ada"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	want := Init{Store: Store{"/d", "/d/darkory.db"}, Listen: DefaultListen, Org: "Acme", Name: "ada"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestBaseURL(t *testing.T) {
	for _, c := range []struct{ public, listen, want string }{
		{"", "127.0.0.1:7357", "http://127.0.0.1:7357"},
		{"", ":8080", "http://127.0.0.1:8080"},
		{"", "0.0.0.0:80", "http://127.0.0.1:80"},
		{"https://dk.example.com", ":8080", "https://dk.example.com"},
	} {
		if got := BaseURL(c.public, c.listen); got != c.want {
			t.Errorf("BaseURL(%q, %q) = %q, want %q", c.public, c.listen, got, c.want)
		}
	}
}
