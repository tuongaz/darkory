package update

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func exeExt() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// install copies the binary at src into a fresh directory, as the install script would, and
// returns the copy's path.
func install(t *testing.T, src []byte) string {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "darkory"+exeExt())
	if err := os.WriteFile(exe, src, 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func runVersion(t *testing.T, exe string) string {
	t.Helper()
	out, err := exec.Command(exe, "version").Output()
	if err != nil {
		t.Fatalf("running %s version: %v", exe, err)
	}
	return strings.TrimSpace(string(out))
}

// TestApplyReplacesTheExecutable updates a copy of a v1.0.0 binary to a v2.0.0 release served
// like GitHub's, and runs the result.
func TestApplyReplacesTheExecutable(t *testing.T) {
	oldBin, err := os.ReadFile(buildFake(t, "v1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	newBin, err := os.ReadFile(buildFake(t, "v2.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv := newKey(t)
	gh := serveReleases(t,
		newFakeRelease(t, priv, "v1.0.0", runtime.GOOS, runtime.GOARCH, oldBin),
		newFakeRelease(t, priv, "v2.0.0", runtime.GOOS, runtime.GOARCH, newBin),
	)
	exe := install(t, oldBin)
	if got := runVersion(t, exe); got != "v1.0.0" {
		t.Fatalf("before the update the binary says %q", got)
	}

	client := gh.client()
	rel, err := client.Latest(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	u := &Updater{Client: client, PublicKey: pub, Current: "v1.0.0", Executable: exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}
	if err := u.Apply(t.Context(), rel); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	if got := runVersion(t, exe); got != "v2.0.0" {
		t.Fatalf("after the update the binary says %q, want v2.0.0", got)
	}
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Errorf("mode %v, want 0755 kept", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(exe))
	if len(entries) != 1 {
		t.Errorf("the install directory holds %d files after the update, want only the binary", len(entries))
	}
}

// TestApplyRefusesAReleaseThatDoesNotVerify checks that each broken release is refused and
// leaves the installed binary as it was.
func TestApplyRefusesAReleaseThatDoesNotVerify(t *testing.T) {
	pub, priv := newKey(t)
	_, otherKey := newKey(t)
	archive := ArchiveName("v2.0.0", "linux", "amd64")
	cases := []struct {
		name  string
		key   []byte
		spoil func(r *fakeRelease)
		want  error
		text  string
	}{
		{name: "signed by another key", want: ErrBadSignature, spoil: func(r *fakeRelease) {
			r.files[SignatureAsset] = Sign(otherKey, r.files[ChecksumsAsset])
		}},
		{name: "checksums changed after signing", want: ErrBadSignature, spoil: func(r *fakeRelease) {
			r.files[ChecksumsAsset] = append(r.files[ChecksumsAsset], "0000  extra.tar.gz\n"...)
		}},
		{name: "signature not base64", want: ErrBadSignature, spoil: func(r *fakeRelease) {
			r.files[SignatureAsset] = []byte("not a signature")
		}},
		{name: "signature missing", want: ErrUnsigned, spoil: func(r *fakeRelease) {
			delete(r.files, SignatureAsset)
		}},
		{name: "archive does not match its checksum", want: ErrChecksumMismatch, spoil: func(r *fakeRelease) {
			r.files[archive] = makeArchive(t, archive, "linux", []byte("a different binary"))
		}},
		{name: "checksums list no line for the archive", text: "lists no checksum", spoil: func(r *fakeRelease) {
			sums := []byte("0000  darkory_2.0.0_plan9_386.tar.gz\n")
			r.files[ChecksumsAsset] = sums
			r.files[SignatureAsset] = Sign(priv, sums)
		}},
		{name: "no archive for this platform", want: ErrNoAsset, spoil: func(r *fakeRelease) {
			delete(r.files, archive)
		}},
		{name: "checksums missing", want: ErrNoAsset, spoil: func(r *fakeRelease) {
			delete(r.files, ChecksumsAsset)
		}},
		{name: "new binary does not run", text: "does not run here", spoil: func(r *fakeRelease) {}},
		{name: "no key compiled in", key: []byte{}, want: ErrNoKey, spoil: func(r *fakeRelease) {}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rel := newFakeRelease(t, priv, "v2.0.0", "linux", "amd64", []byte("#!/no/such/interpreter\n"))
			tc.spoil(rel)
			gh := serveReleases(t, rel)
			exe := install(t, []byte("the old binary"))
			client := gh.client()
			found, err := client.Latest(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			key := pub
			if tc.key != nil {
				key = tc.key
			}
			u := &Updater{Client: client, PublicKey: key, Current: "v1.0.0", Executable: exe, GOOS: "linux", GOARCH: "amd64"}
			err = u.Apply(t.Context(), found)
			switch {
			case err == nil:
				t.Fatal("Apply succeeded, want a refusal")
			case tc.want != nil && !errors.Is(err, tc.want):
				t.Fatalf("Apply: %v, want %v", err, tc.want)
			case tc.text != "" && !strings.Contains(err.Error(), tc.text):
				t.Fatalf("Apply: %v, want it to mention %q", err, tc.text)
			}
			if b, _ := os.ReadFile(exe); !bytes.Equal(b, []byte("the old binary")) {
				t.Errorf("the installed binary changed to %q", b)
			}
			if entries, _ := os.ReadDir(filepath.Dir(exe)); len(entries) != 1 {
				t.Errorf("the install directory holds %d files, want only the binary", len(entries))
			}
		})
	}
}

func TestApplyRefusesADowngrade(t *testing.T) {
	pub, priv := newKey(t)
	gh := serveReleases(t,
		newFakeRelease(t, priv, "v1.9.0", runtime.GOOS, runtime.GOARCH, []byte("old")),
		newFakeRelease(t, priv, "v2.0.0", runtime.GOOS, runtime.GOARCH, []byte("same")),
	)
	exe := install(t, []byte("the installed binary"))
	client := gh.client()
	u := &Updater{Client: client, PublicKey: pub, Current: "v2.0.0", Executable: exe, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}

	older, err := client.Release(t.Context(), "v1.9.0")
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(t.Context(), older); !errors.Is(err, ErrDowngrade) {
		t.Errorf("Apply(v1.9.0) from v2.0.0: %v, want ErrDowngrade", err)
	}
	same, err := client.Release(t.Context(), "2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Apply(t.Context(), same); !errors.Is(err, ErrUpToDate) {
		t.Errorf("Apply(v2.0.0) from v2.0.0: %v, want ErrUpToDate", err)
	}
	if n := gh.downloads.Load(); n != 0 {
		t.Errorf("%d downloads, want none before refusing", n)
	}
	if b, _ := os.ReadFile(exe); string(b) != "the installed binary" {
		t.Errorf("the installed binary changed to %q", b)
	}
}

func TestExtractBinary(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		name := ArchiveName("v1.0.0", goos, "arm64")
		got, err := extractBinary(name, makeArchive(t, name, goos, []byte("the binary")), goos)
		if err != nil || string(got) != "the binary" {
			t.Errorf("%s: extractBinary = %q, %v", name, got, err)
		}
	}
	// A Windows archive without darkory.exe.
	name := ArchiveName("v1.0.0", "windows", "amd64")
	if _, err := extractBinary(name, makeArchive(t, name, "linux", []byte("x")), "windows"); err == nil {
		t.Error("extractBinary found darkory.exe in an archive without one")
	}
}

func TestReplaceOnWindowsMovesTheOldBinaryAside(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "darkory.exe")
	tmp := filepath.Join(dir, ".darkory-update-1.exe")
	os.WriteFile(exe, []byte("old"), 0o755)
	os.WriteFile(tmp, []byte("new"), 0o755)
	if err := replace(exe, tmp, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new" {
		t.Errorf("binary is %q, want new", b)
	}
	// Here nothing runs the old binary, so it is deleted at once; on Windows it stays as
	// darkory.exe.old until RemoveOld.
	os.WriteFile(exe+".old", []byte("old"), 0o755)
	RemoveOld(exe)
	if _, err := os.Stat(exe + ".old"); !os.IsNotExist(err) {
		t.Errorf("RemoveOld left %s.old", exe)
	}
}

func TestLookup(t *testing.T) {
	_, priv := newKey(t)
	gh := serveReleases(t,
		newFakeRelease(t, priv, "v1.0.0", "linux", "amd64", []byte("1")),
		newFakeRelease(t, priv, "v1.1.0", "linux", "amd64", []byte("2")),
	)
	c := gh.client()
	latest, err := c.Latest(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if latest.Version != "v1.1.0" || latest.URL == "" {
		t.Errorf("Latest = %+v", latest)
	}
	for _, name := range []string{ArchiveName("v1.1.0", "linux", "amd64"), ChecksumsAsset, SignatureAsset} {
		if latest.Assets[name] == "" {
			t.Errorf("Latest has no asset %s", name)
		}
	}
	if rel, err := c.Release(t.Context(), "1.0.0"); err != nil || rel.Version != "v1.0.0" {
		t.Errorf("Release(1.0.0) = %+v, %v", rel, err)
	}
	if _, err := c.Release(t.Context(), "v9.0.0"); !errors.Is(err, ErrNoRelease) {
		t.Errorf("Release(v9.0.0): %v, want ErrNoRelease", err)
	}
}
