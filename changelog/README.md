# Changelog

This directory holds the project's changelog, one Markdown file per major series:

- [`CHANGELOG-v3.x.md`](CHANGELOG-v3.x.md) — the current `3.x` series
- [`CHANGELOG-v0.x.md`](CHANGELOG-v0.x.md) — the `0.x` series

There was no `1.x` or `2.x` series: the project went from `0.x` to `3.0.0`.

**How updates work:**

- release-please maintains the active file in its release pull request.
  [`release-please-config.json`](../release-please-config.json) sets
  `"changelog-path": "changelog/CHANGELOG-v3.x.md"`. When a new major series
  begins, create `CHANGELOG-vN.x.md` and update `changelog-path`.
- The GitHub Release notes are the same entry: release-please writes it into
  the draft release it creates, and the release workflow publishes that draft
  once the binaries and the npm package are out.

**Do not hand-edit:** these files are generated. The `changelog/` directory is
excluded from `oxfmt` so formatting does not cause spurious release-PR diffs.
