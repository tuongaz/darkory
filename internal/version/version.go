// Package version holds the release version of this binary.
package version

// Version is set at build time:
//
//	go build -ldflags "-X github.com/tuongaz/darkory/internal/version.Version=v1.2.3"
var Version = "dev"
