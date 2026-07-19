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

if [ "${KIRO_PROVIDER_VERSION:-}" != "" ]; then
	tag=$(printf '%s' "$KIRO_PROVIDER_VERSION" | sed 's/^v//')
	tag="v${tag}"
	url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
else
	tag="latest"
	url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t "$BIN")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

info "Installing ${BIN} (${os}-${arch}, ${tag})"
info "  from: ${url}"
info "  to:   ${install_dir}/${BIN}"

download "$url" "$tmp/$BIN" || err "download failed: $url"
[ -s "$tmp/$BIN" ] || err "downloaded asset is empty: $url"
chmod +x "$tmp/$BIN"
mkdir -p "$install_dir"
mv "$tmp/$BIN" "$install_dir/$BIN" || err "failed to install to $install_dir"

info "Installed ${BIN} to ${install_dir}/${BIN}"
case ":$PATH:" in
*":$install_dir:"*) ;;
*) info "NOTE: $install_dir is not on PATH. Add: export PATH=\"$install_dir:\$PATH\"" ;;
esac

info "Quick start:"
info "  ${BIN} --help"
info "  ${BIN} login"
info "  ${BIN} serve"
