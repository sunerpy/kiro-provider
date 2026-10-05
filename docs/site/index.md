---
layout: home
title: "kiro-provider: your Kiro accounts behind OpenAI Responses and Anthropic Messages"
titleTemplate: false
description: kiro-provider is a gateway that runs on your own machine. It signs in to AWS Kiro, spreads requests across your accounts and serves them through OpenAI Responses and Anthropic Messages, for Codex CLI, Claude Code, Zuno and the official SDKs.

hero:
  name: kiro-provider
  text: Kiro accounts for the agents you already use
  tagline: A gateway on your own machine. It signs in to AWS Kiro and serves your accounts as OpenAI Responses and Anthropic Messages, so Codex CLI, Claude Code and other agents need only a base URL and a key.
  actions:
    - theme: brand
      text: Install
      link: /guide/install
    - theme: alt
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/sunerpy/kiro-provider

home:
  facts:
    - term: Runs on
      text: Linux, macOS and Windows, as one executable or a Bun package, listening on 127.0.0.1.
    - term: Your accounts
      text: Signed in with AWS Builder ID or IAM Identity Center. Tokens stay in a local database and go only to AWS and Kiro.

  visual:
    label: A terminal session. One request goes to the OpenAI Responses route with gpt-5.6-sol and one to the Anthropic Messages route with claude-opus-5-5; kiro-provider 3.8.0 answers both with KIRO_OK.
    transcript:
      - kind: command
        text: export KP=http://127.0.0.1:18879/v1 KEY=$KIRO_GATEWAY_API_KEY
      - kind: command
        text: "curl -s $KP/responses -H \"Authorization: Bearer $KEY\" --json '{"
      - kind: continuation
        text: '    "model": "gpt-5.6-sol", "store": false,'
      - kind: continuation
        text: "    \"input\": \"Reply with exactly: KIRO_OK\"}' |"
      - kind: continuation
        text: "  jq -r '.output[-1].content[0].text'"
      - kind: output
        text: KIRO_OK
      - kind: command
        text: "curl -s $KP/messages -H \"x-api-key: $KEY\" --json '{"
      - kind: continuation
        text: '    "model": "claude-opus-5-5", "max_tokens": 1024,'
      - kind: continuation
        text: '    "messages": [{"role": "user",'
      - kind: continuation
        text: "      \"content\": \"Reply with exactly: KIRO_OK\"}]}' |"
      - kind: continuation
        text: "  jq -r '.content[0].text'"
      - kind: output
        text: KIRO_OK
    caption: Recorded on 2026-10-05 with kiro-provider 3.8.0 on a test port, with kiro-provider serve running in another terminal. The default address is http://127.0.0.1:8787.

  index:
    title: What kiro-provider does
    intro: Web search and the Chat Completions route ship switched off. Everything else works once an account is signed in.
    groups:
      - name: Serve
        items:
          - title: OpenAI Responses
            body: Streaming and non-streaming responses with tools, images and reasoning effort, plus stored responses you can retrieve, list and continue.
            status: available
            link: /reference/protocol
          - title: Anthropic Messages
            body: Messages with thinking, tools and images, and a token estimate on /v1/messages/count_tokens.
            status: available
            link: /reference/protocol
          - title: Web search
            body: The hosted web search tool of both APIs, run by kiro-provider through the account serving the request, with citations in the answer.
            status: opt-in
            link: /guide/web-search
          - title: Chat Completions
            body: The older OpenAI route, for clients that have nothing newer. It answers only when enable_legacy_chat_completions is on.
            status: opt-in
            link: /reference/configuration#protocol-exposure
      - name: Accounts
        items:
          - title: Direct sign-in
            body: Device-code login for AWS Builder ID and IAM Identity Center. kiro-provider finds the Kiro profile itself, so Kiro CLI is not involved.
            status: available
            link: /guide/accounts
          - title: Many accounts, one endpoint
            body: Requests go to the least busy eligible account. An exhausted account sits out until Kiro reports new quota.
            status: available
            link: /guide/accounts
          - title: Tokens and usage
            body: Access tokens are renewed before they expire and usage is refreshed in the background. accounts list shows each account's state.
            status: available
            link: /guide/accounts#see-your-accounts
      - name: Clients
        items:
          - title: Codex CLI
            body: A custom model_provider with wire_api = "responses", including model and effort switching in /model.
            status: available
            link: /clients/codex
          - title: Claude Code
            body: The kiroclaude launcher points Claude Code at the gateway without editing your Claude settings.
            status: available
            link: /clients/claude-code
          - title: Zuno
            body: Zuno's own Responses transport, with session routing from its metadata.
            status: available
            link: /clients/zuno
          - title: Model list
            body: GET /v1/models lists the models your signed-in accounts can use, with the effort levels Codex's model picker reads.
            status: available
            link: /clients/codex#model-and-effort-switching
      - name: Operate
        items:
          - title: Background service
            body: A systemd user service on Linux or a scheduled task on Windows, with health and readiness checks for automation.
            status: available
            link: /operate/service
          - title: Health and logs
            body: GET /health and GET /ready for service managers, and a JSON log of counts, enums and hashes with no prompts or credentials.
            status: available
            link: /operate/
          - title: Updates
            body: self-update replaces a standalone binary only after it matches the release's SHA256SUMS.
            status: available
            link: /guide/updates
  steps:
    title: From install to the first answer
    items:
      - title: Install
        command: curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
        body: Or the PowerShell script on Windows, or bun add -g @sunerpy/kiro-provider.
      - title: Sign in
        command: kiro-provider login
        body: Opens a device-code sign-in for AWS Builder ID. Add --start-url for IAM Identity Center.
      - title: Start the gateway
        command: kiro-provider serve
        body: Put a private key in api_keys in config.json first; the gateway refuses to start without one.
      - title: Point a client at it
        command: http://127.0.0.1:8787/v1
        body: Use that base URL and your key in Codex CLI, Claude Code, Zuno or an SDK.

  protocols:
    columns: [Route, Speaks, Default]
    rows:
      - cells: [POST /v1/responses, OpenAI Responses, On]
      - cells: [POST /v1/messages, Anthropic Messages, On]
      - cells: [POST /v1/messages/count_tokens, Anthropic token estimate, On]
      - cells: [GET /v1/models, Model list, On]
      - cells: [POST /v1/chat/completions, OpenAI Chat Completions, Off until enabled]
    code: [0]
    caption: Every route except /health asks for one of your api_keys, sent as Authorization Bearer or x-api-key.

  clients:
    columns: [Client, API, Set up with]
    rows:
      - cells: [Codex CLI, Responses, A model_provider in config.toml]
      - cells: [Claude Code, Messages, The kiroclaude launcher]
      - cells: [Zuno, Responses, A provider in Zuno's config]
      - cells: [OpenAI and Anthropic SDKs, Responses or Messages, A base URL and an API key]
    caption: Last validated on 2026-10-05 with Codex CLI 0.159.3 and Claude Code 2.1.285. Each guide lists what was checked.

  search:
    columns: [API, Tool, The answer carries]
    rows:
      - cells: [Responses, web_search, web_search_call items and url_citation annotations]
      - cells: [Messages, web_search_20250305, web_search_tool_result blocks and cited text]
    code: [1]
    caption: Searches run with gpt-5.6-sol or claude-opus-5.5, on accounts whose Kiro profile is in us-east-1. Other models are refused before anything runs.

  platforms:
    title: Platforms
    intro: Every release has a standalone binary for each platform below, a SHA256SUMS file and a build attestation.
    columns: [Platform, Release asset, Installer]
    rows:
      - name: Linux x64
        status: available
        cells: [kiro-provider-linux-x64, install.sh]
      - name: Linux ARM64
        status: available
        cells: [kiro-provider-linux-arm64, install.sh]
      - name: macOS Intel
        status: available
        cells: [kiro-provider-darwin-x64, install.sh]
      - name: macOS Apple Silicon
        status: available
        cells: [kiro-provider-darwin-arm64, install.sh]
      - name: Windows x64
        status: available
        cells: [kiro-provider-windows-x64.exe, install.ps1]
    note: The npm package @sunerpy/kiro-provider uses Bun's APIs. Install it with Bun; it does not run under Node.js or npx.

  privacy:
    title: What stays on your machine
    intro: kiro-provider talks to AWS for your accounts and to GitHub when you ask it about updates.
    sendsLabel: Goes to
    modes:
      - name: Model requests
        sends: Kiro, with your prompts
        detail: Each request goes to Kiro with the account that serves it. The log records counts, lengths and hashes, never prompts, tool arguments or credentials.
      - name: Accounts
        sends: AWS sign-in and Kiro
        detail: Sign-in, token renewal and usage checks. Tokens stay in accounts.db in your config directory, readable by your user only.
      - name: Updates
        sends: GitHub Releases
        detail: Only kiro-provider --version --check and self-update contact GitHub. The gateway itself never does.

  scope:
    title: What it does not do
    items:
      - It does not share or resell access. Use it only with Kiro accounts you control.
      - It does not work around usage limits. An exhausted account waits for Kiro to report new quota.
      - It does not pretend. Hosted tools other than web search, background responses and conversation objects are refused with a typed error, never imitated.
      - It does not listen on the network unless you set host to something other than 127.0.0.1.
---

<HomeIndex />

<HomeSteps />

<SplitBlock proof="protocols">

## Two APIs, one gateway

Responses and Messages are served by one process from one pool of accounts. A Responses request that Kiro's own
Responses operation can take unchanged goes there; anything else, `store: false` included, is converted by
kiro-provider itself. When neither path can keep a field, the request fails with an error that names it instead of
quietly dropping it.

[Protocol compatibility](../PROTOCOL_COMPATIBILITY.md) · [Configuration](../CONFIGURATION.md)

</SplitBlock>

<SplitBlock proof="clients" flip>

## Your agent stays as it is

Codex CLI and Zuno speak Responses; Claude Code speaks Messages. Each is configured with a base URL and one of your
keys, with no plugin and no patched client. The launchers add a separate command, `kirocodex` or `kiroclaude`, next to
the one you already have.

[Choose a client](clients/index.md) · [Client launchers](../CLIENT_LAUNCHERS.md)

</SplitBlock>

<SplitBlock proof="search">

## Web search through your own account

With `web_search_enabled` on, kiro-provider runs each API's hosted search tool itself, through Kiro's search and the
account that serves the request. The answer comes back in the shape that API defines, with the search results and
citations a client expects. It is off by default.

[Web search](guide/web-search.md)

</SplitBlock>

<HomePlatforms />

<HomePrivacy />

## Install

::: code-group

```sh [Linux and macOS]
curl -fsSL https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.sh | sh
```

```powershell [Windows]
irm https://raw.githubusercontent.com/sunerpy/kiro-provider/main/scripts/install.ps1 | iex
```

```sh [Bun]
bun add -g @sunerpy/kiro-provider
```

:::

The scripts check the binary against the release's `SHA256SUMS` before installing it. The
[install guide](guide/install.md) covers pinning a version, building from source and removing kiro-provider.

<HomeScope />

## Feedback

Bug reports and feature requests go to [GitHub Issues](https://github.com/sunerpy/kiro-provider/issues).
kiro-provider is MIT-licensed and is not an AWS product.
