#!/bin/sh
# Installs the darkory binary from a GitHub release (ADR 0007), on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/tuongaz/darkory/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/tuongaz/darkory/main/scripts/install.sh | DARKORY_VERSION=v1.2.3 sh
#
# Settings, read from the environment:
#   DARKORY_VERSION       the release to install, such as v1.2.3; default the latest
#   DARKORY_INSTALL_DIR   where to put the binary; default /usr/local/bin when it is writable,
#                         otherwise ~/.local/bin
#   DARKORY_DOWNLOAD_URL  where releases are downloaded from; default
#                         https://github.com/tuongaz/darkory/releases (for mirrors and tests)
#
# What this checks, and what it does not. The archive's SHA-256 must match checksums.txt from
# the same release, which catches a corrupt or truncated download. It cannot show that the
# release is genuine: checksums.txt comes from the same place as the archive, so whoever could
# replace one could replace both. That rests on HTTPS to github.com. The release also carries
# checksums.txt.sig, an ed25519 signature over checksums.txt, which this script does not check:
# that needs the release public key and an ed25519 tool it cannot count on. `darkory update`
# checks that signature, with the key compiled into the binary, before every later update.
#
# On Windows, download the .zip for your machine from the releases page.
set -eu

releases="${DARKORY_DOWNLOAD_URL:-https://github.com/tuongaz/darkory/releases}"

say() { printf '%s\n' "$*" >&2; }
die() {
	say "darkory install: $*"
	exit 1
}

fetch() { # url file
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die "needs curl or wget to download"
	fi
}

sha256() { # file
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "needs sha256sum or shasum to check the download"
	fi
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
MINGW* | MSYS* | CYGWIN*) die "on Windows, download the .zip from $releases" ;;
*) die "there is no release for $(uname -s)" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) die "there is no release for $(uname -m)" ;;
esac
# A shell running under Rosetta on an Apple silicon Mac reports x86_64; take the native binary.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
	arch=arm64
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t darkory)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

version="${DARKORY_VERSION:-}"
if [ -n "$version" ]; then
	case "$version" in v*) ;; *) version="v$version" ;; esac
	from="$releases/download/$version"
else
	from="$releases/latest/download"
fi
fetch "$from/checksums.txt" "$tmp/checksums.txt" || die "cannot download checksums.txt from $from"
if [ -z "$version" ]; then
	# The latest release's version, read from the name of its archive for this platform.
	version=$(awk -v suffix="_${os}_${arch}.tar.gz" '
		{ n = $2; sub(/^\*/, "", n) }
		n ~ /^darkory_/ && length(n) > length(suffix) && substr(n, length(n) - length(suffix) + 1) == suffix {
			print "v" substr(n, 9, length(n) - 8 - length(suffix)); exit
		}' "$tmp/checksums.txt")
	[ -n "$version" ] || die "the latest release has no archive for $os/$arch"
fi

archive="darkory_${version#v}_${os}_${arch}.tar.gz"
want=$(awk -v n="$archive" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/checksums.txt")
[ -n "$want" ] || die "release $version has no $archive"
say "Downloading darkory $version for $os/$arch"
fetch "$from/$archive" "$tmp/$archive" || die "cannot download $from/$archive"
got=$(sha256 "$tmp/$archive")
[ "$got" = "$want" ] || die "$archive does not match its checksum in checksums.txt (got $got); the download is damaged, so try again"
tar -xzf "$tmp/$archive" -C "$tmp" darkory || die "$archive holds no darkory binary"

dir="${DARKORY_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
	if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
		dir=/usr/local/bin
	else
		dir="$HOME/.local/bin"
	fi
fi
mkdir -p "$dir" || die "cannot create $dir"
[ -w "$dir" ] || die "cannot write to $dir; set DARKORY_INSTALL_DIR to a directory you can write"
if [ -L "$dir/darkory" ]; then
	die "$dir/darkory is a link, perhaps to a Homebrew install; update that with brew upgrade darkory, or set DARKORY_INSTALL_DIR"
fi
# Copy beside the old binary and rename over it, so a running darkory is never half-written.
cp "$tmp/darkory" "$dir/.darkory.new.$$"
chmod 755 "$dir/.darkory.new.$$"
mv -f "$dir/.darkory.new.$$" "$dir/darkory"

say "Installed $("$dir/darkory" version) at $dir/darkory"
case ":$PATH:" in
*":$dir:"*) ;;
*) say "$dir is not on your PATH; add it with: export PATH=\"$dir:\$PATH\"" ;;
esac
say "Update later with: darkory update"
