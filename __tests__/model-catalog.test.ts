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
    // Keyed by wire id, not an id prefix: claude-opus-5-5* are a different
    // upstream model whose public ids would otherwise be captured here.
    const opus5 = MODEL_CATALOG.filter(({ wireId }) => wireId === "claude-opus-5");

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

  test("advertises the probe-backed Opus 5.5 preview family with exact limits", () => {
    const opus55 = MODEL_CATALOG.filter(({ wireId }) => wireId === "claude-opus-5.5");

    expect(opus55.map(({ id }) => id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
      "claude-opus-5-5-xhigh",
      "claude-opus-5-5-max",
    ]);
    for (const entry of opus55) {
      // The hyphenated public id keeps the dotted wire id, unlike plain Opus 5
      // whose two spellings coincide.
      expect(entry.wireId).toBe("claude-opus-5.5");
      expect(entry.contextLimit).toBe(1_000_000);
      // 2026-11-26: the live catalog lowered maxOutputTokens from 128,000.
      expect(entry.outputLimit).toBe(64_000);
      expect(entry.rateMultiplier).toBe(2);
      expect(entry.modalities.input).toContain("image");
    }
    expect(opus55.map(({ name }) => name)).toEqual([
      "Claude Opus 5.5 (2.0x)",
      "Claude Opus 5.5 (low) (2.0x)",
      "Claude Opus 5.5 (medium) (2.0x)",
      "Claude Opus 5.5 (high) (2.0x)",
      "Claude Opus 5.5 (xhigh) (2.0x)",
      "Claude Opus 5.5 (max) (2.0x)",
    ]);
  });

  test("expands the live dotted Opus 5.5 wire model into its public effort family", () => {
    // Before claude-opus-5.5 was catalogued, the live wire id fell through to the
    // dynamic branch and produced a single entry whose public id was the dotted
    // wire id, with no effort variants for Codex to offer.
    const entries = modelCatalogFromAvailableModels([
      {
        modelId: "claude-opus-5.5",
        modelName: "Claude Opus 5.5",
        description: "Experimental preview of Claude Opus 5.5 model with 1M context window",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
        rateMultiplier: 2,
        promptCaching: { supportsPromptCaching: true },
        additionalModelRequestFieldsSchema: {
          type: "object",
          properties: {
            output_config: {
              type: "object",
              properties: {
                effort: {
                  type: "string",
                  enum: ["low", "medium", "high", "xhigh", "max"],
                  default: "medium",
                },
              },
            },
            max_tokens: { type: "integer", minimum: 1024, maximum: 128000 },
          },
        },
      },
    ]);

    expect(entries.map(({ id }) => id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5-5-low",
      "claude-opus-5-5-medium",
      "claude-opus-5-5-high",
      "claude-opus-5-5-xhigh",
      "claude-opus-5-5-max",
    ]);
    for (const entry of entries) {
      expect(entry.wireId).toBe("claude-opus-5.5");
      expect(entry.contextLimit).toBe(1_000_000);
      expect(entry.outputLimit).toBe(128_000);
      expect(entry.rateMultiplier).toBe(2);
      expect(entry.promptCaching).toEqual({ supportsPromptCaching: true });
      expect(entry.description).toBe(
        "Experimental preview of Claude Opus 5.5 model with 1M context window",
      );
    }
    expect(entries[0]?.additionalModelRequestFieldsSchema).toMatchObject({
      properties: {
        output_config: {
          properties: { effort: { enum: ["low", "medium", "high", "xhigh", "max"] } },
        },
        max_tokens: { minimum: 1024, maximum: 128000 },
      },
    });
  });

  test("advertises the probe-backed Fable 5.1 preview with exact Kiro metadata", () => {
    expect(MODEL_CATALOG.find(({ id }) => id === "claude-fable-5-1")).toEqual({
      id: "claude-fable-5-1",
      wireId: "claude-fable-5.1",
      name: "Claude Fable 5.1 (6.0x)",
      description:
        "Experimental preview of Claude Fable 5.1 with 1M context window - AWS will retain inputs and outputs for automated abuse detection, and may perform human review of traffic flagged by our abuse detection mechanisms",
      contextLimit: 1_000_000,
      outputLimit: 128_000,
      rateMultiplier: 6,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
    expect(resolveModelVariant("claude-fable-5-1")).toEqual({
      wireId: "claude-fable-5.1",
      effort: undefined,
    });
  });

  test("maps the live dotted Fable wire model back to the stable public id", () => {
    const [fable] = modelCatalogFromAvailableModels([
      {
        modelId: "claude-fable-5.1",
        modelName: "Claude Fable 5.1",
        description: "live preview notice",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 },
        rateMultiplier: 6,
        promptCaching: { supportsPromptCaching: true },
        additionalModelRequestFieldsSchema: {
          type: "object",
          properties: { max_tokens: { type: "integer", minimum: 1024, maximum: 128000 } },
        },
      },
    ]);
    expect(fable).toMatchObject({
      id: "claude-fable-5-1",
      wireId: "claude-fable-5.1",
      name: "Claude Fable 5.1 (6.0x)",
      description: "live preview notice",
      contextLimit: 1_000_000,
      outputLimit: 128_000,
      rateMultiplier: 6,
      promptCaching: { supportsPromptCaching: true },
    });
    expect(fable?.additionalModelRequestFieldsSchema).toMatchObject({
      properties: { max_tokens: { minimum: 1024, maximum: 128000 } },
    });
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

describe("2026-11-26 Claude catalog additions", () => {
  const families = [
    { base: "claude-sonnet-5-5", wire: "claude-sonnet-5.5", label: "Claude Sonnet 5.5", rate: 1.3 },
    { base: "claude-haiku-5-5", wire: "claude-haiku-5.5", label: "Claude Haiku 5.5", rate: 0.06 },
  ] as const;
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

  for (const family of families)
    test(`advertises the probe-backed ${family.label} effort family`, () => {
      const entries = MODEL_CATALOG.filter(({ wireId }) => wireId === family.wire);
      expect(entries.map(({ id }) => id)).toEqual([
        family.base,
        ...efforts.map((effort) => `${family.base}-${effort}`),
      ]);
      const multiplier = `${family.rate === 1.3 ? "1.3" : "0.06"}x`;
      expect(entries.map(({ name }) => name)).toEqual([
        `${family.label} (${multiplier})`,
        ...efforts.map((effort) => `${family.label} (${effort}) (${multiplier})`),
      ]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          wireId: family.wire,
          contextLimit: 1_000_000,
          outputLimit: 64_000,
          rateMultiplier: family.rate,
          modalities: { input: ["text", "image"], output: ["text"] },
        });
      }
      expect(resolveModelVariant(family.base)).toEqual({ wireId: family.wire, effort: undefined });
      expect(resolveModelVariant(`${family.base}-thinking`)).toEqual({
        wireId: family.wire,
        effort: undefined,
      });
      expect(resolveModelVariant(`${family.base}-xhigh`)).toEqual({
        wireId: family.wire,
        effort: "xhigh",
      });
    });

  test("advertises the Fable 5.2 preview as one entry with its retention notice", () => {
    expect(MODEL_CATALOG.filter(({ wireId }) => wireId === "claude-fable-5.2")).toEqual([
      {
        id: "claude-fable-5-2",
        wireId: "claude-fable-5.2",
        name: "Claude Fable 5.2 (6.0x)",
        description:
          "Experimental preview of Claude Fable 5.2 with 1M context window - AWS will retain inputs and outputs for automated abuse detection, and may perform human review of traffic flagged by our abuse detection mechanisms",
        contextLimit: 1_000_000,
        outputLimit: 64_000,
        rateMultiplier: 6,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    ]);
    // Effort aliases still resolve although only the base is listed.
    expect(resolveModelVariant("claude-fable-5-2-max")).toEqual({
      wireId: "claude-fable-5.2",
      effort: "max",
    });
  });

  test("never parses the 5.5 or 5.2 ids as variants of an older base", () => {
    expect(resolveModelVariant("claude-sonnet-5-5").wireId).not.toBe("claude-sonnet-5");
    expect(resolveModelVariant("claude-sonnet-5").wireId).toBe("claude-sonnet-5");
    expect(resolveModelVariant("claude-fable-5-2").wireId).not.toBe("claude-fable-5.1");
    expect(() => resolveModelVariant("claude-haiku-4-5-high")).toThrow("Unsupported model");
  });

  test("expands the live dotted wire ids into their stable public entries", () => {
    const schema = (thinkingTypes: readonly string[], effortDefault: string) => ({
      type: "object",
      properties: {
        thinking: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: thinkingTypes },
            display: { type: "string", enum: ["summarized", "omitted"] },
          },
          required: ["type"],
        },
        output_config: {
          type: "object",
          properties: {
            effort: {
              type: "string",
              enum: ["low", "medium", "high", "xhigh", "max"],
              default: effortDefault,
            },
          },
        },
        max_tokens: { type: "integer", minimum: 1024, maximum: 64000 },
      },
      additionalProperties: false,
    });
    const live = (
      modelId: string,
      modelName: string,
      rateMultiplier: number,
      thinkingTypes: readonly string[],
      effortDefault: string,
    ): KiroAvailableModel => ({
      modelId,
      modelName,
      description: `${modelName} model with 1M context window`,
      supportedInputTypes: ["TEXT", "IMAGE"],
      tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
      rateMultiplier,
      promptCaching: { supportsPromptCaching: true },
      additionalModelRequestFieldsSchema: schema(thinkingTypes, effortDefault),
    });
    const entries = modelCatalogFromAvailableModels([
      live("claude-fable-5.2", "Claude Fable 5.2", 6, ["adaptive"], "high"),
      live("claude-sonnet-5.5", "Claude Sonnet 5.5", 1.3, ["adaptive", "between_tools"], "high"),
      live("claude-haiku-5.5", "Claude Haiku 5.5", 0.06, ["adaptive", "disabled"], "medium"),
    ]);

    expect(entries.map(({ id }) => id)).toEqual([
      "claude-fable-5-2",
      "claude-sonnet-5-5",
      ...efforts.map((effort) => `claude-sonnet-5-5-${effort}`),
      "claude-haiku-5-5",
      ...efforts.map((effort) => `claude-haiku-5-5-${effort}`),
    ]);
    expect(entries.some(({ id }) => id.includes("."))).toBe(false);
    for (const entry of entries) {
      expect(entry.contextLimit).toBe(1_000_000);
      expect(entry.outputLimit).toBe(64_000);
      expect(entry.promptCaching).toEqual({ supportsPromptCaching: true });
      expect(entry.modalities.input).toEqual(["text", "image"]);
    }
    expect(entries[0]?.name).toBe("Claude Fable 5.2 (6.0x)");
    expect(entries.find(({ id }) => id === "claude-haiku-5-5")?.rateMultiplier).toBe(0.06);
  });
});
