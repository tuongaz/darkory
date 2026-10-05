package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Refusals of a release that is not newer or has nothing for this platform.
var (
	ErrUpToDate  = errors.New("already running this release")
	ErrDowngrade = errors.New("refusing to install an older release")
	ErrNoAsset   = errors.New("the release has no archive for this platform")
)

// Limits on what an update downloads and unpacks.
const (
	maxArchive   = 256 << 20
	maxBinary    = 512 << 20
	maxChecksums = 1 << 20
	maxSignature = 4 << 10
)

// Updater replaces a binary with a newer release once the release verifies.
type Updater struct {
	Client *Client
	// PublicKey verifies the signature on checksums.txt.
	PublicKey ed25519.PublicKey
	// Current is the version of the binary being replaced.
	Current string
	// Executable is the path of the binary to replace, with symlinks resolved.
	Executable string
	// GOOS and GOARCH choose the release archive.
	GOOS, GOARCH string
}

// Apply replaces the Executable with rel. It refuses a release that is not newer than Current;
// then it checks the signature on checksums.txt against PublicKey, the archive against its
// checksum, and that the new binary runs and reports rel's version. Nothing is replaced until
// every check passes.
func (u *Updater) Apply(ctx context.Context, rel Release) error {
	if len(u.PublicKey) == 0 {
		return ErrNoKey
	}
	if SameVersion(rel.Version, u.Current) {
		return ErrUpToDate
	}
	if !Newer(rel.Version, u.Current) {
		return fmt.Errorf("%w: %s is older than %s", ErrDowngrade, rel.Version, u.Current)
	}
	name := ArchiveName(rel.Version, u.GOOS, u.GOARCH)
	archiveURL, ok := rel.Assets[name]
	if !ok {
		return fmt.Errorf("%w: %s has no %s (%s/%s)", ErrNoAsset, rel.Version, name, u.GOOS, u.GOARCH)
	}
	checksumsURL, ok := rel.Assets[ChecksumsAsset]
	if !ok {
		return fmt.Errorf("%w: %s has no %s", ErrNoAsset, rel.Version, ChecksumsAsset)
	}
	sigURL, ok := rel.Assets[SignatureAsset]
	if !ok {
		return ErrUnsigned
	}

	checksums, err := u.Client.download(ctx, checksumsURL, maxChecksums)
	if err != nil {
		return err
	}
	sig, err := u.Client.download(ctx, sigURL, maxSignature)
	if err != nil {
		return err
	}
	if err := VerifySignature(u.PublicKey, checksums, sig); err != nil {
		return err
	}
	archive, err := u.Client.download(ctx, archiveURL, maxArchive)
	if err != nil {
		return err
	}
	if err := VerifyChecksum(checksums, name, archive); err != nil {
		return err
	}
	bin, err := extractBinary(name, archive, u.GOOS)
	if err != nil {
		return err
	}

	tmp, err := writeBeside(u.Executable, bin)
	if err != nil {
		return err
	}
	defer os.Remove(tmp) // gone already once the swap succeeds
	if err := checkRuns(ctx, tmp, rel.Version); err != nil {
		return err
	}
	return replace(u.Executable, tmp, runtime.GOOS == "windows")
}

// extractBinary returns the darkory binary inside a release archive: a .tar.gz, or a .zip
// for Windows.
func extractBinary(name string, archive []byte, goos string) ([]byte, error) {
	want := "darkory"
	if goos == "windows" {
		want += ".exe"
	}
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, fmt.Errorf("opening %s: %w", name, err)
		}
		for _, f := range zr.File {
			if path.Base(f.Name) != want || !f.Mode().IsRegular() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, fmt.Errorf("opening %s in %s: %w", want, name, err)
			}
			defer rc.Close()
			return readLimited(rc, maxBinary)
		}
	} else {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return nil, fmt.Errorf("opening %s: %w", name, err)
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("reading %s: %w", name, err)
			}
			if h.Typeflag == tar.TypeReg && path.Base(h.Name) == want {
				return readLimited(tr, maxBinary)
			}
		}
	}
	return nil, fmt.Errorf("%s holds no %s", name, want)
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("the binary is larger than %d bytes", limit)
	}
	return b, nil
}

// writeBeside writes bin to a new file in exe's directory, so that renaming it over exe stays
// on one filesystem, with exe's permissions.
func writeBeside(exe string, bin []byte) (string, error) {
	info, err := os.Stat(exe)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	f, err := os.CreateTemp(dir, ".darkory-update-*"+filepath.Ext(exe))
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return "", fmt.Errorf("cannot write to %s; run the update as a user who can, or reinstall with the install script: %w", dir, err)
		}
		return "", err
	}
	tmp := f.Name()
	_, err = f.Write(bin)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, info.Mode().Perm())
	}
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

// checkRuns runs `bin version` and wants version among the words it prints.
func checkRuns(ctx context.Context, bin, version string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "version")
	cmd.Env = append(os.Environ(), "DARKORY_NO_UPDATE_CHECK=1")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("the new binary does not run here: %w", err)
	}
	for _, f := range strings.Fields(string(out)) {
		if SameVersion(f, version) {
			return nil
		}
	}
	return fmt.Errorf("the new binary reports %q, not %s", strings.TrimSpace(string(out)), version)
}

// replace puts the file at tmp in exe's place. On Unix a rename over the old file is atomic,
// and a running process keeps the old file open. Windows refuses to overwrite a running
// executable but lets it be renamed, so the old one moves aside to exe.old first, and
// RemoveOld deletes it on a later run if it was still running now.
func replace(exe, tmp string, windows bool) error {
	if !windows {
		return os.Rename(tmp, exe)
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	_ = os.Remove(old)
	return nil
}

// RemoveOld deletes the binary an earlier update on Windows moved aside.
func RemoveOld(exe string) {
	_ = os.Remove(exe + ".old")
}
