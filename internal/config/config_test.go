package config

import (
	"io"
	"path/filepath"
	"testing"
)

func TestLoadServe(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want Serve
	}{
		{"defaults", nil, nil, Serve{DefaultListen, ".", filepath.Join(".", "darkory.db")}},
		{"environment", nil,
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DATA": "/var/lib/darkory"},
			Serve{":8080", "/var/lib/darkory", "/var/lib/darkory/darkory.db"}},
		{"flags win", []string{"--listen", ":9000", "--db", "postgres://x/y"},
			map[string]string{"DARKORY_LISTEN": ":8080", "DARKORY_DB": "other.db"},
			Serve{":9000", ".", "postgres://x/y"}},
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
}
