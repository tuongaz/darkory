//go:build !windows

package mcp

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/tuongaz/darkory/client"
	"github.com/tuongaz/darkory/internal/server"
	"github.com/tuongaz/darkory/internal/store"
	"github.com/tuongaz/darkory/internal/store/storetest"
)

// evidenceTree makes an evidence root with a report, a subdirectory, hidden files and links, and
// a secret beside the root.
func evidenceTree(t *testing.T) (root, outside string) {
	t.Helper()
	top := t.TempDir()
	root = filepath.Join(top, "work")
	outside = filepath.Join(top, "secret.key")
	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(outside, "PRIVATE KEY")
	write(filepath.Join(root, "report.txt"), "all green\n")
	write(filepath.Join(root, "logs", "run.log"), "ok\n")
	write(filepath.Join(root, ".env"), "TOKEN=x\n")
	write(filepath.Join(root, ".git", "config"), "[core]\n")
	link := func(target, name string) {
		t.Helper()
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	link(outside, "innocent.txt")
	link(filepath.Join(root, ".env"), "settings.txt")
	link(filepath.Join(root, "report.txt"), ".hidden-link")
	link(filepath.Join(root, "report.txt"), "same.txt")
	return root, outside
}

func TestEvidenceRules(t *testing.T) {
	root, outside := evidenceTree(t)
	rules, err := newEvidenceRules(root, false, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "big.bin"), make([]byte, 1<<20+1), 0o600); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, refusal string
	}{
		{outside, "outside the evidence root"},
		{"../secret.key", "outside the evidence root"},
		{filepath.Join(root, "logs", "..", "..", "secret.key"), "outside the evidence root"},
		{"innocent.txt", "outside the evidence root"},
		{".env", "hidden"},
		{filepath.Join(root, ".git", "config"), "hidden"},
		{"settings.txt", "leads to a hidden file"},
		{".hidden-link", "hidden"},
		{"/dev/zero", "outside the evidence root"},
		{"logs", "not a regular file"},
		{"pipe", "not a regular file"},
		{"big.bin", "over the 1 MiB limit"},
		{"missing.txt", "cannot be read"},
		{"", "no path given"},
	} {
		_, _, err := rules.read(tc.path)
		if !errors.Is(err, errRefused) || !strings.Contains(err.Error(), tc.refusal) {
			t.Errorf("%q: %v, want a refusal saying %q", tc.path, err, tc.refusal)
		}
	}
	for path, want := range map[string]string{
		"report.txt":                           "all green\n",
		filepath.Join(root, "logs", "run.log"): "ok\n",
		"logs/../report.txt":                   "all green\n",
		"same.txt":                             "all green\n",
	} {
		real, content, err := rules.read(path)
		if err != nil || string(content) != want || !strings.HasPrefix(real, rules.real) {
			t.Errorf("%q: %q at %s, %v", path, content, real, err)
		}
	}

	// A device is refused even under the root.
	dev, err := newEvidenceRules("/dev", false, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := dev.read("/dev/zero"); !errors.Is(err, errRefused) || !strings.Contains(err.Error(), "not a regular file") {
		t.Errorf("/dev/zero under /dev: %v", err)
	}
	// Hidden files pass when allowed; what lies outside the root still does not.
	open, err := newEvidenceRules(root, true, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, content, err := open.read(".env"); err != nil || string(content) != "TOKEN=x\n" {
		t.Errorf(".env when allowed: %q, %v", content, err)
	}
	if _, _, err := open.read("innocent.txt"); !errors.Is(err, errRefused) {
		t.Errorf("a link outside when hidden files are allowed: %v", err)
	}
	if !strings.Contains(rules.describe(), "starts with a dot") || strings.Contains(open.describe(), "starts with a dot") ||
		!strings.Contains(rules.describe(), root) || !strings.Contains(rules.describe(), "1 MiB") {
		t.Errorf("descriptions: %q / %q", rules.describe(), open.describe())
	}
	if _, err := newEvidenceRules(filepath.Join(root, "report.txt"), false, 1); err == nil {
		t.Error("a file was taken as the evidence root")
	}
}

// Through the tool: refused files never reach the Install, and the description names the limits.
func TestAttachEvidenceTool(t *testing.T) {
	root, outside := evidenceTree(t)
	f := newFixture(t, storetest.Open(t, store.SQLite), server.Options{})
	_, cs := f.connect("bob-mcp", Options{EvidenceRoot: root})
	tools, err := cs.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tl := range tools.Tools {
		if tl.Name == "attach_evidence" && (!strings.Contains(tl.Description, root) || !strings.Contains(tl.Description, ".env")) {
			t.Errorf("attach_evidence says %q", tl.Description)
		}
	}
	for _, path := range []string{outside, "../secret.key", "innocent.txt", ".env", "/dev/zero"} {
		res := call(t, cs, "attach_evidence", map[string]any{"target": "WEB-3", "path": path})
		if !res.IsError || !strings.HasPrefix(text(res), "refused: ") {
			t.Errorf("%s: %q", path, text(res))
		}
	}
	// A file under the root is sent.
	res := call(t, cs, "attach_evidence", map[string]any{"target": "WEB-3", "path": "report.txt"})
	if res.IsError {
		t.Fatalf("report.txt: %q", text(res))
	}
	var ev client.Evidence
	b, _ := json.Marshal(res.StructuredContent)
	if err := json.Unmarshal(b, &ev); err != nil || ev.Filename != "report.txt" || ev.Size != 10 {
		t.Fatalf("attached %s: %v", b, err)
	}
}

// A path swapped for a link out of the root while attach_evidence checks it never makes it read
// the file outside (security review L2): the file is opened once, inside the root, without
// following a link out, and only what that open found is read. The swap replaces the file itself
// with a link, or a directory on its path with one.
func TestEvidenceSwappedForALinkNeverLeadsOut(t *testing.T) {
	setup := func(t *testing.T) (root, outside string, rules evidenceRules) {
		top := t.TempDir()
		root, outside = filepath.Join(top, "work"), filepath.Join(top, "home-ssh")
		for _, dir := range []string{filepath.Join(root, "d"), outside} {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		for path, content := range map[string]string{
			filepath.Join(root, "d", "notes.txt"): "inside",
			filepath.Join(root, "kept.txt"):       "inside",
			filepath.Join(outside, "notes.txt"):   "OUTSIDE-SECRET",
		} {
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		rules, err := newEvidenceRules(root, false, 1)
		if err != nil {
			t.Fatal(err)
		}
		return root, outside, rules
	}
	// race reads path while swap runs over and over, and fails on reading the outside file.
	race := func(t *testing.T, rules evidenceRules, path string, swap func()) {
		stop, done := make(chan struct{}), make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-stop:
					return
				default:
					swap()
				}
			}
		}()
		defer func() { close(stop); <-done }()
		inside, refused := 0, 0
		for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
			_, content, err := rules.read(path)
			switch {
			case string(content) == "OUTSIDE-SECRET":
				t.Fatalf("read the file outside the root after %d reads inside and %d refused", inside, refused)
			case err == nil:
				inside++
			default:
				refused++
			}
		}
		t.Logf("%d reads inside, %d refused", inside, refused)
	}
	t.Run("file", func(t *testing.T) {
		root, outside, rules := setup(t)
		target := filepath.Join(root, "notes.txt")
		link, file := filepath.Join(root, "link.tmp"), filepath.Join(root, "file.tmp")
		race(t, rules, "notes.txt", func() {
			_ = os.Symlink(filepath.Join(outside, "notes.txt"), link)
			_ = os.Rename(link, target)
			_ = os.Link(filepath.Join(root, "kept.txt"), file)
			_ = os.Rename(file, target)
		})
	})
	t.Run("directory", func(t *testing.T) {
		root, outside, rules := setup(t)
		d, saved := filepath.Join(root, "d"), filepath.Join(root, "d-saved")
		race(t, rules, "d/notes.txt", func() {
			if os.Rename(d, saved) == nil {
				_ = os.Symlink(outside, d)
				_ = os.Remove(d)
				_ = os.Rename(saved, d)
			}
		})
	})
}
