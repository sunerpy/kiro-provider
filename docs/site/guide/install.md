# Install

This page covers installing kiro-provider, checking what you downloaded, and removing it again.

kiro-provider ships two ways: as a standalone executable for each platform, published on
[GitHub Releases](https://github.com/sunerpy/kiro-provider/releases), and as the npm package
`@sunerpy/kiro-provider`, which runs on [Bun](https://bun.sh). The standalone executable needs nothing else installed.

## Linux and macOS

```sh
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

The script picks the binary for your system (x64 or ARM64), refuses to continue unless its SHA-256 matches the
release's `SHA256SUMS`, and installs `kiro-provider` into `$HOME/.local/bin`. It needs `curl` or `wget`, and
`sha256sum`, `shasum` or `openssl`. It does not edit your shell profile: when the directory is not on your `PATH`, it
prints the line to add.

Set `KIRO_PROVIDER_INSTALL_DIR` to install somewhere else.

## Windows

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

The script verifies the binary the same way and installs `kiro-provider.exe` into `%USERPROFILE%\.local\bin`. When
that directory is not on your `PATH`, it prints the command that adds it for your user; open a new terminal after
running it. `KIRO_PROVIDER_INSTALL_DIR` changes the directory here too. Only x64 Windows has a build.

## Install a specific version

Both scripts install the latest release unless `KIRO_PROVIDER_VERSION` names one, with or without the leading `v`.
For a long-lived install, such as the [background service](../../SERVICE.md), pin the version and take the script from
the same tag:

```sh
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/vX.Y.Z/scripts/install.sh \
  | KIRO_PROVIDER_VERSION=X.Y.Z sh
```

```powershell
$env:KIRO_PROVIDER_VERSION = "X.Y.Z"
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/vX.Y.Z/scripts/install.ps1 | iex
```

## Bun package

```sh
bun add -g @sunerpy/kiro-provider
kiro-provider --version
```

For a one-off run without installing, use `bunx @sunerpy/kiro-provider --help`. The package calls Bun's own APIs, so
it does not run under Node.js, `npm exec` or `npx`. Upgrade it with Bun as well: [Updates](updates.md).

## Download a binary yourself

Every release carries one binary per platform, a `SHA256SUMS` file and a build attestation for each binary:

| Platform            | Asset                           |
| ------------------- | ------------------------------- |
| Linux x64           | `kiro-provider-linux-x64`       |
| Linux ARM64         | `kiro-provider-linux-arm64`     |
| macOS Intel         | `kiro-provider-darwin-x64`      |
| macOS Apple Silicon | `kiro-provider-darwin-arm64`    |
| Windows x64         | `kiro-provider-windows-x64.exe` |

Download the asset and `SHA256SUMS` from the same release, then check both the checksum and where the binary was
built:

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify kiro-provider-linux-x64 \
  --repo sunerpy/kiro-provider \
  --signer-workflow sunerpy/kiro-provider/.github/workflows/release.yml \
  --deny-self-hosted-runners
```

Rename the file to `kiro-provider` (`kiro-provider.exe` on Windows), make it executable and put it on your `PATH`.

## Build from source

With [Bun](https://bun.sh) and a clone of the repository:

```sh
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
bun run build:binary
```

The binary is `dist/kiro-provider`. [Contributing](../developers.md) covers the tests and checks.

## Check the install

```sh
kiro-provider --version
```

Then continue with the [quick start](quick-start.md).

## Uninstall

1. **Stop the gateway.** If it runs as a service, stop and remove the service first; the
   [service guide](../../SERVICE.md) shows how for systemd and for the Windows scheduled task.
2. **Remove its data**, if you do not plan to come back. All of kiro-provider's data is in one directory:
   `~/.config/kiro-provider` (or `$XDG_CONFIG_HOME/kiro-provider`) on Linux and macOS, `%APPDATA%\kiro-provider` on
   Windows. It holds `config.json`, `accounts.db` with your account tokens, and the key file for stored reasoning.
   Delete the directory to remove all of it.
3. **Remove the executable**: `~/.local/bin/kiro-provider`, `%USERPROFILE%\.local\bin\kiro-provider.exe`, or the
   directory you chose with `KIRO_PROVIDER_INSTALL_DIR`. A Bun install is removed with
   `bun remove -g @sunerpy/kiro-provider`.
