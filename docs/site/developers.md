# Contributing

This page is for working on kiro-provider itself: the layout of the repository, the checks a change has to pass, and
how this site is built.

## The repository

kiro-provider is written in TypeScript for [Bun](https://bun.sh) 1.3.14, the version `package.json` pins.

| Path              | Holds                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/cli/`        | The `kiro-provider` command: argument parsing, `login`, `accounts`, `self-update`.                          |
| `src/server/`     | The HTTP gateway: authentication, admission, routes; `src/server/responses/` holds the two Responses paths. |
| `src/protocol/`   | The internal request and output contracts both APIs are converted to and from.                              |
| `src/kiro/`       | Kiro's transport, sign-in, model catalog and request conversion.                                            |
| `src/core/`       | Account scheduling, retries and the request pipeline.                                                       |
| `src/storage/`    | `accounts.db` and its migrations.                                                                           |
| `src/reasoning/`  | Encrypted reasoning replay.                                                                                 |
| `src/web-search/` | Provider-run web search.                                                                                    |
| `__tests__/`      | Tests, one file per module or behavior.                                                                     |
| `docs/`           | The references; `docs/site/` is this site, `docs/audits/` the dated evidence.                               |
| `scripts/`        | Install scripts, client launchers, probes and the repository's own checks.                                  |

[Architecture](../ARCHITECTURE.md) follows a request through these parts. [`AGENTS.md`](../../AGENTS.md) holds the
rules every change follows, for people and coding agents alike: protocol fidelity, fail-closed routing, what counts as a
secret, and the test each kind of change needs.

## Build and test

```sh
git clone https://github.com/sunerpy/kiro-provider.git
cd kiro-provider
bun install --frozen-lockfile
bun test __tests__/<target>.test.ts   # the test closest to your change
make check                            # formatting, types, lint, links, build, security, tests
make pre-ci                           # the same checks with the coverage gate, as CI runs them
bun run build:binary                  # dist/kiro-provider
```

Coverage is a release gate: `make coverage-gate` holds the line coverage at 93%, and pull requests need the
`codecov/project` and `codecov/patch` checks to pass as well as `CI Success`. A fix comes with a test that fails without
it.

Live checks against Kiro use their own configuration, port and copy of the accounts, never the gateway you use day to
day. Several probe scripts in `scripts/`, such as `prepare-web-search-gateway.ts` and `probe-web-search-live.ts`,
refuse the default port 8787 for that reason.

## Pull requests and releases

- Commit messages and pull request titles follow Conventional Commits with a lowercase scope, for example
  `fix(responses): …` or `docs(site): …`.
- Pull requests are squash-merged into `main`; nothing is pushed to `main` directly.
- Releases are cut by release-please: its pull request bumps the version and the
  [changelog](../../changelog/CHANGELOG-v3.x.md), and merging it builds and publishes the binaries, `SHA256SUMS`, the
  attestations and the npm package.

## This site

The pages of this site live in `docs/site/`, English at the root and Chinese under `zh/`, next to the code they
describe. The references they link, such as [`CONFIGURATION.md`](../CONFIGURATION.md), are published as they are.
FirLab's repository owns the theme and the build, and a merge to `main` here that touches the pages publishes them at
`firlab.app/kiro-provider/`. [`docs/site/README.md`](README.md) has the writing rules, the fields of the home page and
how to preview a change.

## Reporting a problem

Open an issue on [GitHub](https://github.com/sunerpy/kiro-provider/issues) with the kiro-provider version, the client
and its version, the HTTP status and error code, and the `request_id` from the error. Leave out prompts, keys and
tokens; the log events you attach contain none.
