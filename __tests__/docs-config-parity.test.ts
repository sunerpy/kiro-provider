import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { CONFIG_ENV_VARIABLES } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";

const ALL_CONFIG_FIELDS = Object.keys(ConfigSchema.shape).sort();

const NON_SECRET_CONFIG_FIELDS = Object.keys(ConfigSchema.shape).filter(
  (field) => field !== "api_keys" && field !== "test_upstream_endpoint",
);

const CONFIGURATION_DOCS: Array<{ label: string; url: URL }> = [
  { label: "docs/CONFIGURATION.md", url: new URL("../docs/CONFIGURATION.md", import.meta.url) },
  {
    label: "docs/readme/CONFIGURATION.zh.md",
    url: new URL("../docs/readme/CONFIGURATION.zh.md", import.meta.url),
  },
];

type FieldRow = { readonly field: string; readonly envName: string | undefined };

/**
 * Extracts `| \`field\` | type | \`ENV\` | description |` rows from the field
 * reference table. Cells are split on unescaped pipes so `\|` inside enum
 * types does not shift the columns.
 */
function parseFieldTable(markdown: string): FieldRow[] {
  const rows: FieldRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const fieldMatch = /^`([a-z_]+)`$/.exec(cells[1] ?? "");
    if (!fieldMatch || cells.length < 5) continue;
    const envMatch = /`(KIRO_PROVIDER_[A-Z0-9_]+)`/.exec(cells[3] ?? "");
    rows.push({ field: fieldMatch[1] as string, envName: envMatch?.[1] });
  }
  return rows;
}

describe("config.example.json", () => {
  test("parses with ConfigSchema", () => {
    // Given
    const rawExample: unknown = JSON.parse(
      readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
    );

    // When
    const parsed = ConfigSchema.safeParse(rawExample);

    // Then
    expect(parsed.success).toBe(true);
  });

  test("matches the schema defaults for every non-secret field", () => {
    const rawExample = z
      .record(z.unknown())
      .parse(JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8")));
    const defaults = ConfigSchema.parse({ api_keys: ["sk-test"] }) as Record<string, unknown>;

    for (const field of NON_SECRET_CONFIG_FIELDS) {
      expect({ field, value: rawExample[field] }).toEqual({ field, value: defaults[field] });
    }
  });

  test("documents every non-secret schema field", () => {
    // Given
    const rawExample: unknown = JSON.parse(
      readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
    );
    const example = z.record(z.unknown()).parse(rawExample);

    // When
    const documentedFields = NON_SECRET_CONFIG_FIELDS.filter((field) => field in example);

    // Then
    expect(documentedFields).toEqual(NON_SECRET_CONFIG_FIELDS);
  });

  test("omits the test-only upstream endpoint", () => {
    // Given
    const rawExample: unknown = JSON.parse(
      readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
    );
    const example = z.record(z.unknown()).parse(rawExample);

    // When
    const containsTestEndpoint = "test_upstream_endpoint" in example;

    // Then
    expect(containsTestEndpoint).toBe(false);
  });
});

describe("environment variable table", () => {
  test("maps every schema field to exactly one KIRO_PROVIDER_* variable", () => {
    const fields = CONFIG_ENV_VARIABLES.map(({ field }) => field as string).sort();
    expect(fields).toEqual(ALL_CONFIG_FIELDS);
    const envNames = CONFIG_ENV_VARIABLES.map(({ env }) => env);
    expect(new Set(envNames).size).toBe(envNames.length);
    for (const envName of envNames) expect(envName).toMatch(/^KIRO_PROVIDER_[A-Z0-9_]+$/);
  });
});

describe.each(CONFIGURATION_DOCS)("$label field reference", ({ url }) => {
  const rows = parseFieldTable(readFileSync(url, "utf8"));

  test("documents every schema field exactly once and nothing else", () => {
    const documented = rows.map(({ field }) => field);
    expect([...documented].sort()).toEqual(ALL_CONFIG_FIELDS);
    expect(new Set(documented).size).toBe(documented.length);
  });

  test("names the same environment variable as the loader for every field", () => {
    const expected = new Map(CONFIG_ENV_VARIABLES.map(({ field, env }) => [field as string, env]));
    for (const row of rows) {
      expect({ field: row.field, env: row.envName }).toEqual({
        field: row.field,
        env: expected.get(row.field),
      });
    }
  });
});
