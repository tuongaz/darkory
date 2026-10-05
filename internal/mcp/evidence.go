package mcp

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// DefaultEvidenceMaxMB matches the server's default limit on one Evidence file
// (`darkory serve --evidence-max-mb`), which /v1 does not report.
const DefaultEvidenceMaxMB = 100

// evidenceRules limit which local files attach_evidence sends. Task text, Notes and proposals
// are written by other Members and reach the model, so a prompt injection there could ask it to
// attach a secret, which every Member could then read.
type evidenceRules struct {
	// root is the evidence root, absolute; real is the same with symlinks resolved.
	root, real  string
	allowHidden bool
	maxBytes    int64
}

func newEvidenceRules(root string, allowHidden bool, maxMB int64) (evidenceRules, error) {
	if root == "" {
		wd, err := os.Getwd()
		if err != nil {
			return evidenceRules{}, err
		}
		root = wd
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return evidenceRules{}, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return evidenceRules{}, fmt.Errorf("the evidence root: %w", err)
	}
	if fi, err := os.Stat(real); err != nil || !fi.IsDir() {
		return evidenceRules{}, fmt.Errorf("the evidence root %s is not a directory", root)
	}
	if maxMB <= 0 {
		maxMB = DefaultEvidenceMaxMB
	}
	return evidenceRules{root: abs, real: real, allowHidden: allowHidden, maxBytes: maxMB << 20}, nil
}

// describe tells the model the limits, for the tool's description.
func (e evidenceRules) describe() string {
	hidden := "nothing hidden (no file or directory whose name starts with a dot, such as .env, .git or .ssh), "
	if e.allowHidden {
		hidden = ""
	}
	return fmt.Sprintf("Only a regular file under the evidence root %s can be attached: no path that leads outside it, through .. or a symlink, "+
		"%sno directories, devices, pipes or sockets, and at most %d MiB. A relative path is taken from the evidence root.",
		e.root, hidden, e.maxBytes>>20)
}

// errRefused marks a file attach_evidence will not send.
var errRefused = errors.New("refused")

func refusef(format string, a ...any) error {
	return fmt.Errorf("%w: %s", errRefused, fmt.Sprintf(format, a...))
}

// read returns the content of the file at path, and its resolved path, when the rules allow it.
func (e evidenceRules) read(path string) (string, []byte, error) {
	if path == "" {
		return "", nil, refusef("no path given")
	}
	p := path
	if !filepath.IsAbs(p) {
		p = filepath.Join(e.root, p)
	}
	p = filepath.Clean(p)
	// The name as given must not be hidden, even when it links to a file that is not.
	for _, base := range []string{e.root, e.real} {
		if rel, ok := within(base, p); ok && !e.allowHidden && hidden(rel) {
			return "", nil, refusef("%s is hidden (a name in it starts with a dot); hidden files are not attached", path)
		}
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", nil, refusef("%s cannot be read: %v", path, err)
	}
	rel, ok := within(e.real, real)
	if !ok {
		return "", nil, refusef("%s is outside the evidence root %s; only files under it can be attached", path, e.root)
	}
	if !e.allowHidden && hidden(rel) {
		return "", nil, refusef("%s leads to a hidden file (a name in it starts with a dot); hidden files are not attached", path)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", nil, refusef("%s cannot be read: %v", path, err)
	}
	if !fi.Mode().IsRegular() {
		return "", nil, refusef("%s is not a regular file (%s)", path, fi.Mode().Type())
	}
	if fi.Size() > e.maxBytes {
		return "", nil, refusef("%s is %d bytes, over the %d MiB limit", path, fi.Size(), e.maxBytes>>20)
	}
	f, err := os.Open(real)
	if err != nil {
		return "", nil, refusef("%s cannot be read: %v", path, err)
	}
	defer f.Close()
	// The file opened must be the one checked, not one swapped in since.
	if now, err := f.Stat(); err != nil || !os.SameFile(fi, now) || !now.Mode().IsRegular() {
		return "", nil, refusef("%s changed while it was being checked", path)
	}
	content, err := io.ReadAll(io.LimitReader(f, e.maxBytes+1))
	if err != nil {
		return "", nil, err
	}
	if int64(len(content)) > e.maxBytes {
		return "", nil, refusef("%s grew over the %d MiB limit", path, e.maxBytes>>20)
	}
	return real, content, nil
}

// within returns p relative to base, when p is base or under it.
func within(base, p string) (string, bool) {
	rel, err := filepath.Rel(base, p)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

// hidden reports whether a relative path has a name starting with a dot.
func hidden(rel string) bool {
	for _, name := range strings.Split(rel, string(filepath.Separator)) {
		if name != "." && strings.HasPrefix(name, ".") {
			return true
		}
	}
	return false
}
