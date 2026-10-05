# Updates

This page covers finding out whether a newer release exists, updating each kind of install, and what to do with a
running gateway.

## Check for a new release

```sh
kiro-provider --version --check
```

```text
kiro-provider 3.8.0
Latest release: 3.8.0 (https://github.com/sunerpy/kiro-provider/releases/tag/v3.8.0)
Already on the latest release.
```

Without `--check`, `--version` prints the installed version only and never goes online. Add `--json` for scripts; the
object has `version`, `latest_version`, `latest_tag`, `update_available`, `local_is_newer` and `release_url`.

What changed in each release is in the [changelog](../../../changelog/CHANGELOG-v3.x.md) and on the
[releases page](https://github.com/sunerpy/kiro-provider/releases).

## Update a standalone binary

```sh
kiro-provider self-update --check     # say what would be installed, change nothing
kiro-provider self-update             # ask, then replace the binary
kiro-provider self-update --yes       # replace without asking
kiro-provider self-update --tag 3.7.3 # install a specific release, older ones included
```

`self-update` downloads the binary for your platform from GitHub Releases and checks it against the release's
`SHA256SUMS`. Only when the digest matches does it replace the binary, so a failed or tampered download leaves the
installed copy as it was. It needs write access to the directory the binary is in, not to the file itself.

When you are already on the latest release, or on a build newer than it, `self-update` stops and says so; `--force`
installs the latest release anyway. `--json` reports the result as an object.

Neither `self-update` nor `--version --check` reads the gateway's `config.json`, so a broken configuration cannot
stop an update.

## Update a Bun install

```sh
bun add -g @sunerpy/kiro-provider@latest
```

`self-update` refuses to replace a package-manager install and says so.

## Through a proxy

Both commands take `--proxy <url>`. Without it they use `KIRO_PROVIDER_PROXY_URL`, then `HTTPS_PROXY` or
`HTTP_PROXY`. `--proxy ""` means no proxy, without falling back to those variables. Bun's own `fetch` also reads
`HTTPS_PROXY` and `HTTP_PROXY`, so unset them as well when you need a fully direct connection.

## Restart the gateway

`self-update` never touches the configuration, the account store or a service definition, and it does not restart
anything. A running gateway keeps the build it started with until you restart it:

```sh
kiro-provider self-update --yes
systemctl --user restart kiro-provider.service
kiro-provider --version
```

On Windows, stop and start the scheduled task (`Stop-ScheduledTask -TaskName "kiro-provider"`, then
`Start-ScheduledTask`). For a service, pin the version with `--tag` rather than following the newest release; the
[service guide](../../SERVICE.md#upgrading-the-service-binary) shows the full sequence and the health check
afterwards.

A newer release migrates the data an older one left in `accounts.db`. Going back to an older release can need a step
first: [web search](web-search.md#search-history), for example, asks you to remove its fields before you return to a
release without it.
