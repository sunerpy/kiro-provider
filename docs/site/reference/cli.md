# Command line

This page lists every `kiro-provider` command and option, as of 3.8.0.

```text
Usage: kiro-provider <command> [options]

Commands:
  serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]
  login [--config <path>] [--start-url <url>] [--region <region>] [--profile-arn <arn>]
  accounts list [--details | --json] [--sort <field>] [--order asc|desc]
  accounts refresh (--all | <id|email>) [--config <path>] [--json]
  accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>] [--profile-arn <arn>]
  accounts import [--from <path>] [--force]
  accounts remove <id|email> [--yes]
  self-update [--check] [--tag <version>] [--yes] [--json] [--proxy <url>] [--force]

Options:
  -h, --help     Show this help.
  -V, --version  Show the installed version. Add --check to look up the latest
                 release, and --json for machine-readable output.
```

Every command exits with status 0 on success and 1 on an error, a refused confirmation or, for `accounts refresh`, any
account that failed. Errors go to standard error.

## Configuration file

`serve`, `login`, `accounts refresh` and `accounts relogin` read `config.json`. Without `--config` they look for it at
`$XDG_CONFIG_HOME/kiro-provider/config.json` or `~/.config/kiro-provider/config.json` on Linux and macOS, and at
`%APPDATA%\kiro-provider\config.json` on Windows. A field can also come from its environment variable, and `serve`
takes three of them as options (`--host`, `--port`, `--proxy`); an option wins over the environment, which wins over
the file. Unknown fields and
invalid values stop the command with an error that names them. The
[configuration reference](../../CONFIGURATION.md) lists every field.

`accounts list`, `accounts import` and `accounts remove` work on `accounts.db` in the same directory and read no
configuration. `--version` and `self-update` read neither.

## serve

Starts the gateway and prints `Listening on http://127.0.0.1:8787` once it accepts requests.

| Option            | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `--config <path>` | Read this configuration file instead of the default one.                                      |
| `--host <host>`   | Address to listen on. Default `127.0.0.1`. Anything else exposes the gateway to your network. |
| `--port <port>`   | Port to listen on. Default `8787`.                                                            |
| `--proxy <url>`   | HTTP proxy for every connection to AWS: model calls, sign-in, token renewal and usage checks. |

It refuses to start without an entry in `api_keys`, or while another gateway holds the lock in the same config
directory. On `SIGTERM` or `SIGINT` it stops taking new requests, gives running ones 10 seconds to finish, then exits.

## login

Signs in to Kiro with a device code and saves the account.

| Option                | Meaning                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--start-url <url>`   | The IAM Identity Center start URL. Without it, sign-in is with AWS Builder ID.                                                     |
| `--region <region>`   | The region of the identity center that issues the token. Default: `default_region` from the configuration, `us-east-1` unless set. |
| `--profile-arn <arn>` | The Kiro profile to use when the identity has more than one.                                                                       |
| `--config <path>`     | Configuration to read, for `proxy_url` and the log level.                                                                          |

[Accounts](../guide/accounts.md#add-an-account) walks through it.

## accounts list

Prints the stored accounts without any credential.

| Option              | Meaning                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--details`         | Adds ID, sign-in method, overage, last sync, token expiry, recheck time and generation.                                                             |
| `--json`            | The same fields as JSON.                                                                                                                            |
| `--sort <field>`    | `email` (default), `id`, `auth`, `region`, `health`, `availability`, `usage`, `overage`, `last-sync`, `last-used`, `token-expires` or `generation`. |
| `--order asc\|desc` | Sort direction. Rows without a value for the field come last either way.                                                                            |

## accounts refresh

Fetches current usage from Kiro for one account or `--all`, and renews an access token that is close to expiry.
`--json` prints one result per account.

## accounts relogin

Signs one account in again and keeps its internal ID. It takes the same options as `login`, and cannot move the
account to a different profile.

## accounts import

Copies the accounts of OpenCode's `opencode-kiro-auth` once. `--from <path>` names the source database; by default it
is `opencode/kiro.db` in the same config root as kiro-provider's own directory, such as `~/.config/opencode/kiro.db`.
A row whose local copy is newer is skipped unless `--force` is given.

## accounts remove

Deletes one account, with its session bindings, output lineage and stored reasoning, after asking. `--yes` skips the
question.

## self-update

Replaces a standalone binary with a release build after checking it against the release's `SHA256SUMS`.

| Option            | Meaning                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--check`         | Report what would be installed and change nothing.                                                                          |
| `--tag <version>` | Install this release, older ones included.                                                                                  |
| `--yes`           | Replace without asking.                                                                                                     |
| `--force`         | Reinstall when the installed version is already the latest or newer.                                                        |
| `--json`          | Report the result as JSON.                                                                                                  |
| `--proxy <url>`   | Proxy for the download. `""` means none; without the option, `KIRO_PROVIDER_PROXY_URL`, then `HTTPS_PROXY` or `HTTP_PROXY`. |

A Bun install is refused; update it with `bun add -g @sunerpy/kiro-provider@latest`. [Updates](../guide/updates.md)
covers the rest.

## --version

`kiro-provider --version` prints the installed version. `--check` also looks up the latest release on GitHub, `--json`
prints an object, and `--proxy <url>` works as for `self-update`.
