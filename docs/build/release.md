# Releasing Darkory

A release is a `v*` tag. [`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs goreleaser on it with [`.goreleaser.yaml`](../../.goreleaser.yaml), which builds and publishes everything [ADR 0007](../adr/0007-go-core-react-web-single-binary.md) promises: binaries for macOS, Linux and Windows on amd64 and arm64, the container image and the Homebrew cask. [ADR 0009](../adr/0009-agpl-core-closed-cloud-operations.md) says how installs update.

## What a release holds

| Asset | What it is |
|---|---|
| `darkory_1.2.3_<os>_<arch>.tar.gz`, `.zip` on Windows | the binary (`darkory` or `darkory.exe`) and `LICENSE`, at the top level |
| `checksums.txt` | SHA-256 of every archive, in `sha256sum` format |
| `checksums.txt.sig` | one line of base64: the ed25519 signature over `checksums.txt` exactly as published |
| `ghcr.io/tuongaz/darkory:v1.2.3`, `:latest` | the container image, for `linux/amd64` and `linux/arm64` (`latest` skips prereleases) |
| `Casks/darkory.rb` in `tuongaz/homebrew-tap` | the Homebrew cask |

The binaries report `v1.2.3` from `darkory version`: the tag, with its `v`. `internal/update` and `scripts/install.sh` depend on these names; `TestReleaseConfigMatches` fails when `.goreleaser.yaml` drifts from them.

## The signing key

Every release binary carries the release public key, and `darkory update` installs nothing whose `checksums.txt` that key did not sign. The key is never committed: source builds carry none (`internal/update.PublicKey` is empty) and refuse to update, and goreleaser sets it from `DARKORY_RELEASE_PUBLIC_KEY` with `-ldflags -X`. The private key exists only in the `DARKORY_SIGNING_KEY` secret and wherever its owner keeps the backup.

Make the pair once, on a machine you trust:

```sh
go run ./tools/keygen -key ~/darkory-release.key
# Wrote the private key to /Users/you/darkory-release.key. Keep it secret: it is DARKORY_SIGNING_KEY.
# DARKORY_RELEASE_PUBLIC_KEY=Base64PublicKey…
```

Then, in the `tuongaz/darkory` repository settings (or with `gh`):

```sh
gh secret set DARKORY_SIGNING_KEY < ~/darkory-release.key
gh variable set DARKORY_RELEASE_PUBLIC_KEY --body 'Base64PublicKey…'
```

Back the private key up offline (a password manager is fine) and delete the file. `tools/sign`, which goreleaser's sign step runs, refuses to sign unless `DARKORY_RELEASE_PUBLIC_KEY` is the public half of `DARKORY_SIGNING_KEY`, so a release can never ship a key that does not verify it. With either one unset the release stops at the sign step, before anything is published.

**Losing or changing the key.** Binaries trust exactly one key. Releases signed by a new key fail `darkory update` on every binary built with the old one; their users reinstall once with the install script and update normally from then on. Say so in the release notes of the first release under a new key. If the private key leaks, make a new pair and release at once: the leaked key could sign a release that older binaries accept, so tell users to reinstall with the install script.

## Repository settings the workflow needs

| Name | Kind | Purpose |
|---|---|---|
| `DARKORY_SIGNING_KEY` | secret | signs `checksums.txt` |
| `DARKORY_RELEASE_PUBLIC_KEY` | variable | compiled into the binaries |
| `HOMEBREW_TAP_GITHUB_TOKEN` | secret | a fine-grained token with contents read/write on `tuongaz/homebrew-tap`; without it the cask is written to `dist/` and not pushed |
| `GITHUB_TOKEN` | built in | creates the GitHub release and pushes the image to `ghcr.io` (the workflow asks for `contents: write` and `packages: write`) |

The tap repository `tuongaz/homebrew-tap` must exist (an empty repository is enough; goreleaser creates `Casks/`). After the first release, make the `ghcr.io/tuongaz/darkory` package public in its package settings, or `docker pull` needs a login.

## Cutting a release

1. On `main`, with `make check` green and the web app building (`make web`, when the Makefile has it; goreleaser's before-hook runs it and otherwise embeds `web/dist` as committed).
2. Tag and push:

   ```sh
   git tag -a v0.1.0 -m "Darkory v0.1.0"
   git push origin v0.1.0
   ```

3. Watch the `release` workflow. It publishes the GitHub release with the archives, `checksums.txt` and `checksums.txt.sig`, pushes the image, and pushes the cask. A tag with a prerelease part (`v0.2.0-rc.1`) makes a GitHub prerelease, which `darkory update`, the install script's default and the `latest` image all skip.

To release from a laptop instead, export the four variables above and run `goreleaser release --clean`.

## Trying it without publishing

```sh
go install github.com/goreleaser/goreleaser/v2@latest
goreleaser check
goreleaser release --snapshot --clean --skip=publish,sign   # dist/, plus images tagged -amd64/-arm64 in the local daemon
```

Snapshot binaries report `v0.0.0-SNAPSHOT-<commit>`, a dev build, so they never check for or install updates. To rehearse a signed release end to end, use a throwaway key and a version that has no tag; nothing is pushed:

```sh
go run ./tools/keygen -key /tmp/throwaway.key        # prints DARKORY_RELEASE_PUBLIC_KEY=…
GORELEASER_CURRENT_TAG=v0.2.0 DARKORY_SIGNING_KEY="$(cat /tmp/throwaway.key)" DARKORY_RELEASE_PUBLIC_KEY=… \
  goreleaser release --clean --skip=publish,validate,docker,homebrew,announce
```

Serve `dist/` like GitHub's releases API and point a binary at it with `DARKORY_UPDATE_URL`, and the install script with `DARKORY_DOWNLOAD_URL`.

The image also builds from source without goreleaser:

```sh
docker build --build-arg VERSION=$(git describe --tags --always) -t darkory .
docker run --rm darkory version
docker run -p 7357:7357 -v darkory-data:/data darkory
```

## How each install updates

- **Install script** (`scripts/install.sh`): `curl -fsSL https://raw.githubusercontent.com/tuongaz/darkory/main/scripts/install.sh | sh`. It installs to `/usr/local/bin` when writable, otherwise `~/.local/bin`, and takes `DARKORY_VERSION` and `DARKORY_INSTALL_DIR`. It checks the archive's SHA-256 against `checksums.txt`, which catches a damaged download but not a substituted release; it does not check the signature. Those users then run `darkory update`, which checks the signature and the checksum, runs the new binary's `version`, and only then renames it over the old one (on Windows the old binary moves aside to `darkory.exe.old`). It refuses older releases and dev builds; `--check` only reports; `--version v1.2.3` picks a release.
- **Homebrew**: `brew install tuongaz/tap/darkory`, then `brew upgrade darkory`. `darkory update` sees the `Caskroom`/`Cellar` path and prints that command instead.
- **Container**: `docker pull ghcr.io/tuongaz/darkory:latest` and recreate the container. The image sets `DARKORY_CONTAINER=1`, so `darkory update` prints that instead.

The update notice (`update.PrintNotice` for the CLI, `update.NewChecker(…).Check` for the server) asks GitHub at most once a day, remembers the answer in the user cache directory (`darkory/update-check.json`), waits at most a second, and is off for dev builds, with `DARKORY_NO_UPDATE_CHECK=1`, or when the caller passes `noCheck` (meant for a CLI `--no-update-check` flag).
