package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tuongaz/darkory/internal/update"
)

func TestSign(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	file := filepath.Join(t.TempDir(), "checksums.txt")
	body := []byte("abc  darkory_1.0.0_linux_amd64.tar.gz\n")
	os.WriteFile(file, body, 0o644)
	env := func(signing, public []byte) func(string) string {
		return func(k string) string {
			switch k {
			case "DARKORY_SIGNING_KEY":
				return base64.StdEncoding.EncodeToString(signing)
			case "DARKORY_RELEASE_PUBLIC_KEY":
				return base64.StdEncoding.EncodeToString(public)
			}
			return ""
		}
	}

	if err := run([]string{file}, env(priv.Seed(), pub)); err != nil {
		t.Fatal(err)
	}
	sig, err := os.ReadFile(file + ".sig")
	if err != nil {
		t.Fatal(err)
	}
	if err := update.VerifySignature(pub, body, sig); err != nil {
		t.Errorf("the signature does not verify: %v", err)
	}

	for name, tc := range map[string]struct {
		getenv func(string) string
		want   string
	}{
		"no signing key":     {env(nil, pub), "DARKORY_SIGNING_KEY is not set"},
		"no public key":      {env(priv.Seed(), nil), "DARKORY_RELEASE_PUBLIC_KEY"},
		"another public key": {env(priv.Seed(), otherPub), "not the public half"},
	} {
		if err := run([]string{"-out", file + ".other", file}, tc.getenv); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want an error naming %q", name, err, tc.want)
		}
	}
}
