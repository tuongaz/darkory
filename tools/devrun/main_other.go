//go:build !unix

// Command devrun restarts the server on source changes; it needs process groups, so it runs on
// Unix-like systems only.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "devrun: runs on Unix-like systems only; run `go run ./cmd/darkory serve` instead")
	os.Exit(1)
}
