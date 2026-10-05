# What is kiro-provider

This page explains what kiro-provider does with your Kiro accounts, how a request travels through it, and where it
stops.

kiro-provider is a gateway you run on your own machine. It signs in to AWS Kiro as you, keeps the tokens for every
account you add, and serves those accounts through the two APIs that coding agents speak: OpenAI Responses and
Anthropic Messages. Codex CLI, Claude Code, Zuno and the official SDKs then work with a base URL and a key, and the
choice of account, the token renewal and the translation to Kiro happen in the gateway.

## How a request travels

1. **Authenticate.** The client sends one of the keys in your `api_keys`, as `Authorization: Bearer` or `x-api-key`.
   Any other request is refused before its body is read.
2. **Choose an account.** The request goes to the least busy account that is ready for its model. A conversation that
   carries a session key, as Claude Code and Zuno send, is kept on the account that started it while that account has
   room.
3. **Choose a path.** A Responses request that Kiro's own Responses operation can take unchanged is sent there. Any
   other request, every Messages request included, is converted by kiro-provider into Kiro's conversation format.
4. **Answer.** The reply streams back in the shape of the API the client used. A field that neither path can carry
   fails the request with an error that names it; nothing is dropped quietly.
5. **Remember.** Stored Responses and encrypted reasoning are kept in a local database, so a client can continue a
   conversation, switch model or effort, and resume after a restart.

## One gateway, two APIs

| Route                            | For                                                          |
| -------------------------------- | ------------------------------------------------------------ |
| `POST /v1/responses`             | Codex CLI, Zuno, the OpenAI SDKs and other Responses clients |
| `POST /v1/messages`              | Claude Code, the Anthropic SDKs and other Messages clients   |
| `POST /v1/messages/count_tokens` | Claude Code's context accounting (an estimate)               |
| `GET /v1/models`                 | Model pickers                                                |
| `GET /health`, `GET /ready`      | Your service manager and monitoring                          |
| `POST /v1/chat/completions`      | Older clients, only when you turn the route on               |

Both APIs share the accounts, the queue and the limits, so a Codex session and a Claude Code session can run side by
side on the same gateway.

## What it keeps

Your accounts, their tokens and usage, stored responses and encrypted reasoning live in `accounts.db` in your config
directory, readable by your user only. The gateway's log records counts, lengths and hashes, never prompts, tool
arguments or credentials. [Data and network](../privacy.md) lists every file and every host it talks to.

## What it does not do

- **It does not promise full OpenAI or Anthropic parity.** Hosted tools other than web search, background responses,
  conversation objects, remote file references and arbitrary JSON Schema output are refused with typed errors.
  [Known limits](../limits.md) lists them.
- **It does not share access.** It is meant for Kiro accounts you control, and it does not get around their usage
  limits.
- **It does not depend on Kiro CLI.** Sign-in, profile discovery and token renewal are its own.

## Next steps

- [Install](install.md)
- [Quick start](quick-start.md)
- [Choose a client](../clients/index.md)
