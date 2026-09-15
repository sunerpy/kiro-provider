import { describe, expect, test } from "bun:test";
import {
  RELEASE_FILES,
  type ReleaseDeltaInput,
  validateReleasePrDelta,
} from "./check-release-pr-delta.js";

function fixture(overrides: Partial<ReleaseDeltaInput> = {}): ReleaseDeltaInput {
  const oldVersion = "3.2.5";
  const newVersion = "3.2.6";
  const base = {
    ".github/scaffold.json": JSON.stringify({
      profile: "node",
      placeholders: { CURRENT_VERSION: oldVersion, BINARY: "kiro-provider" },
    }),
    ".release-please-manifest.json": JSON.stringify({ ".": oldVersion }),
    "changelog/CHANGELOG-v3.x.md":
      "# Changelog\n\n## [3.2.5](https://github.com/sunerpy/kiro-provider/compare/v3.2.4...v3.2.5) (2026-09-15)\n\nold notes\n",
    "package.json": JSON.stringify({ name: "@sunerpy/kiro-provider", version: oldVersion }),
  };
  const head = {
    ".github/scaffold.json": JSON.stringify({
      profile: "node",
      placeholders: { CURRENT_VERSION: newVersion, BINARY: "kiro-provider" },
    }),
    ".release-please-manifest.json": JSON.stringify({ ".": newVersion }),
    "changelog/CHANGELOG-v3.x.md":
      "# Changelog\n\n## [3.2.6](https://github.com/sunerpy/kiro-provider/compare/v3.2.5...v3.2.6) (2026-09-15)\n\n### Bug Fixes\n\n* **ci:** optimize\n\n## [3.2.5](https://github.com/sunerpy/kiro-provider/compare/v3.2.4...v3.2.5) (2026-09-15)\n\nold notes\n",
    "package.json": JSON.stringify({ name: "@sunerpy/kiro-provider", version: newVersion }),
  };
  return {
    title: "chore: release 3.2.6",
    changes: RELEASE_FILES.map((path) => ({ status: "M", path })),
    base,
    head,
    ...overrides,
  };
}

describe("validateReleasePrDelta", () => {
  test("accepts the exact release-please metadata delta", () => {
    expect(validateReleasePrDelta(fixture())).toEqual({
      ok: true,
      oldVersion: "3.2.5",
      newVersion: "3.2.6",
    });
  });

  test("rejects an extra source change", () => {
    const input = fixture();
    const result = validateReleasePrDelta({
      ...input,
      changes: [...input.changes, { status: "M", path: "src/index.ts" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("changed files must be exactly");
  });

  test("rejects non-version package metadata changes", () => {
    const input = fixture();
    const packageJson = JSON.parse(input.head["package.json"]);
    packageJson.description = "smuggled change";
    const result = validateReleasePrDelta({
      ...input,
      head: { ...input.head, "package.json": JSON.stringify(packageJson) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("package.json may change only version");
  });

  test("rejects rewritten changelog history", () => {
    const input = fixture();
    const result = validateReleasePrDelta({
      ...input,
      head: {
        ...input.head,
        "changelog/CHANGELOG-v3.x.md": input.head["changelog/CHANGELOG-v3.x.md"].replace(
          "old notes",
          "rewritten notes",
        ),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("existing history changed");
  });

  test("rejects inconsistent versions", () => {
    const input = fixture();
    const result = validateReleasePrDelta({
      ...input,
      head: {
        ...input.head,
        ".release-please-manifest.json": JSON.stringify({ ".": "3.2.7" }),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("must equal 3.2.6");
  });
});
