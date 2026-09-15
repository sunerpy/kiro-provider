import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as T;
}

describe("release metadata", () => {
  test("keeps package, manifest, and scaffold versions aligned", () => {
    const packageMetadata = readJson<{ version: string }>("package.json");
    const manifest = readJson<Record<string, string>>(".release-please-manifest.json");
    const scaffold = readJson<{ placeholders: { CURRENT_VERSION: string } }>(
      ".github/scaffold.json",
    );

    expect(manifest["."]).toBe(packageMetadata.version);
    expect(scaffold.placeholders.CURRENT_VERSION).toBe(packageMetadata.version);
  });

  test("makes release-please own the scaffold version", () => {
    const releaseConfig = readJson<{
      packages: Record<string, { "extra-files"?: unknown[] }>;
    }>("release-please-config.json");

    expect(releaseConfig.packages["."]?.["extra-files"]).toContainEqual({
      type: "json",
      path: ".github/scaffold.json",
      jsonpath: "$.placeholders.CURRENT_VERSION",
    });
  });
});
