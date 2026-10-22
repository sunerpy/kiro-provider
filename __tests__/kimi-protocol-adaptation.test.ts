import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accountQueueDepth } from "../src/core/pipeline-runtime.js";
import type { KiroAvailableModel } from "../src/kiro/management-client.js";
import { ModelCapabilityService } from "../src/kiro/model-capabilities.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { CanonicalRequest } from "../src/protocol/canonical.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { checkApiKey } from "../src/server/auth-gate.js";
import type { ResponseStateObject } from "../src/server/responses/state.js";
import { SqliteResponseStore } from "../src/server/responses/store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";
import { nativeResponse } from "./responses-fidelity-helpers.js";

// Sanitized ListAvailableModels shape observed on 2026-10-21. Output capacity
// does not establish an additionalModelRequestFields.max_tokens capability.
const K3_MODEL: KiroAvailableModel = {
  modelId: "kimi-k3",
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
const REASONING = "Synthetic K3 reasoning";
const SIGNATURE = "synthetic-k3-signature";
const CALL_ID = "synthetic_k3_call";
const TOOL = {
  type: "function",
  name: "synthetic_lookup",
  description: "Read a synthetic value",
  parameters: { type: "object", properties: { value: { type: "number" } } },
};
const USER = { role: "user" as const, content: "Read the synthetic value" };
const DONE: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a synthetic object");
  }
  return value as ObjectValue;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 1_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(2);
  expect(check()).toBe(true);
}

const databases: AccountsDatabase[] = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  for (const database of databases.splice(0)) database.close();
});

async function gateway(
  options: {
    strict?: boolean;
    unsigned?: boolean;
    tools?: boolean;
    late?: boolean;
    conflict?: boolean;
    broken?: boolean;
    signatureOnly?: boolean;
    cleanup?: ReturnType<typeof deferred>;
  } = {},
) {
  const state = { closed: 0, nativeCalls: 0, cleanupStarted: false, cleanupFinished: false };
  const f = messagesFixture([], {
    config: {
      protocol_projection_mode: "v3-auto",
      dynamic_model_catalog: true,
      responses_fidelity_mode: options.strict ? "strict" : "compatible",
      responses_thinking_display_mode: "omitted",
      reasoning_replay_keys: [`kimi-fixture:${Buffer.alloc(32, 27).toString("base64url")}`],
      stream_max_attempts: 3,
      rate_limit_max_retries: 3,
      rate_limit_retry_delay_ms: 1,
      account_inference_concurrency: 1,
      max_inflight_requests: 1,
    },
    stream: async function* () {
      try {
        if (!options.signatureOnly) yield { reasoningContentEvent: { text: REASONING } };
        if (!options.unsigned && !options.late) {
          yield { reasoningContentEvent: { signature: SIGNATURE } };
        }
        // An upstream EOF without the completion witness is a typed truncation,
        // after non-empty canonical reasoning has already been accepted.
        if (options.broken) return;
        if (options.conflict) {
          yield { reasoningContentEvent: { signature: "synthetic-k3-conflicting-signature" } };
        }
        if (options.tools && f.inputs.length === 1) {
          yield {
            toolUseEvent: {
              toolUseId: CALL_ID,
              name: TOOL.name,
              input: '{"value":41}',
              stop: true,
            },
          };
        } else yield { assistantResponseEvent: { content: "K3_SYNTHETIC_OK" } };
        if (!options.unsigned && options.late) {
          yield { reasoningContentEvent: { signature: SIGNATURE } };
          yield { reasoningContentEvent: { signature: SIGNATURE } };
        }
        yield DONE;
      } finally {
        state.cleanupStarted = true;
        await options.cleanup?.promise;
        state.cleanupFinished = true;
        state.closed++;
      }
    },
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const account = f.dependencies.accountManager.reconcileFromDb()[0];
  if (!account) throw new Error("Expected one synthetic account");
  let catalogCalls = 0;
  const capabilities = new ModelCapabilityService(f.config, async () => {
    catalogCalls++;
    return { models: [K3_MODEL], defaultModelId: K3_MODEL.modelId };
  });
  await capabilities.refreshAccounts([account], f.dependencies.accountManager.toAuthDetails);
  const store = new ReasoningReplayStore(database, f.config);
  const responseStore = new SqliteResponseStore(database);
  const preferredAccounts: (string | undefined)[] = [];
  const app = createApp(f.config, {
    ...f.dependencies,
    accountManager: {
      ...f.dependencies.accountManager,
      selectHealthyAccount(preferred) {
        preferredAccounts.push(preferred);
        return account;
      },
    },
    affinityStore: database,
    reasoningReplayStore: store,
    responseStore,
    modelCapabilities: capabilities,
    nativeResponsesFetch: async () => {
      state.nativeCalls++;
      throw new Error("Synthetic native transport must not dispatch in this fixture");
    },
  });
  const post = (
    extra: ObjectValue = {},
    init: { key?: string; signal?: AbortSignal; path?: string } = {},
  ) =>
    app(
      new Request(`http://fixture${init.path ?? "/v1/responses"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${init.key ?? MESSAGES_FIXTURE_KEY}`,
        },
        body: JSON.stringify({
          model: K3_MODEL.modelId,
          store: false,
          stream: false,
          input: [USER],
          include: ["reasoning.encrypted_content"],
          ...(options.tools ? { tools: [TOOL] } : {}),
          ...extra,
        }),
        signal: init.signal,
      }),
    );
  return {
    ...f,
    app,
    post,
    account,
    database,
    store,
    capabilities,
    state,
    catalogCalls: () => catalogCalls,
    preferredAccounts,
    responseStore,
  };
}

