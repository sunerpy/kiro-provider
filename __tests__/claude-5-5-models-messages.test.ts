import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { MESSAGES_FIXTURE_KEY, messagesFixture } from "./messages-regression-helpers.js";

// Wire ids, effort enum, display controls and max_tokens acceptance come from
// docs/audits/claude-5-5-models-catalog-probe-2026-11-26.zh.md.
const MODELS = [
  { model: "claude-fable-5-2", wire: "claude-fable-5.2" },
  { model: "claude-sonnet-5-5", wire: "claude-sonnet-5.5" },
  { model: "claude-haiku-5-5", wire: "claude-haiku-5.5" },
] as const;
const signature = "fixture-claude-5-5-signature";
const messages = [{ role: "user", content: "Synthetic Claude 5.5 catalog fixture." }];
const databases: AccountsDatabase[] = [];
let audit: ReturnType<typeof captureAuditEvents>;

beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  for (const database of databases.splice(0)) database.close();
});

function fixture(events: readonly SdkStreamEvent[], overrides: Partial<Config> = {}) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY],
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 17).toString("base64url")}`],
    reasoning_replay_token_format: "portable-v2",
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  return messagesFixture(events, {
    config: {
      reasoning_replay_keys: config.reasoning_replay_keys,
      reasoning_replay_token_format: config.reasoning_replay_token_format,
      ...overrides,
    },
    dependencies: {
      reasoningReplayStore: new ReasoningReplayStore(database, config),
      affinityStore: database,
    },
  });
}

describe("Claude Fable 5.2, Sonnet 5.5 and Haiku 5.5 over Messages", () => {
  for (const { model, wire } of MODELS) {
    test(`projects adaptive omitted thinking, effort and max_tokens to ${wire}`, async () => {
      const f = fixture([
        { reasoningContentEvent: { text: "", signature } },
        { assistantResponseEvent: { content: "NEW_MODEL_OK" } },
      ]);
      const response = await f.request({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "xhigh" },
        messages,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        content: Array<{ type: string; thinking?: string; signature?: string; text?: string }>;
      };
      expect(f.inputs).toHaveLength(1);
      expect(f.inputs[0]?.conversationState?.currentMessage?.userInputMessage?.modelId).toBe(wire);
      expect(f.inputs[0]?.additionalModelRequestFields).toEqual({
        max_tokens: 4096,
        output_config: { effort: "xhigh" },
        thinking: { type: "adaptive", display: "omitted" },
      });
      expect(body.content[0]).toMatchObject({ type: "thinking", thinking: "" });
      // Omitted display replays through the provider token, never the raw signature.
      expect(body.content[0]?.signature).toBeString();
      expect(body.content[0]?.signature).not.toBe(signature);
      expect(body.content.at(-1)).toMatchObject({ type: "text", text: "NEW_MODEL_OK" });
    });

    test(`forwards an explicit summarized display to ${wire}`, async () => {
      const f = fixture([
        { reasoningContentEvent: { text: "Synthetic summary.", signature } },
        { assistantResponseEvent: { content: "SUMMARY_OK" } },
      ]);
      const response = await f.request({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        messages,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        content: Array<{ type: string; thinking?: string }>;
      };
      expect(f.inputs[0]?.additionalModelRequestFields).toEqual({
        max_tokens: 4096,
        output_config: { effort: "high" },
        thinking: { type: "adaptive", display: "summarized" },
      });
      expect(body.content[0]).toMatchObject({ type: "thinking", thinking: "Synthetic summary." });
    });

    test(`keeps the operator summarized recovery away from ${wire}`, async () => {
      // anthropic_thinking_display_mode is validated only for Fable 5.1 and Opus 5.5.
      const f = fixture(
        [
          { reasoningContentEvent: { text: "Synthetic summary.", signature } },
          { assistantResponseEvent: { content: "SUMMARY_KEPT" } },
        ],
        { anthropic_thinking_display_mode: "omitted" },
      );
      const response = await f.request({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        messages,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
      const body = (await response.json()) as { content: Array<{ thinking?: string }> };
      expect(f.inputs[0]?.additionalModelRequestFields).toMatchObject({
        thinking: { type: "adaptive", display: "summarized" },
      });
      expect(body.content[0]?.thinking).toBe("Synthetic summary.");
      expect(audit.events("anthropic_thinking_display_overridden")).toHaveLength(0);
    });

    test(`keeps conflicting empty signed prefixes fatal for ${wire}`, async () => {
      // The bounded omission recovery is validated only for Fable 5.1 and Opus 5.5.
      const f = fixture(
        [
          { reasoningContentEvent: { text: "", signature: "fixture-conflict-a" } },
          { reasoningContentEvent: { signature: "fixture-conflict-b" } },
          { assistantResponseEvent: { content: "MUST_NOT_PUBLISH" } },
        ],
        { anthropic_thinking_display_mode: "omitted" },
      );
      const response = await f.request({
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
        messages,
      });

      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain("conflicting reasoning signatures");
      expect(text).not.toContain("MUST_NOT_PUBLISH");
      expect(response.headers.get("x-kiro-reasoning-replay-mode")).toBeNull();
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    });
  }

  test("projects an explicit thinking disable only to the schema that declares it", async () => {
    for (const [model, thinking] of [
      ["claude-haiku-5-5", { thinking: { type: "disabled" } }],
      ["claude-sonnet-5-5", {}],
      ["claude-fable-5-2", {}],
    ] as const) {
      const f = fixture([{ assistantResponseEvent: { content: "DISABLED_OK" } }]);
      const response = await f.request({
        model,
        max_tokens: 2048,
        thinking: { type: "disabled" },
        output_config: { effort: "high" },
        messages,
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(f.inputs[0]?.additionalModelRequestFields).toEqual({
        max_tokens: 2048,
        output_config: { effort: "high" },
        ...thinking,
      });
    }
  });

  test("rejects unrepresentable displays and limits before dispatch", async () => {
    const f = fixture([]);
    for (const [body, message] of [
      [
        { model: "claude-opus-5", thinking: { type: "adaptive", display: "summarized" } },
        "capability_rejected:thinking.display: summarized",
      ],
      [
        { model: "claude-sonnet-5-5", thinking: { type: "adaptive", display: "updates" } },
        "capability_rejected:thinking.display: updates",
      ],
      [{ model: "claude-haiku-5-5", max_tokens: 1023 }, "output-token limits"],
      [{ model: "claude-fable-5-2", max_tokens: 128_001 }, "output-token limits"],
    ] as const) {
      const response = await f.request({ messages, ...body });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(message);
    }
    expect(f.inputs).toHaveLength(0);
  });
});
