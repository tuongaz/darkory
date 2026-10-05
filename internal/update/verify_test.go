package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestVerifySignature(t *testing.T) {
	pub, priv := newKey(t)
	_, other := newKey(t)
	sums := []byte("abc  darkory_1.0.0_linux_amd64.tar.gz\n")
	sig := Sign(priv, sums)
	if err := VerifySignature(pub, sums, sig); err != nil {
		t.Errorf("a valid signature: %v", err)
	}
	if err := VerifySignature(pub, sums, []byte(strings.TrimSpace(string(sig))+"\r\n")); err != nil {
		t.Errorf("a valid signature with a CRLF ending: %v", err)
	}
	for name, tc := range map[string]struct{ sums, sig []byte }{
		"another key":         {sums, Sign(other, sums)},
		"changed checksums":   {append([]byte(" "), sums...), sig},
		"empty":               {sums, nil},
		"not base64":          {sums, []byte("!!!")},
		"short":               {sums, []byte(base64.StdEncoding.EncodeToString([]byte("short")))},
		"raw signature bytes": {sums, ed25519.Sign(priv, sums)},
	} {
		if err := VerifySignature(pub, tc.sums, tc.sig); !errors.Is(err, ErrBadSignature) {
			t.Errorf("%s: %v, want ErrBadSignature", name, err)
		}
	}
}

func TestVerifyChecksum(t *testing.T) {
	archive := []byte("archive bytes")
	sum := sha256.Sum256(archive)
	sums := fmt.Appendf(nil, "%x  other.zip\n%X *darkory.tar.gz\n", sha256.Sum256(nil), sum)
	if err := VerifyChecksum(sums, "darkory.tar.gz", archive); err != nil {
		t.Errorf("matching archive: %v", err)
	}
	if err := VerifyChecksum(sums, "darkory.tar.gz", []byte("other bytes")); !errors.Is(err, ErrChecksumMismatch) {
		t.Errorf("changed archive: %v, want ErrChecksumMismatch", err)
	}
	if err := VerifyChecksum(sums, "missing.tar.gz", archive); err == nil {
		t.Error("an archive checksums.txt does not list verified")
	}
}

func TestParseKeys(t *testing.T) {
	pub, priv := newKey(t)
	got, err := ParsePublicKey(base64.StdEncoding.EncodeToString(pub) + "\n")
	if err != nil || !got.Equal(pub) {
		t.Errorf("ParsePublicKey = %v, %v", got, err)
	}
	if _, err := ParsePublicKey(""); !errors.Is(err, ErrNoKey) {
		t.Errorf("ParsePublicKey(\"\"): %v, want ErrNoKey", err)
	}
	if _, err := ParsePublicKey("c2hvcnQ="); err == nil {
		t.Error("ParsePublicKey accepted a short key")
	}
	for _, s := range []string{base64.StdEncoding.EncodeToString(priv.Seed()), base64.StdEncoding.EncodeToString(priv)} {
		k, err := ParsePrivateKey(s)
		if err != nil || !k.Equal(priv) {
			t.Errorf("ParsePrivateKey(%d bytes) = %v", len(s), err)
		}
	}
	if _, err := ParsePrivateKey("c2hvcnQ="); err == nil {
		t.Error("ParsePrivateKey accepted a short key")
	}
}

// TestSourceBuildsCarryNoKey guards against committing a key: release builds inject it.
func TestSourceBuildsCarryNoKey(t *testing.T) {
	if PublicKey != "" {
		t.Errorf("PublicKey = %q in source; release builds set it with -ldflags -X", PublicKey)
	}
}

// TestReleaseConfigMatches checks that .goreleaser.yaml names and builds what this package
// and scripts/install.sh expect, since nothing else ties them together.
func TestReleaseConfigMatches(t *testing.T) {
	b, err := os.ReadFile("../../.goreleaser.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg := string(b)
	for _, want := range []string{
		`name_template: "darkory_{{ .Version }}_{{ .Os }}_{{ .Arch }}"`,
		`name_template: ` + ChecksumsAsset,
		`signature: "${artifact}.sig"`,
		`-X github.com/tuongaz/darkory/internal/version.Version=v{{ .Version }}`,
		`-X github.com/tuongaz/darkory/internal/update.PublicKey=`,
		Image,
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf(".goreleaser.yaml lacks %s", want)
		}
	}
	if got := ArchiveName("v1.2.3", "linux", "amd64"); got != "darkory_1.2.3_linux_amd64.tar.gz" {
		t.Errorf("ArchiveName = %s", got)
	}
	if got := ArchiveName("1.2.3", "windows", "arm64"); got != "darkory_1.2.3_windows_arm64.zip" {
		t.Errorf("ArchiveName = %s", got)
	}

	script, err := os.ReadFile("../../scripts/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`darkory_${version#v}_${os}_${arch}.tar.gz`, ChecksumsAsset} {
		if !strings.Contains(string(script), want) {
			t.Errorf("scripts/install.sh lacks %s", want)
		}
	}
}
