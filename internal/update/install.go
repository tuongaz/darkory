package update

import (
	"os"
	"path/filepath"
	"strings"
)

// Install says how this binary was installed, which decides who updates it.
type Install int

// The ways Darkory is installed.
const (
	// Standalone is the install script or a binary from the release page; `darkory update`
	// replaces it.
	Standalone Install = iota
	// Homebrew updates with `brew upgrade`.
	Homebrew
	// Container updates by pulling a newer image.
	Container
)

// Image is the container image releases are published as.
const Image = "ghcr.io/tuongaz/darkory"

// UpdateCommand is what to run to update an install of this kind.
func (k Install) UpdateCommand() string {
	switch k {
	case Homebrew:
		return "brew upgrade darkory"
	case Container:
		return "docker pull " + Image + ":latest, then recreate the container"
	}
	return "darkory update"
}

func (k Install) String() string {
	switch k {
	case Homebrew:
		return "Homebrew"
	case Container:
		return "a container image"
	}
	return "the install script"
}

// DetectInstall says how the binary at exe, with symlinks resolved, was installed. The image
// sets DARKORY_CONTAINER; /.dockerenv and /run/.containerenv catch other containers.
func DetectInstall(exe string, getenv func(string) string, exists func(string) bool) Install {
	p := filepath.ToSlash(exe)
	if strings.Contains(p, "/Cellar/") || strings.Contains(p, "/Caskroom/") {
		return Homebrew
	}
	if getenv("DARKORY_CONTAINER") != "" || exists("/.dockerenv") || exists("/run/.containerenv") {
		return Container
	}
	return Standalone
}

// Executable returns the path of the running binary with symlinks resolved, so that an
// update replaces the file and not a link to it.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// FileExists reports whether a file exists at path; DetectInstall takes it.
func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
