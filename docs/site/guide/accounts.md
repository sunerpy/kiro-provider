# Accounts

This page covers adding Kiro accounts, reading their state, and what kiro-provider does with them on its own.

kiro-provider keeps its accounts in `accounts.db` in your config directory and is the only program that uses the
tokens stored there. It needs no Kiro CLI, Kiro IDE or OpenCode at run time.

## Add an account

```sh
kiro-provider login
```

That is the device-code sign-in for AWS Builder ID: `login` prints a link, you sign in in the browser, and the command
saves the account. For IAM Identity Center, pass the start URL of your organization and the region of its identity
center:

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1
```

After sign-in, kiro-provider asks Kiro which profiles the identity can use and stores the one it finds. With several
profiles and no unique match for the start URL, it stops before writing anything; rerun with the profile you want:

```sh
kiro-provider login --start-url https://example.awsapps.com/start --region us-east-1 \
  --profile-arn arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE_ID
```

The region you pass is where the identity signs in. The region requests go to comes from the profile, so the two may
differ; kiro-provider stores both.

Run `login` once per account. Signing in again as the same person, with the same start URL and profile, updates the
existing account instead of adding a second one.

### Import from OpenCode

If you already signed in through OpenCode with `opencode-kiro-auth`, copy those accounts once:

```sh
kiro-provider accounts import
kiro-provider accounts import --from /path/to/kiro.db
```

The import is a copy, not a link. Afterwards kiro-provider renews the tokens of its copy, so stop using the same
accounts in OpenCode: two programs renewing one refresh token race each other. An account whose local copy is newer
than the source is skipped unless you add `--force`.

## See your accounts

```sh
kiro-provider accounts list
kiro-provider accounts list --details
kiro-provider accounts list --json
```

The default table has one row per account with its email, region, health, availability and usage. `--details` adds
the internal ID, sign-in method, overage count, last usage sync, token expiry and the time a waiting account is
checked again; `--json` gives the same fields for scripts. No output mode prints a token or a client secret.

Sort with `--sort` and flip the order with `--order desc`, for example `--sort usage --order desc`. The fields are
`email` (the default), `id`, `auth`, `region`, `health`, `availability`, `usage`, `overage`, `last-sync`, `last-used`,
`token-expires` and `generation`.

The availability column says whether an account takes requests:

| Availability      | Meaning                                                                                        | What to do                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `available`       | Takes requests.                                                                                | Nothing.                                                                                        |
| `rate-limited`    | Kiro asked it to wait. `RECHECK_AT` in `--details` says until when.                            | Wait.                                                                                           |
| `quota-exhausted` | Kiro reported its quota as used up. It returns once a usage check confirms a new quota window. | Wait for the reset, or add accounts.                                                            |
| `overage-blocked` | It is in paid overage, and `stop_on_overage` keeps such accounts out.                          | Decide whether to allow overage: see below.                                                     |
| `needs-relogin`   | Kiro rejected its refresh token.                                                               | `kiro-provider accounts relogin <id or email>`.                                                 |
| `unhealthy`       | Another failure took it out of rotation.                                                       | Read the log; [troubleshooting](../../TROUBLESHOOTING.md#accounts-and-quota) lists the signals. |

## What kiro-provider does on its own

While the gateway runs, it:

- renews an access token shortly before it expires and saves it before using it;
- refreshes each account's usage in the background;
- leaves exhausted accounts out of the rotation, and checks them again when their recheck time comes;
- stops trying an account whose refresh token Kiro rejected, and marks it `needs-relogin`.

For each request it picks the least busy account that is ready for the model; among equally busy accounts, the
default `lowest-usage` strategy prefers the one with the most quota left. Each account takes up to 10 requests at a
time (`account_inference_concurrency`). A conversation that carries a session key stays on its account while that
account has room. [Session affinity](../../CONFIGURATION.md#session-affinity-and-connection-reuse) has the details.

## Refresh, sign in again, remove

```sh
kiro-provider accounts refresh --all
kiro-provider accounts refresh you@example.com --json
```

`refresh` asks Kiro for each account's current usage right away and renews a token only when it is close to expiry.
If any account fails, the command exits with a non-zero status and reports each account, so `--json` suits
monitoring.

```sh
kiro-provider accounts relogin you@example.com
```

`relogin` signs one account in again and keeps its internal ID, so the conversations bound to it carry on. It cannot
move an account to a different Kiro profile; add the other profile with a new `login`.

```sh
kiro-provider accounts remove you@example.com
```

`remove` asks for confirmation; `--yes` skips the question. It deletes the account together with its session
bindings and stored reasoning. Where an email matches several accounts, use the ID from `accounts list --details`.

## Paid overage

By default an account that has gone into paid overage is left out (`stop_on_overage: true`, `overage_threshold: 0`).
To spend overage on purpose, set `stop_on_overage` to `false`, or raise `overage_threshold` to the number of overage
requests you accept. When every account is exhausted, requests fail with `402 quota_exhausted`; when every account is
held back only by this rule, with `402 paid_overage_blocked`.