async function responseState(response: Response, stream: boolean): Promise<ObjectValue> {
  const wire = await response.text();
  expect(wire).not.toContain(SIGNATURE);
  expect(wire).not.toContain("synthetic-k3-conflicting-signature");
  if (!stream) return object(JSON.parse(wire));
  const events = messagesSseEvents(wire);
  expect(events.at(-1)?.type).toBe("response.completed");
  return object(events.at(-1)?.response);
}
async function responseOutput(response: Response, stream: boolean): Promise<ObjectValue[]> {
  return (await responseState(response, stream)).output as ObjectValue[];
}

describe("Kimi K3 through authenticated Responses and Messages ingress", () => {
  for (const stream of [false, true]) {
    for (const store of [true, undefined]) {
      test(`K3 default/noeffort uses verified stateless even with store=${store} (stream=${stream})`, async () => {
        const f = await gateway();
        const response = await f.post({ stream, store, include: undefined });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-transport")).toBe("stateless");
        await responseOutput(response, stream);
        expect(f.state.nativeCalls).toBe(0);
        expect(f.inputs).toHaveLength(1);
        expect(f.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
        await until(() => accountQueueDepth(f.account.id) === 0);
      });
    }

    test(`local stored K3 continuation preserves signed reasoning, owner and tool IDs (stream=${stream})`, async () => {
      const f = await gateway({ tools: true });
      const firstResponse = await f.post({ stream, store: true, include: undefined });
      expect(firstResponse.status).toBe(200);
      const first = await responseState(firstResponse, stream);
      const firstOutput = first.output as ObjectValue[];
      const call = firstOutput.find((item) => item.type === "function_call");
      expect(typeof first.id).toBe("string");
      expect(call?.name).toBe(TOOL.name);
      await until(() => accountQueueDepth(f.account.id) === 0);
      const continued = await f.post({
        stream,
        store: true,
        previous_response_id: first.id,
        input: [{ type: "function_call_output", call_id: call?.call_id, output: "41" }],
      });
      expect(continued.status).toBe(200);
      expect(continued.headers.get("x-kiro-transport")).toBe("stateless");
      expect(JSON.stringify(await responseOutput(continued, stream))).toContain("K3_SYNTHETIC_OK");
      expect(f.state.nativeCalls).toBe(0);
      expect(f.inputs).toHaveLength(2);
      expect(f.preferredAccounts.at(-1)).toBe(f.account.id);
      expect(f.inputs[1]?.conversationState?.conversationId).toBe(
        f.inputs[0]?.conversationState?.conversationId,
      );
      const history = f.inputs[1]?.conversationState?.history ?? [];
      expect(
        history.flatMap((turn) => turn.assistantResponseMessage?.reasoningContent ?? []),
      ).toEqual([{ reasoningText: { text: REASONING, signature: SIGNATURE } }]);
      expect(
        history
          .flatMap((turn) => turn.assistantResponseMessage?.toolUses ?? [])
          .map((tool) => tool.toolUseId),
      ).toEqual([CALL_ID]);
      const current =
        f.inputs[1]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext;
      expect(current?.toolResults?.map((result) => result.toolUseId)).toEqual([CALL_ID]);
      expect(current?.tools).toHaveLength(1);
      expect(f.inputs[1]?.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
      await until(() => accountQueueDepth(f.account.id) === 0);
    });

    for (const effort of ["low", "high", "max"] as const) {
      test(`preserves schema-supported effort=${effort} on the Kiro wire (stream=${stream})`, async () => {
        const f = await gateway({ strict: true });
        const response = await f.post({ stream, reasoning: { effort } });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-transport")).toBe("stateless");
        expect(response.headers.get("x-kiro-compatibility")).toBeNull();
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
        await responseOutput(response, stream);
        expect(f.inputs).toHaveLength(1);
        expect(f.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort } });
        await until(() => accountQueueDepth(f.account.id) === 0);
        expect(f.state.closed).toBe(1);
        expect(f.catalogCalls()).toBe(1);
      });
    }

    test(`uses the schema default max without Claude thinking controls (stream=${stream})`, async () => {
      const f = await gateway({ strict: true });
      const response = await f.post({ stream });
      expect(response.status).toBe(200);
      await responseOutput(response, stream);
      expect(f.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
      await until(() => accountQueueDepth(f.account.id) === 0);
    });

    for (const late of [false, true]) {
      test(`signed reasoning and current tools round-trip without changing historical IDs (stream=${stream}, late=${late})`, async () => {
        const f = await gateway({ tools: true, late });
        const first = await f.post({ stream, reasoning: { effort: "max" } });
        expect(first.status).toBe(200);
        const output = await responseOutput(first, stream);
        const reasoning = output.find((item) => item.type === "reasoning");
        expect(reasoning?.encrypted_content).toStartWith("kr2_");
        expect(reasoning?.summary).toEqual([{ type: "summary_text", text: REASONING }]);
        const call = output.find((item) => item.type === "function_call");
        expect(call?.name).toBe(TOOL.name);
        await until(() => accountQueueDepth(f.account.id) === 0);
        const continued = await f.post({
          stream,
          reasoning: { effort: "max" },
          input: [
            USER,
            ...output,
            { type: "function_call_output", call_id: call?.call_id, output: "41" },
          ],
        });
        expect(continued.status).toBe(200);
        expect(JSON.stringify(await responseOutput(continued, stream))).toContain(
          "K3_SYNTHETIC_OK",
        );
        expect(f.inputs).toHaveLength(2);
        const history = f.inputs[1]?.conversationState?.history ?? [];
        expect(
          history.flatMap((turn) => turn.assistantResponseMessage?.reasoningContent ?? []),
        ).toEqual([{ reasoningText: { text: REASONING, signature: SIGNATURE } }]);
        expect(
          history
            .flatMap((turn) => turn.assistantResponseMessage?.toolUses ?? [])
            .map((tool) => tool.toolUseId),
        ).toEqual([CALL_ID]);
        const current =
          f.inputs[1]?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext;
        expect(current?.toolResults?.map((tool) => tool.toolUseId)).toEqual([CALL_ID]);
        expect(current?.tools).toHaveLength(1);
        expect(f.inputs[1]?.additionalModelRequestFields).toEqual({ reasoning: { effort: "max" } });
        await until(() => accountQueueDepth(f.account.id) === 0);
        expect(f.state.closed).toBe(2);
      });
    }

    test(`unsigned reasoning remains visible but cannot become authenticated replay (stream=${stream})`, async () => {
      const f = await gateway({ unsigned: true, tools: true });
      const first = await f.post({ stream, reasoning: { effort: "max" } });
      expect(first.status).toBe(200);
      const output = await responseOutput(first, stream);
      const reasoning = output.find((item) => item.type === "reasoning");
      expect(reasoning?.summary).toEqual([{ type: "summary_text", text: REASONING }]);
      expect(reasoning?.encrypted_content).toBeUndefined();
      await until(() => accountQueueDepth(f.account.id) === 0);
      const call = output.find((item) => item.type === "function_call");
      const history = [
        USER,
        ...output,
        { type: "function_call_output", call_id: call?.call_id, output: "41" },
      ];
      const strictApp = createApp(
        { ...f.config, responses_fidelity_mode: "strict" },
        {
          ...f.dependencies,
          affinityStore: f.database,
          reasoningReplayStore: f.store,
          modelCapabilities: f.capabilities,
        },
      );
      const rejected = await strictApp(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: K3_MODEL.modelId,
            store: false,
            stream,
            input: history,
            tools: [TOOL],
          }),
        }),
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("unsupported_reasoning_plaintext_replay");
      expect(f.inputs).toHaveLength(1);
      const compatible = await f.post({ input: history, stream });
      expect(compatible.status).toBe(200);
      expect(compatible.headers.get("x-kiro-compatibility")).toContain(
        "reasoning_summary_replay_omitted",
      );
      await responseOutput(compatible, stream);
      expect(JSON.stringify(f.inputs[1]?.conversationState)).not.toContain(REASONING);
      expect(JSON.stringify(f.inputs[1]?.conversationState)).toContain(CALL_ID);
      await until(() => accountQueueDepth(f.account.id) === 0);
    });

    test(`reasoning followed by truncation is terminal and holds its lease through cleanup (stream=${stream})`, async () => {
      const cleanup = deferred();
      const f = await gateway({ broken: true, unsigned: true, cleanup });
      try {
        const reading = f.post({ stream, reasoning: { effort: "max" } }).then(async (response) => ({
          response,
          wire: await response.text(),
        }));
        await until(() => f.state.cleanupStarted);
        expect(f.inputs).toHaveLength(1);
        expect(f.state.cleanupStarted).toBe(true);
        expect(f.state.cleanupFinished).toBe(false);
        expect(accountQueueDepth(f.account.id)).toBe(1);
        cleanup.resolve();
        const { response, wire } = await reading;
        expect(wire).not.toContain('"type":"response.completed"');
        if (!stream) expect(response.status).toBe(502);
      } finally {
        cleanup.resolve();
      }
      await until(() => f.state.cleanupFinished && accountQueueDepth(f.account.id) === 0);
      expect(f.inputs).toHaveLength(1);
      expect(f.state.closed).toBe(1);
    });

    test(`nonempty signature conflicts stay fatal without retry or policy recovery (stream=${stream})`, async () => {
      const f = await gateway({ conflict: true });
      const response = await f.post({ stream, reasoning: { effort: "max" } });
      const wire = await response.text();
      expect(wire).toContain("invalid_upstream_reasoning");
      expect(wire).not.toContain("encrypted_content");
      expect(wire).not.toContain('"type":"response.completed"');
      if (!stream) expect(response.status).toBe(502);
      await until(() => accountQueueDepth(f.account.id) === 0);
      expect(f.inputs).toHaveLength(1);
      expect(f.state.closed).toBe(1);
      expect(audit.events("anthropic_output_reasoning_conflict_omitted")).toHaveLength(0);
    });

    test(`signature-only truncation cannot retry an accepted generation (stream=${stream})`, async () => {
      const f = await gateway({ signatureOnly: true, broken: true });
      const response = await f.post({ stream, reasoning: { effort: "max" } });
      const wire = await response.text();
      expect(wire).not.toContain(SIGNATURE);
      expect(wire).not.toContain('"type":"response.completed"');
      if (!stream) expect(response.status).toBe(502);
      await until(() => accountQueueDepth(f.account.id) === 0);
      expect(f.inputs).toHaveLength(1);
      expect(f.state.closed).toBe(1);
    });
  }

  for (const strict of [false, true]) {
    for (const store of [false, true]) {
      for (const effort of ["medium", "xhigh", "none", "minimal"]) {
        test(`rejects schema-unsupported effort=${effort} before dispatch (strict=${strict}, store=${store})`, async () => {
          const f = await gateway({ strict });
          const response = await f.post({ reasoning: { effort }, store, include: undefined });
          expect(response.status).toBe(400);
          const error = object(object(await response.json()).error);
          expect(error.type).toBe("invalid_request_error");
          expect(error.code).toBe("unsupported_reasoning_effort");
          expect(error.param).toBe("reasoning.effort");
          expect(f.inputs).toHaveLength(0);
          expect(f.state.nativeCalls).toBe(0);
        });
      }
    }
  }

  test("authentication and malformed tokens cannot dispatch or mint replacement replay", async () => {
    const f = await gateway();
    const unauthorized = await f.post({}, { key: "synthetic-wrong-key" });
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();
    const badReplay = await f.post({
      input: [
        { type: "reasoning", encrypted_content: "kr2_invalid", summary: [] },
        { role: "assistant", content: "prior synthetic answer" },
        USER,
      ],
    });
    expect(badReplay.status).toBe(400);
    expect(await badReplay.text()).toContain("invalid_reasoning_replay");
    expect(f.inputs).toHaveLength(0);
  });

  for (const transport of ["native", "native-adapted"] as const) {
    test(`a stored ${transport} continuation cannot silently migrate K3 to stateless`, async () => {
      const f = await gateway();
      const auth = checkApiKey(
        new Request("http://fixture", {
          headers: { authorization: `Bearer ${MESSAGES_FIXTURE_KEY}` },
        }),
        [MESSAGES_FIXTURE_KEY],
      );
      if (!auth.ok) throw new Error("Expected synthetic authenticated tenant");
      const id = `resp_synthetic_${transport}`;
      f.responseStore.putNative(
        auth.tenantId,
        nativeResponse(id, K3_MODEL.modelId) as unknown as ResponseStateObject,
        [USER],
        {
          transport,
          request: { model: K3_MODEL.modelId, input: [USER], store: true, stream: false },
          owner: {
            accountId: f.account.id,
            region: "us-east-1",
            profileArn: f.account.profileArn,
            responseId: id,
          },
          output: [],
          tools: [],
        },
      );
      const response = await f.post({ store: true, include: undefined, previous_response_id: id });
      expect(response.status).toBe(400);
      expect(object(object(await response.json()).error).code).toBe(
        "native_response_transport_conflict",
      );
      expect(f.inputs).toHaveLength(0);
      expect(f.state.nativeCalls).toBe(0);
    });
  }

  for (const kind of ["unknown", "other-tenant"] as const) {
    test(`K3 routing preserves 404 isolation for ${kind} previous_response_id`, async () => {
      const f = await gateway();
      const id = "resp_synthetic_isolation";
      if (kind === "other-tenant") {
        f.responseStore.putNative(
          "synthetic-unrelated-tenant",
          nativeResponse(id, K3_MODEL.modelId) as unknown as ResponseStateObject,
          [USER],
        );
      }
      const response = await f.post({ store: true, include: undefined, previous_response_id: id });
      expect(response.status).toBe(404);
      await response.text();
      expect(f.inputs).toHaveLength(0);
      expect(f.state.nativeCalls).toBe(0);
    });
  }

  test("strict Messages output-token control stays fail-closed despite catalog capacity", async () => {
    const f = await gateway();
    const response = await f.post(
      {
        messages: [{ role: "user", content: "Synthetic Messages request" }],
        max_tokens: 1_024,
        input: undefined,
        include: undefined,
        store: undefined,
      },
      { path: "/v1/messages" },
    );
    expect(response.status).toBe(400);
    const error = object(object(await response.json()).error);
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("max_tokens");
    expect(error.message).toContain("no probe-confirmed native output-token control");
    expect(f.inputs).toHaveLength(0);
  });

  for (const stream of [false, true]) {
    for (const effort of ["low", "high", "max"]) {
      test(`explicit Messages advisory preserves effort=${effort} without fabricating an output cap (stream=${stream})`, async () => {
        const f = await gateway();
        const response = await f.app(
          new Request("http://fixture/v1/messages", {
            method: "POST",
            headers: {
              authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
              "content-type": "application/json",
              "x-kiro-output-token-limit-mode": "advisory",
            },
            body: JSON.stringify({
              model: K3_MODEL.modelId,
              max_tokens: 32_000,
              stream,
              thinking: { type: "adaptive" },
              output_config: { effort },
              messages: [{ role: "user", content: "Synthetic Messages advisory request" }],
            }),
          }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-output-token-limit-mode")).toBe("advisory-unenforced");
        const wire = await response.text();
        // With no omitted display request, the existing Anthropic contract
        // returns direct signed thinking. Only audits must hide its material.
        expect(wire).toContain(SIGNATURE);
        if (stream) expect(messagesSseEvents(wire).at(-1)?.type).toBe("message_stop");
        else expect(object(JSON.parse(wire)).type).toBe("message");
        expect(f.inputs).toHaveLength(1);
        expect(f.inputs[0]?.additionalModelRequestFields).toEqual({ reasoning: { effort } });
        expect(audit.events("anthropic_output_token_limit_unenforced")).toEqual([
          expect.objectContaining({ model: K3_MODEL.modelId, requested_max_tokens: 32_000 }),
        ]);
        const logs = JSON.stringify(audit.events());
        expect(logs).not.toContain(REASONING);
        expect(logs).not.toContain(SIGNATURE);
        await until(() => accountQueueDepth(f.account.id) === 0);
      });
    }
  }

  for (const maxTokens of [0, -1, 1.5]) {
    test(`Messages advisory cannot bypass invalid max_tokens=${maxTokens}`, async () => {
      const f = await gateway();
      const response = await f.app(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
            "content-type": "application/json",
            "x-kiro-output-token-limit-mode": "advisory",
          },
          body: JSON.stringify({
            model: K3_MODEL.modelId,
            max_tokens: maxTokens,
            messages: [{ role: "user", content: "Synthetic invalid cap" }],
          }),
        }),
      );
      expect(response.status).toBe(400);
      await response.text();
      expect(f.inputs).toHaveLength(0);
      expect(audit.events("anthropic_output_token_limit_unenforced")).toHaveLength(0);
    });
  }

  for (const thinking of [
    { type: "disabled" },
    { type: "enabled", budget_tokens: 2_048 },
    { type: "adaptive", display: "omitted" },
    { type: "adaptive", display: "summarized" },
  ]) {
    test(`Messages advisory cannot authorize unsupported thinking=${JSON.stringify(thinking)}`, async () => {
      const f = await gateway();
      const response = await f.app(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
            "content-type": "application/json",
            "x-kiro-output-token-limit-mode": "advisory",
          },
          body: JSON.stringify({
            model: K3_MODEL.modelId,
            max_tokens: 32_000,
            thinking,
            messages: [{ role: "user", content: "Synthetic unsupported thinking" }],
          }),
        }),
      );
      expect(response.status).toBe(400);
      await response.text();
      expect(f.inputs).toHaveLength(0);
    });
  }

  for (const [patch, code, param] of [
    [{ requestedReasoningEffort: "none" }, "unsupported_reasoning_effort", "reasoning.effort"],
    [{ reasoningEffort: "medium" }, "unsupported_reasoning_effort", "reasoning.effort"],
    [{ thinking: { enabled: false } }, "unsupported_reasoning_control", "thinking"],
    [
      { thinking: { enabled: true, budgetTokens: 2_048 } },
      "unsupported_reasoning_control",
      "thinking",
    ],
    [
      { thinking: { enabled: true, display: "omitted" } },
      "unsupported_reasoning_control",
      "thinking",
    ],
    [{ temperature: 0.1 }, "unsupported_parameter", "temperature"],
  ] as const) {
    test(`programmatic canonical callers cannot bypass K3 capability guards (${code}/${JSON.stringify(patch)})`, async () => {
      await gateway();
      const body: CanonicalRequest = {
        canonicalVersion: 1,
        protocol: "responses",
        projectionMode: "legacy-user-prefix",
        model: K3_MODEL.modelId,
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Synthetic canonical request", path: "input" }],
            toolCalls: [],
            path: "input",
          },
        ],
        tools: [],
        toolChoice: "auto",
        reasoningReplays: [],
        includeEncryptedReasoning: true,
        ...patch,
      };
      let caught: unknown;
      try {
        transformToSdkRequest(body, K3_MODEL.modelId, {
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 3_600_000,
          authMethod: "desktop",
          region: "us-east-1",
          profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code, param });
    });
  }

  test("audit events do not expose synthetic reasoning or signatures", async () => {
    const f = await gateway();
    const response = await f.post({ reasoning: { effort: "max" } });
    expect(response.status).toBe(200);
    await responseOutput(response, false);
    const logs = JSON.stringify(audit.events());
    expect(logs).not.toContain(REASONING);
    expect(logs).not.toContain(SIGNATURE);
    expect(logs).not.toContain("signature_hash");
    await until(() => accountQueueDepth(f.account.id) === 0);
  });
});
