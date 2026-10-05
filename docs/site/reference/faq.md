# Frequently asked questions

Short answers, each with a link to the page that has the detail.

## Do I need Kiro CLI or the Kiro IDE?

No. `kiro-provider login` signs in, finds the Kiro profile and renews tokens on its own, and nothing it does at run
time reads another program's files. [Accounts](../guide/accounts.md)

## Does it run on Node.js?

The npm package uses Bun's APIs, so it runs on Bun only: `bun add -g @sunerpy/kiro-provider`. The standalone binary
needs neither. [Install](../guide/install.md)

## Which models can I use?

The ones your signed-in accounts can use. `GET /v1/models` lists them, with `auto` and a name per effort level where a
model has levels. [Choose a client](../clients/index.md#model-names)

## A Responses request fails with `403 access_denied`. Why?

A request without `store: false` goes to Kiro's own Responses operation, and Kiro can refuse that operation for an
account. With `store: false` the request goes through kiro-provider's own conversion, as Codex CLI's requests do.
[Quick start](../guide/quick-start.md#4-send-a-first-request)

## A request fails with an error that names a field. Is that a bug?

Usually not. When neither path to Kiro can keep a field, the request fails with a typed error such as
`unsupported_structured_output` instead of losing it. [Protocol compatibility](../../PROTOCOL_COMPATIBILITY.md) lists
what each API accepts; [known limits](../limits.md) lists what is refused on purpose.

## Can other machines use my gateway?

It listens on `127.0.0.1` unless you set `host`. If you open it to a network, every request still needs one of your
`api_keys`, but the traffic is plain HTTP; put it behind a proxy that terminates TLS, and treat the keys as passwords.
[Configuration](../../CONFIGURATION.md)

## Can I share my accounts with other people?

No. kiro-provider is meant for Kiro accounts you control, and it does not get around their usage limits.

## Why does an account show `quota-exhausted` or `overage-blocked`?

Kiro reported its quota as used up, or it is in paid overage and `stop_on_overage` keeps it out. The account comes back
by itself when its quota resets. [Accounts](../guide/accounts.md#see-your-accounts)

## Does it keep my prompts?

Only what a client asks it to keep. A Responses request without `store: false` is stored locally for 30 days so the
client can retrieve and continue it, and conversations keep encrypted reasoning for their next turn. All of it is in
`accounts.db` on your machine. The log never contains prompts. [Data and network](../privacy.md)

## Does it contact anything besides AWS?

GitHub, when you run `kiro-provider --version --check` or `self-update`. The gateway itself sends nothing to GitHub,
and there is no telemetry. [Data and network](../privacy.md)

## Can I run two gateways?

Not on the same config directory: the second one stops with `service_instance_already_running`. One gateway per user
is the intended setup. [Operate](../operate/index.md#one-gateway-per-user)

## Is this an AWS product?

No. kiro-provider is an independent open-source project under the MIT License.
