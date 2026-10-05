# Operate kiro-provider

This page is the overview for running kiro-provider for the long term: one gateway per user, health checks, the log,
and where its files live.

## One gateway per user

Run one long-lived kiro-provider for each operating-system user and point every client of that user at it. Starting a
new gateway per agent or per conversation loses what a long-lived process keeps: the bindings that keep a conversation
on its account, the connections to Kiro, and the queue that shares your accounts between clients. A lock file
in the config directory stops a second gateway on the same directory from starting
(`service_instance_already_running`).

The [background service](../../SERVICE.md) guide installs it as a systemd user service on Linux or as a scheduled
task for the current user on Windows, and shows how to upgrade it.

## Health and readiness

| Check         | Key needed | Answers                                                                                                                                                                  |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health` | No         | `{"status":"ok"}` while the process runs.                                                                                                                                |
| `GET /ready`  | Yes        | HTTP 200 with `"status":"ready"` when an account is active and storage is usable; otherwise 503 with `"status":"not_ready"` and a `reason` such as `no_active_accounts`. |

```sh
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:8787/ready -H "Authorization: Bearer $KIRO_GATEWAY_API_KEY"
```

Use `/health` for a liveness probe and `/ready` before you start a client. The `model_catalog` object in the `/ready`
answer says whether the model list comes from Kiro or from the built-in fallback.

## The log

The gateway writes one JSON object per line to standard error. Events name what happened (`request_received`,
`account_selection_completed`, `upstream_attempt_failed`) with counts, durations, enums and hashes. Prompts, tool
names and arguments, tokens and session values never appear in it. `log_level` (`debug`, `info`, `warn`, `error`;
default `info`) sets the threshold.

Under systemd the log is in the journal:

```sh
journalctl --user -u kiro-provider.service -n 200 --no-pager
```

The [troubleshooting guide](../../TROUBLESHOOTING.md) starts from the signal you see, an HTTP status, an error code or
a log event, and says what it means and what to do.

## Files

Everything kiro-provider writes is in one directory: `$XDG_CONFIG_HOME/kiro-provider` or `~/.config/kiro-provider` on
Linux and macOS, `%APPDATA%\kiro-provider` on Windows.

| File                         | Holds                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `config.json`                | Your configuration and `api_keys`. Keep it readable by your user only.                        |
| `accounts.db`                | Accounts and tokens, usage, stored responses, session bindings, reasoning and search history. |
| `reasoning-replay-keys.json` | The key that encrypts stored reasoning and search history.                                    |
| `service.instance`           | The lock held by the running gateway.                                                         |

The gateway logs a `config_file_permissions_loose` warning when `config.json` is readable by other users; `chmod 600`
fixes it. It creates `accounts.db` and its `-wal` and `-shm` files readable by your user only. Back up the directory as
a whole: `accounts.db` without the key file cannot decrypt stored reasoning.

## Further reading

- [Configuration reference](../../CONFIGURATION.md): every field, its environment variable and default.
- [Background service](../../SERVICE.md): installing, upgrading and checking the service.
- [Troubleshooting](../../TROUBLESHOOTING.md): from a symptom to its cause.
- [Streaming errors](../../STREAM_ERROR_CONTRACT.md): what a client sees when a stream fails after it started.
