#!/bin/sh
set -eu

REPO="sunerpy/kiro-provider"
BIN="kiro-provider"

err() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

info() {
	printf '%s\n' "$1" >&2
}

if command -v curl >/dev/null 2>&1; then
	download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
	download() { wget -qO "$2" "$1"; }
else
	err "curl or wget is required to download releases"
fi

if command -v sha256sum >/dev/null 2>&1; then
	sha256_of() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256_of() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v openssl >/dev/null 2>&1; then
	sha256_of() { openssl dgst -sha256 "$1" | sed 's/^.*= *//'; }
else
	err "sha256sum, shasum, or openssl is required to verify the download"
fi

case "$(uname -s)" in
Linux) os="linux" ;;
Darwin) os="darwin" ;;
*) err "unsupported OS: $(uname -s) (supported: Linux, Darwin)" ;;
esac

case "$(uname -m)" in
x86_64 | amd64) arch="x64" ;;
arm64 | aarch64) arch="arm64" ;;
*) err "unsupported architecture: $(uname -m) (supported: x86_64, arm64)" ;;
esac

asset="${BIN}-${os}-${arch}"
install_dir=${KIRO_PROVIDER_INSTALL_DIR:-"$HOME/.local/bin"}

# KIRO_PROVIDER_VERSION pins a release tag (with or without the leading "v").
# Without it the script follows releases/latest; pin it for reproducible installs.
if [ "${KIRO_PROVIDER_VERSION:-}" != "" ]; then
	tag=$(printf '%s' "$KIRO_PROVIDER_VERSION" | sed 's/^v//')
	tag="v${tag}"
	base_url="https://github.com/${REPO}/releases/download/${tag}"
else
	tag="latest"
	base_url="https://github.com/${REPO}/releases/latest/download"
fi
url="${base_url}/${asset}"
sums_url="${base_url}/SHA256SUMS"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t "$BIN")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

info "Installing ${BIN} (${os}-${arch}, ${tag})"
info "  from: ${url}"
info "  to:   ${install_dir}/${BIN}"

# Fetch the checksum manifest first so a release published mid-install cannot
# pair a newer binary with an older manifest without failing verification.
download "$sums_url" "$tmp/SHA256SUMS" || err "download failed: $sums_url"
expected=$(grep -E "^[0-9a-fA-F]{64}[[:space:]]+\*?${asset}\$" "$tmp/SHA256SUMS" | head -n 1 | cut -c 1-64)
[ -n "$expected" ] || err "SHA256SUMS for ${tag} has no entry for ${asset}"

download "$url" "$tmp/$asset" || err "download failed: $url"
[ -s "$tmp/$asset" ] || err "downloaded asset is empty: $url"

actual=$(sha256_of "$tmp/$asset")
if [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" != "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ]; then
	err "checksum mismatch for ${asset} (${tag}): expected ${expected}, got ${actual}. Refusing to install; retry, or pin a release with KIRO_PROVIDER_VERSION=<version>."
fi
info "  sha256: ${actual} (verified against SHA256SUMS)"

chmod +x "$tmp/$asset"
mkdir -p "$install_dir"
mv "$tmp/$asset" "$install_dir/$BIN" || err "failed to install to $install_dir"

info "Installed ${BIN} to ${install_dir}/${BIN}"
case ":$PATH:" in
*":$install_dir:"*) ;;
*) info "NOTE: $install_dir is not on PATH. Add: export PATH=\"$install_dir:\$PATH\"" ;;
esac

info "Quick start:"
info "  ${BIN} --help"
info "  ${BIN} login"
info "  ${BIN} serve"
