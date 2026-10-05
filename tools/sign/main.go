// Command sign signs a release's checksums.txt with the ed25519 release key, writing the
// one-line base64 signature that `darkory update` checks. goreleaser's sign step runs it:
//
//	go run ./tools/sign -out checksums.txt.sig checksums.txt
//
// It reads the private key from DARKORY_SIGNING_KEY and refuses to sign unless
// DARKORY_RELEASE_PUBLIC_KEY, the key compiled into the release's binaries, is its public half.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/tuongaz/darkory/internal/update"
)

func main() {
	if err := run(os.Args[1:], os.Getenv); err != nil {
		fmt.Fprintln(os.Stderr, "sign:", err)
		os.Exit(1)
	}
}

func run(args []string, getenv func(string) string) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	out := fs.String("out", "", "where to write the signature; default the file's name with .sig added")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: sign [-out file.sig] file")
	}
	file := fs.Arg(0)
	if *out == "" {
		*out = file + ".sig"
	}

	if getenv("DARKORY_SIGNING_KEY") == "" {
		return errors.New("DARKORY_SIGNING_KEY is not set")
	}
	priv, err := update.ParsePrivateKey(getenv("DARKORY_SIGNING_KEY"))
	if err != nil {
		return fmt.Errorf("DARKORY_SIGNING_KEY: %w", err)
	}
	if getenv("DARKORY_RELEASE_PUBLIC_KEY") == "" {
		return errors.New("DARKORY_RELEASE_PUBLIC_KEY is not set, so the binaries would carry no key to verify with")
	}
	pub, err := update.ParsePublicKey(getenv("DARKORY_RELEASE_PUBLIC_KEY"))
	if err != nil {
		return fmt.Errorf("DARKORY_RELEASE_PUBLIC_KEY: %w", err)
	}
	if !pub.Equal(priv.Public()) {
		return errors.New("DARKORY_RELEASE_PUBLIC_KEY is not the public half of DARKORY_SIGNING_KEY, so the binaries could not verify this signature")
	}

	body, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	sig := update.Sign(priv, body)
	if err := update.VerifySignature(pub, body, sig); err != nil {
		return err
	}
	return os.WriteFile(*out, sig, 0o644)
}
