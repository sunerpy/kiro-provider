# docs/site

The pages of the kiro-provider website, published at <https://firlab.app/kiro-provider/>. This file is for people who
edit them; it is not itself a page of the site.

The words live here, next to the code they describe, so a change that alters what a user sees updates the page in the
same pull request. The site itself, its theme, components, build and deployment, lives in
[sunerpy/firlab](https://github.com/sunerpy/firlab) under `kiro-provider/`. Its sync script copies these pages and the
references they link into the site; do not edit the copies there.

## What is published

| Source                                                                               | Published at                                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `docs/site/<path>.md`                                                                | `/kiro-provider/<path>`                                                                         |
| `docs/site/zh/<path>.md`                                                             | `/kiro-provider/zh/<path>`                                                                      |
| `docs/CODEX.md`, `docs/readme/CODEX.zh-CN.md` and the other client guides            | `/clients/codex` and so on, in both languages                                                   |
| `docs/SERVICE.md`, `docs/TROUBLESHOOTING.md`                                         | `/operate/service`, `/operate/troubleshooting`                                                  |
| `docs/CONFIGURATION.md`, `docs/PROTOCOL_COMPATIBILITY.md`, `docs/RESPONSES_USAGE.md` | `/reference/configuration`, `/reference/protocol`, `/reference/usage`                           |
| `docs/STREAM_ERROR_CONTRACT.md`, `docs/HISTORICAL_TOOLS.md`, `docs/ARCHITECTURE.md`  | `/reference/streaming-errors`, `/reference/historical-tools`, `/dev/architecture`, English only |
| `docs/site/public/kiro-provider-logo.svg`                                            | The site's logo and favicon                                                                     |

The sync script in FirLab (`kiro-provider/scripts/sync-kiro-provider-docs.sh`) holds the exact mapping. Adding a
reference to the site means adding it there and to the sidebars in the same FirLab change.

## Rules the sync checks

The sync stops before it writes anything when:

- a page exists in one language only: every `docs/site/<path>.md` needs `docs/site/zh/<path>.md`, and the reverse;
- a page sits where a synced reference goes, such as `docs/site/reference/configuration.md`;
- a page uses a component the theme does not register (see below);
- a guide page uses a colloquial word (`just`, `simply`, `stuff`; `搞定`, `折腾`, `试试`, `看看` and the like) or names
  the source tree (`src/server/…`); `developers.md` may name the source tree.

## Writing

- Write for someone who runs kiro-provider, not for someone who works on it. Say what to do and what happens; leave
  the internals to the references and `developers.md`.
- Commands, field names, routes, error codes and file names go in code spans.
- Every number, version and output on a page comes from the code, a release or a recorded run. Output shown as a
  program's output is copied from that program, not typed by hand.
- Chinese pages are written in Chinese, not translated word for word, and keep the English names of commands, fields
  and products.

## Links

Link other files by their real path in this repository, the way GitHub resolves it. A page at the top of
`docs/site/` writes `[Configuration](../CONFIGURATION.md#web-search)` and `[Accounts](guide/accounts.md)`; a page in
a subdirectory adds one `../` per level. `make docs-links` checks every link, anchors included. The sync turns a link to a published reference into a link to its page on the site, and
any other link that leaves the published files into a GitHub link.

Do not write site paths such as `/guide/install` in Markdown links: GitHub cannot follow them and `make docs-links`
reports them. The home page's frontmatter is the exception, because it is data for the theme, not Markdown.

## Components

Pages are GitHub Markdown, plus these components of the site's theme: `HomeIndex`, `HomeSteps`, `SplitBlock`,
`HomePlatforms`, `HomePrivacy`, `HomeScope`, `StatusTag` and VitePress's `Badge`. They render on the site only; on
GitHub a page shows them as plain tags, so keep them to the two home pages.

## The home page

`index.md` and `zh/index.md` carry their content in the `home:` frontmatter, which the theme lays out. The build fails
when a field is missing, misspelt or of the wrong shape (`theme/data/home-schema.ts` in FirLab).

| Field                            | Holds                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facts`                          | Two to four `term` and `text` rows under the tagline.                                                                                                                       |
| `visual`                         | The terminal session in the hero: a `label` for screen readers, the `transcript` lines (`command`, `continuation` for a command's further lines, `output`) and a `caption`. |
| `index`                          | Groups of features, each with `title`, `body`, `status` (`available` or `opt-in`) and an optional `link`.                                                                   |
| `steps`                          | Four steps, each with `title`, `body` and an optional `command`.                                                                                                            |
| `protocols`, `clients`, `search` | The tables beside the three splits: `columns`, `rows` of `cells`, `code` (the indexes of the columns shown as code) and a `caption`.                                        |
| `platforms`                      | The platform table: `columns`, and `rows` with `name`, `status` and one cell per remaining column.                                                                          |
| `privacy`                        | What goes where: `sendsLabel` and `modes` with `name`, `sends` and `detail`.                                                                                                |
| `scope`                          | What kiro-provider does not do, as `items`.                                                                                                                                 |

The transcript is a real run. To record a new one, start a gateway with its own configuration, port and copy of the
accounts, never the gateway you use day to day, run the commands exactly as the page shows them, and copy the output.
Name the version, the date and the port in the caption.

## Preview

With a FirLab checkout next to this repository:

```sh
cd ../firlab/kiro-provider
pnpm install --frozen-lockfile
./scripts/sync-kiro-provider-docs.sh ../../kiro-provider
pnpm dev    # http://localhost:5173/kiro-provider/
```

`pnpm build` followed by `./scripts/check-dist.sh dist` runs the same checks as the deployment.

## Publishing

Two workflows connect this repository to the site:

- `.github/workflows/docs-site.yml` runs on pull requests that touch the pages or the references. It syncs them into
  a checkout of FirLab's `main`, builds the site and runs `check-dist.sh`, without a secret. It is advisory and not
  part of `CI Success`.
- `.github/workflows/publish-site.yml` runs after a merge to `main` that touches them. It runs the same sync and
  pushes the result to FirLab's `main` as `docs(kiro-provider): sync from kiro-provider@<sha>`; FirLab's deploy then
  publishes the site.

`publish-site.yml` needs the repository secret `FIRLAB_DOCS_TOKEN`: a fine-grained personal access token for
`sunerpy/firlab` only, with Contents read and write and nothing else. GitHub has no API that creates one, so it is
made by hand and stored with:

```sh
gh secret set FIRLAB_DOCS_TOKEN --repo sunerpy/kiro-provider
```

Without it the workflow fails at its first step and says so; nothing is pushed, and a sync reaches FirLab through a
pull request there instead.
