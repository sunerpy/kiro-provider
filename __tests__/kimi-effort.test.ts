import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import {
  buildEffortRequestFields,
  buildThinkingRequestFields,
  resolveEffectiveEffort,
  resolveEffort,
  supportsEffort,
  supportsXHighEffort,
} from "../src/kiro/effort.js";
import { modelCatalogFromAvailableModels } from "../src/kiro/model-catalog.js";
import { registerDynamicWireModels } from "../src/kiro/models.js";
import type { Effort } from "../src/kiro/types.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { normalizeResponsesRequest } from "../src/server/responses/request-policy.js";
import { handleModels } from "../src/server/routes/models.js";

const model = "kimi-k3";
registerDynamicWireModels([model]);

describe("Kimi K3 evidenced effort schema", () => {
  test("supports reasoning without inheriting the GPT five-level capability", () => {
    expect(supportsEffort(model)).toBe(true);
    expect(supportsXHighEffort(model)).toBe(false);
    expect(buildThinkingRequestFields(model, true, "omitted")).toBeUndefined();
  });

  test.each(["low", "high", "max"] as const)("projects %s to Kiro reasoning.effort", (effort) => {
    expect(resolveEffort(model, effort)).toBe(effort);
    expect(buildEffortRequestFields(model, effort)).toEqual({ reasoning: { effort } });
  });

  test.each(["medium", "xhigh"] as const)("does not clamp or accept unsupported %s", (effort) => {
    expect(resolveEffort(model, effort)).toBeUndefined();
    expect(() => buildEffortRequestFields(model, effort)).toThrow();
    expect(() =>
      resolveEffectiveEffort({ model, think: true, budget: 20000, reasoningEffort: effort }),
    ).toThrow();
  });

  test.each([false, true])(
    "uses max by default regardless of synthetic budget (think=%s)",
    (think) => {
      for (const budget of [8192, 16384, 20000, 24576, 32768]) {
        expect(resolveEffectiveEffort({ model, think, budget })).toBe("max");
      }
    },
  );

  test("keeps explicit request precedence and rejects an incompatible configured effort", () => {
    expect(
      resolveEffectiveEffort({
        model,
        think: true,
        budget: 20000,
        reasoningEffort: "low",
        configEffort: "max",
        requestFirst: true,
      }),
    ).toBe("low");
    expect(() =>
      resolveEffectiveEffort({ model, think: false, budget: 20000, configEffort: "medium" }),
    ).toThrow();
  });

  test.each(["none", "minimal", "medium", "xhigh"])(
    "rejects explicit %s before route selection",
    async (effort) => {
      for (const fidelity of ["compatible", "strict"] as const) {
        const result = normalizeResponsesRequest(
          { model, input: "Synthetic request.", reasoning: { effort } },
          ConfigSchema.parse({
            api_keys: ["synthetic-kimi-key"],
            responses_fidelity_mode: fidelity,
          }),
        );
        expect(result).toBeInstanceOf(Response);
        if (!(result instanceof Response)) throw new Error("Expected typed effort rejection");
        expect(result.status).toBe(400);
        const payload = (await result.json()) as { error: { code: string; param: string } };
        expect(payload.error).toMatchObject({
          code: "unsupported_reasoning_effort",
          param: "reasoning.effort",
        });
      }
    },
  );

  test("lists exactly three levels and the upstream max default in both catalogs", async () => {
    const catalog = modelCatalogFromAvailableModels([
      {
        modelId: model,
        modelName: "Kimi K3",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 131072 },
      },
    ]);
    const result = (await handleModels({
      modelCapabilities: { catalog: () => catalog } as never,
    }).json()) as {
      models: {
        slug: string;
        supported_reasoning_levels: { effort: Effort }[];
        default_reasoning_level: string | null;
        output_limit: number;
        multi_agent_version?: string;
      }[];
    };
    const entry = result.models.find((value) => value.slug === model);
    if (!entry) throw new Error("Expected K3 in the client catalog");
    expect(entry.supported_reasoning_levels.map((value) => value.effort)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(entry.default_reasoning_level).toBe("max");
    expect(entry.output_limit).toBe(131072);
    expect(entry.multi_agent_version).toBeUndefined();
  });

  test.each([
    { type: "disabled" },
    { type: "enabled", budget_tokens: 16384 },
    { type: "adaptive", display: "omitted" },
  ])("rejects unsupported K3 thinking controls: %j", (thinking) => {
    const result = adaptAnthropicMessagesRequest({
      model,
      messages: [{ role: "user", content: "Synthetic request." }],
      thinking,
    });
    expect(result.ok).toBe(false);
  });
});
