import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getModelContextLimit, MODEL_MAPPING, SUPPORTED_MODELS } from "../src/kiro/constants.js";
import type { KiroAvailableModel } from "../src/kiro/management-client.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import {
  EXPECTED_PUBLIC_MODEL_IDS,
  MODEL_CATALOG,
  modelCatalogFromAvailableModels,
} from "../src/kiro/model-catalog.js";
import {
  clearDynamicModelRegistry,
  getContextWindowSize,
  isFable51Model,
  isGpt56Model,
  isKnownModel,
  resolveModelVariant,
  supportsReasoningPrefixOmission,
} from "../src/kiro/models.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import { handleModels } from "../src/server/routes/models.js";
import { parsedResponses, TEST_AUTH } from "./canonical-test-helpers.js";

const MODEL = "kimi-k3";
// Sanitized metadata from the authenticated Kiro ListAvailableModels response.
// This is Kiro's nested reasoning.effort schema, not Moonshot's native API.
const AVAILABLE: KiroAvailableModel = {
  modelId: MODEL,
  modelName: "Kimi K3",
  supportedInputTypes: ["TEXT", "IMAGE"],
  tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 131_072 },
  rateMultiplier: 2.4,
  additionalModelRequestFieldsSchema: {
    type: "object",
    properties: {
      reasoning: {
        type: "object",
        properties: { effort: { type: "string", enum: ["low", "high", "max"], default: "max" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

beforeEach(() => clearDynamicModelRegistry());
afterEach(() => clearDynamicModelRegistry());

describe("Kimi K3 exact identity and static fallback", () => {
  test("is known before dynamic discovery with its own wire identity and 1M window", () => {
    expect(isKnownModel(MODEL)).toBe(true);
    expect(MODEL_MAPPING[MODEL]).toBe(MODEL);
    expect(SUPPORTED_MODELS).toContain(MODEL);
    expect(resolveModelVariant(MODEL)).toEqual({ wireId: MODEL, effort: undefined });
    expect(getModelContextLimit(MODEL)).toBe(1_000_000);
    expect(getContextWindowSize(MODEL)).toBe(1_000_000);
    expect(isFable51Model(MODEL)).toBe(false);
    expect(isGpt56Model(MODEL)).toBe(false);
    expect(supportsReasoningPrefixOmission(MODEL)).toBe(false);
  });

  test("advertises only the exact base and the evidenced metadata in static model listings", async () => {
    expect(EXPECTED_PUBLIC_MODEL_IDS as readonly string[]).toContain(MODEL);
    expect(MODEL_CATALOG.filter(({ wireId }) => wireId === MODEL)).toEqual([
      {
        id: MODEL,
        wireId: MODEL,
        name: "Kimi K3 (2.4x)",
        contextLimit: 1_000_000,
        outputLimit: 131_072,
        rateMultiplier: 2.4,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    ]);
    const capabilities = new ModelCapabilityService(
      {
        dynamic_model_catalog: false,
        model_catalog_ttl_ms: 60_000,
        model_catalog_stale_ttl_ms: 86_400_000,
        model_catalog_request_timeout_ms: 1_000,
        proxy_url: null,
      },
      async () => {
        throw new Error("A static listing must not call an upstream service");
      },
    );
    const response = handleModels({ modelCapabilities: capabilities });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
      models: Array<Record<string, unknown>>;
    };
    expect(body.data.filter(({ id }) => String(id).startsWith("kimi-"))).toEqual([
      expect.objectContaining({
        id: MODEL,
        context_limit: 1_000_000,
        output_limit: 131_072,
        rate_multiplier: 2.4,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    ]);
    expect(body.models.filter(({ slug }) => String(slug).startsWith("kimi-"))).toEqual([
      expect.objectContaining({
        slug: MODEL,
        context_window: 1_000_000,
        max_context_window: 1_000_000,
        auto_compact_token_limit: 900_000,
        input_modalities: ["text", "image"],
      }),
    ]);
  });

  test("merges live Kiro metadata without inventing public effort suffixes", () => {
    const [entry] = modelCatalogFromAvailableModels([AVAILABLE]);
    expect(entry).toMatchObject({
      id: MODEL,
      wireId: MODEL,
      contextLimit: 1_000_000,
      outputLimit: 131_072,
      rateMultiplier: 2.4,
      modalities: { input: ["text", "image"], output: ["text"] },
      additionalModelRequestFieldsSchema: AVAILABLE.additionalModelRequestFieldsSchema,
    });
    const changed = modelCatalogFromAvailableModels([
      {
        ...AVAILABLE,
        description: "Synthetic updated Kiro metadata",
        tokenLimits: { maxInputTokens: 900_000, maxOutputTokens: 120_000 },
        rateMultiplier: 2.5,
        supportedInputTypes: ["TEXT"],
      },
    ]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: MODEL,
      wireId: MODEL,
      contextLimit: 900_000,
      outputLimit: 120_000,
      rateMultiplier: 2.5,
      description: "Synthetic updated Kiro metadata",
      modalities: { input: ["text"], output: ["text"] },
    });
  });

  test("static fallback never overrides a live account catalog that excludes K3", async () => {
    const capabilities = new ModelCapabilityService(
      {
        dynamic_model_catalog: true,
        model_catalog_ttl_ms: 60_000,
        model_catalog_stale_ttl_ms: 86_400_000,
        model_catalog_request_timeout_ms: 1_000,
        proxy_url: null,
      },
      async () => ({
        models: [{ ...AVAILABLE, modelId: "glm-5", modelName: "Other synthetic model" }],
      }),
    );
    const account: ManagedAccount = {
      id: "kimi-static-fallback-account",
      email: "kimi-fixture@example.invalid",
      authMethod: "desktop",
      region: "us-east-1",
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + 60_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
    };
    const availability = await capabilities.ensureAccountModel(account, TEST_AUTH, MODEL);
    expect(availability).toEqual({ supported: false, source: "live" });
    expect(capabilities.catalog().some(({ id }) => id === MODEL)).toBe(false);
    expect([...(capabilities.eligibleAccountIds(MODEL, [account.id]) ?? [])]).toEqual([]);
  });

  test.each(["low", "medium", "high", "xhigh", "max", "thinking", "1m"])(
    "rejects an unadvertised kimi-k3-%s alias rather than guessing its wire model",
    (suffix) => {
      expect(() => resolveModelVariant(`${MODEL}-${suffix}`)).toThrow("Unsupported model:");
    },
  );

  test("keeps the legacy K2 thinking alias separate and unadvertised", () => {
    expect(resolveModelVariant("kimi-k2-thinking")).toEqual({
      wireId: "MOONSHOT_KIMI_K2_THINKING",
      effort: undefined,
    });
    expect(MODEL_CATALOG.some(({ id }) => id === "kimi-k2-thinking")).toBe(false);
  });

  test("projects Responses tool-result images and history using the exact K3 wire model", () => {
    const imageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const result = adaptResponsesRequest(
      parsedResponses({
        model: MODEL,
        store: false,
        tools: [
          {
            type: "function",
            name: "lookup_image",
            description: "Read a synthetic fixture image",
            parameters: { type: "object", properties: {} },
          },
        ],
        input: [
          { role: "user", content: "Inspect the synthetic image" },
          {
            type: "function_call",
            call_id: "kimi_fixture_call",
            name: "lookup_image",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "kimi_fixture_call",
            output: [
              { type: "input_text", text: "Synthetic image result" },
              { type: "input_image", image_url: `data:image/png;base64,${imageBase64}` },
            ],
          },
          { role: "user", content: "Continue after the image" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prepared = transformToSdkRequest(result.body, MODEL, TEST_AUTH);
    expect(prepared.effectiveModel).toBe(MODEL);
    expect(prepared.conversationState.currentMessage.userInputMessage).toMatchObject({
      modelId: MODEL,
      content: "Continue after the image",
    });
    const history = prepared.conversationState.history ?? [];
    expect(history.flatMap((turn) => turn.assistantResponseMessage?.toolUses ?? [])).toEqual([
      { toolUseId: "kimi_fixture_call", name: "lookup_image", input: {} },
    ]);
    const results = history.flatMap(
      (turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [],
    );
    expect(results).toEqual([
      {
        toolUseId: "kimi_fixture_call",
        content: [{ text: "Synthetic image result" }],
        status: "success",
      },
    ]);
    const images = history.flatMap((turn) => turn.userInputMessage?.images ?? []);
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0]?.source.bytes ?? []).toString("base64")).toBe(imageBase64);
    expect(
      history.flatMap((turn) => (turn.userInputMessage ? [turn.userInputMessage.modelId] : [])),
    ).toEqual([MODEL, MODEL]);
  });
});
