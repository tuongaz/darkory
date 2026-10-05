// Command keygen makes the ed25519 key pair that signs releases. It writes the private key to
// a new file readable only by its owner and prints the public key:
//
//	go run ./tools/keygen -key ~/darkory-release.key
//
// The private key becomes the DARKORY_SIGNING_KEY secret and the public key the
// DARKORY_RELEASE_PUBLIC_KEY variable of the release workflow; docs/build/release.md has the
// steps.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "keygen:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	keyFile := fs.String("key", "", "new file to write the private key to (required; never overwritten)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyFile == "" || fs.NArg() > 0 {
		return errors.New("usage: keygen -key file")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(*keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(f, base64.StdEncoding.EncodeToString(priv.Seed()))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Wrote the private key to %s. Keep it secret: it is DARKORY_SIGNING_KEY.\n", *keyFile)
	fmt.Fprintf(stdout, "DARKORY_RELEASE_PUBLIC_KEY=%s\n", base64.StdEncoding.EncodeToString(pub))
	return nil
}
