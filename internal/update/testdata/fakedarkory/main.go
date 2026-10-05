// Command fakedarkory stands in for a released darkory binary in the update tests: it prints
// the version it was built with.
package main

import (
	"fmt"
	"os"
)

var version = "v0.0.0"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	os.Exit(2)
}
