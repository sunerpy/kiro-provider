import { describe, expect, test } from "bun:test";
import type { KiroAvailableModel } from "../src/kiro/management-client.js";
import {
  EXPECTED_PUBLIC_MODEL_IDS,
  MODEL_CATALOG,
  modelCatalogFromAvailableModels,
} from "../src/kiro/model-catalog.js";
import { resolveModelVariant } from "../src/kiro/models.js";

const LEGACY_ONLY_MODEL_IDS = [
  "claude-3-7-sonnet",
  "nova-swe",
  "gpt-oss-120b",
  "minimax-m2",
  "kimi-k2-thinking",
] as const;

describe("MODEL_CATALOG", () => {
  test("contains exactly the frozen public model id set in both directions", () => {
    const catalogIds = new Set(MODEL_CATALOG.map(({ id }) => id));
    const expectedIds = new Set<string>(EXPECTED_PUBLIC_MODEL_IDS);

    expect(MODEL_CATALOG).toHaveLength(EXPECTED_PUBLIC_MODEL_IDS.length);
    expect([...catalogIds].sort()).toEqual([...expectedIds].sort());
    expect([...catalogIds].filter((id) => !expectedIds.has(id))).toEqual([]);
    expect([...expectedIds].filter((id) => !catalogIds.has(id))).toEqual([]);
  });

  test("maps every public id to its declared wire id", () => {
    for (const entry of MODEL_CATALOG) {
      expect(resolveModelVariant(entry.id).wireId).toBe(entry.wireId);
    }
  });

  test("provides numeric context and output limits for every entry", () => {
    for (const entry of MODEL_CATALOG) {
      expect(Number.isFinite(entry.contextLimit)).toBe(true);
      expect(entry.contextLimit).toBeGreaterThan(0);
      expect(Number.isFinite(entry.outputLimit)).toBe(true);
      expect(entry.outputLimit).toBeGreaterThan(0);
    }
  });

  test("advertises the probe-backed Opus 5 family with exact limits", () => {
    const opus5 = MODEL_CATALOG.filter(
      ({ id }) => id === "claude-opus-5" || id.startsWith("claude-opus-5-"),
    );

    expect(opus5.map(({ id }) => id)).toEqual([
      "claude-opus-5",
      "claude-opus-5-low",
      "claude-opus-5-medium",
      "claude-opus-5-high",
      "claude-opus-5-xhigh",
      "claude-opus-5-max",
    ]);
    for (const entry of opus5) {
      expect(entry.wireId).toBe("claude-opus-5");
      expect(entry.contextLimit).toBe(1_000_000);
      expect(entry.outputLimit).toBe(128_000);
    }
  });

  test("advertises every GPT 5.6 family with an 872k prompt limit", () => {
    for (const family of ["sol", "terra", "luna"]) {
      const wireId = `gpt-5.6-${family}`;
      const entries = MODEL_CATALOG.filter(
        ({ id }) => id === wireId || id.startsWith(`${wireId}-`),
      );

      expect(entries).toHaveLength(6);
      for (const entry of entries) {
        expect(entry.wireId).toBe(wireId);
        expect(entry.contextLimit).toBe(872_000);
        expect(entry.outputLimit).toBe(128_000);
      }
    }
  });

  test("corrects the known stale GPT 5.6 family management metadata", () => {
    const available = [
      {
        modelId: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
        description: "Old 272k description",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 272_000, maxOutputTokens: 128_000 },
      },
      {
        modelId: "gpt-5.6-terra",
        modelName: "GPT 5.6 Terra",
        description: "Old Terra 272k description",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 272_000, maxOutputTokens: 128_000 },
      },
      {
        modelId: "gpt-5.6-luna",
        modelName: "GPT 5.6 Luna",
        description: "Old Luna 272k description",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 272_000, maxOutputTokens: 128_000 },
      },
      {
        modelId: "future-model",
        modelName: "Future Model",
        description: "Unrelated 272k description",
        supportedInputTypes: ["TEXT"],
        tokenLimits: { maxInputTokens: 272_000, maxOutputTokens: 128_000 },
      },
    ] satisfies readonly KiroAvailableModel[];

    const catalog = modelCatalogFromAvailableModels(available);
    for (const family of ["sol", "terra", "luna"]) {
      const entries = catalog.filter(({ wireId }) => wireId === `gpt-5.6-${family}`);
      expect(entries).toHaveLength(6);
      for (const entry of entries) {
        expect(entry.contextLimit).toBe(872_000);
        expect(entry.outputLimit).toBe(128_000);
        expect(entry.description).toContain("1M total context window");
      }
    }
    expect(catalog.find(({ wireId }) => wireId === "future-model")).toMatchObject({
      contextLimit: 272_000,
      outputLimit: 128_000,
      description: "Unrelated 272k description",
    });
  });

  test("does not expose legacy or wire-only model ids", () => {
    const catalogIds = new Set(MODEL_CATALOG.map(({ id }) => id));

    for (const legacyId of LEGACY_ONLY_MODEL_IDS) {
      expect(catalogIds.has(legacyId)).toBe(false);
    }
  });
});
