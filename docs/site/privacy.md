# Data and network

This page lists everything kiro-provider writes to your disk and every host it connects to.

## What it writes

All of it is in one directory: `$XDG_CONFIG_HOME/kiro-provider` or `~/.config/kiro-provider` on Linux and macOS,
`%APPDATA%\kiro-provider` on Windows.

| File                         | Contents                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                | Written by you. Your settings and `api_keys`.                                                                                                       |
| `accounts.db`                | Each account's email, region, profile and tokens; its usage and health; session bindings; stored Responses; encrypted reasoning and search history. |
| `accounts.db-wal`, `-shm`    | SQLite's working files for `accounts.db`.                                                                                                           |
| `reasoning-replay-keys.json` | The key that encrypts stored reasoning and search history.                                                                                          |
| `service.instance`           | The lock of the running gateway.                                                                                                                    |

The database and its working files are created readable by your user only, and the gateway warns when `config.json`
is readable by others.

What a conversation leaves behind:

- **Stored responses.** A Responses request without `store: false` is kept with its input items, so a client can
  retrieve it, list its items or continue from it. Stored responses expire after 30 days, at most 10,000 are kept, and
  `DELETE /v1/responses/{id}` removes one. They belong to the key that created them.
- **Reasoning.** Kiro's signed reasoning for each turn is kept encrypted, so the next turn can return it to the model
  unchanged. The client carries an opaque token that refers to it.
- **Search history.** With web search on, the searches of a conversation are kept encrypted for 24 hours by default,
  so the conversation can continue with the same results.
- **Session bindings.** For a conversation with a session key, the gateway keeps a hash of the key, the account it
  runs on and Kiro's conversation ID, not the session value or the prompt.

Removing an account with `accounts remove` deletes its bindings and stored reasoning with it.

## What it sends, and where

| Host                                                    | When                                        | What goes there                                                                             |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `oidc.<region>.amazonaws.com`                           | `login`, `relogin`, token renewal           | The device-code sign-in and refresh of AWS Builder ID and IAM Identity Center tokens.       |
| `prod.<region>.auth.desktop.kiro.dev`                   | Token renewal                               | The refresh of accounts that signed in with Kiro's own sign-in, such as some imported ones. |
| `management.<region>.kiro.dev`                          | `login`, `relogin`                          | The lookup of the identity's Kiro profiles, in `us-east-1` and `eu-central-1`.              |
| `runtime.<region>.kiro.dev`, `q.<region>.amazonaws.com` | Every model request, usage check and search | Your prompts, tools and history, with the account that serves them.                         |
| `api.github.com`, `github.com`                          | `--version --check`, `self-update`          | A release lookup and the download of a release binary.                                      |

`<region>` is the account's region. Nothing else is contacted: there is no telemetry, and the gateway never checks for
updates by itself. With `proxy_url` set, every AWS and Kiro connection above goes through that proxy.

Clients reach the gateway on `127.0.0.1:8787` by default, over plain HTTP. Nothing outside your machine can connect
unless you set `host` to another address.

## The log

The log goes to standard error, one JSON object per line. It holds event names, enums, counts, lengths, durations and
hashes. It never holds prompts, model output, tool names or arguments, tokens, API keys, session values or
reasoning. A hash in the log, such as `account_hash`, lets you follow one account or one request through the events
without revealing it.

## Removing everything

Stop the gateway and delete its directory. That removes the accounts and their tokens, stored responses, reasoning,
search history and the encryption key. Deleting tokens here does not revoke them at AWS; signing out there is
separate.
