package update

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// PublicKey is the base64 ed25519 public key that release checksums are signed with. Source
// builds carry none and cannot update; release builds set it from DARKORY_RELEASE_PUBLIC_KEY:
//
//	go build -ldflags "-X github.com/tuongaz/darkory/internal/update.PublicKey=<base64>"
//
// docs/build/release.md says how the key pair is made and kept.
var PublicKey = ""

// ErrNoKey is returned when this binary carries no release signing key.
var ErrNoKey = errors.New("this binary was built without a release signing key, so it cannot check a release; reinstall with the install script")

// Refusals of a release that does not verify.
var (
	ErrUnsigned         = errors.New("the release has no " + SignatureAsset)
	ErrBadSignature     = errors.New("the signature on " + ChecksumsAsset + " does not verify")
	ErrChecksumMismatch = errors.New("the archive does not match its checksum")
)

// ParsePublicKey decodes a base64 ed25519 public key.
func ParsePublicKey(s string) (ed25519.PublicKey, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ErrNoKey
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("the release signing key is not a base64 ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// ParsePrivateKey decodes a base64 ed25519 private key: its 32-byte seed, or the 64-byte key.
func ParsePrivateKey(s string) (ed25519.PrivateKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	switch {
	case err != nil:
	case len(b) == ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(b), nil
	case len(b) == ed25519.PrivateKeySize:
		return ed25519.PrivateKey(b), nil
	}
	return nil, errors.New("the signing key is not a base64 ed25519 private key")
}

// Sign returns the signature file for checksums: one line of base64.
func Sign(key ed25519.PrivateKey, checksums []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, checksums)) + "\n")
}

// VerifySignature checks that sig, a signature file as Sign writes it, signs checksums
// exactly as downloaded.
func VerifySignature(key ed25519.PublicKey, checksums, sig []byte) error {
	raw, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(sig)))
	if err != nil || len(raw) != ed25519.SignatureSize || !ed25519.Verify(key, checksums, raw) {
		return ErrBadSignature
	}
	return nil
}

// VerifyChecksum checks archive against the line for name in checksums, which is in the
// `sha256sum` format goreleaser writes.
func VerifyChecksum(checksums []byte, name string, archive []byte) error {
	want, err := checksumOf(checksums, name)
	if err != nil {
		return err
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return ErrChecksumMismatch
	}
	return nil
}

func checksumOf(checksums []byte, name string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(checksums))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%s lists no checksum for %s", ChecksumsAsset, name)
}
