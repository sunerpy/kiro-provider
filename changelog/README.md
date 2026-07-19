# Changelog

This `changelog/` directory is the single source of truth for the project's
changelog. Per-major-version files live here, one Markdown file per major series:

- `CHANGELOG-v0.x.md` — the `0.x` series
- `CHANGELOG-v1.x.md` — the `1.x` series
- …

**How updates work:**

- The active changelog file (currently `CHANGELOG-v0.x.md`) is maintained
  automatically by release-please in its release PR. The
  [`release-please-config.json`](../release-please-config.json) sets
  `"changelog-path": "changelog/CHANGELOG-v0.x.md"`. When a new major series
  begins, create `CHANGELOG-vN.x.md` and update `changelog-path`.
- GitHub Release notes are rendered separately by
  [git-cliff](https://git-cliff.org) using
  [`cliff.toml`](../cliff.toml) in the release workflow.

**Do not hand-edit:** These files are generated. The `changelog/` directory and
root `CHANGELOG*` files must be excluded from `oxfmt` so formatting does not
cause spurious release-PR diffs.
