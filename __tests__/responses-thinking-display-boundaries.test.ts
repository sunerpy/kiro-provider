import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config/schema.js";
import { runChatCompletion } from "../src/core/pipeline.js";
import { accountQueueDepth } from "../src/core/pipeline-runtime.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { MESSAGES_FIXTURE_KEY, messagesFixture } from "./messages-regression-helpers.js";
import {
  searchCallGeneration,
  sseData,
  textGeneration,
  waitFor,
  webSearchFixture,
} from "./web-search-test-helpers.js";

const MODEL = "claude-opus-5-5";
const HIDDEN = "Synthetic current reasoning hidden at the public projection only";
const SIGNATURE = "synthetic-boundary-signature";
const DONE: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
};
const databases: AccountsDatabase[] = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  for (const database of databases.splice(0)) database.close();
});

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not an object");
  return value as RecordValue;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function gateway(config: Partial<Config> = {}, signed = false) {
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const f = messagesFixture(
    [
      ...(signed ? [{ reasoningContentEvent: { text: HIDDEN, signature: SIGNATURE } }] : []),
      { assistantResponseEvent: { content: "BOUNDARY_OK" } },
    ],
    {
      config: {
        protocol_projection_mode: "safe",
        dynamic_model_catalog: false,
        responses_thinking_display_mode: "omitted",
        reasoning_replay_keys: [`boundaries:${Buffer.alloc(32, 12).toString("base64url")}`],
        ...config,
      },
    },
  );
  // Bind replay to the real auth-derived tenant and the shared authenticated
  // application, rather than passing a prebuilt completion around the pipeline.
  const store = new ReasoningReplayStore(database, f.config);
  const dependencies = { ...f.dependencies, reasoningReplayStore: store };
  return { ...f, dependencies, app: createApp(f.config, dependencies) };
}

async function post(
  f: ReturnType<typeof gateway>,
  extra: RecordValue = {},
  key = MESSAGES_FIXTURE_KEY,
) {
  return f.app(
    new Request("http://fixture/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        store: false,
        stream: false,
        input: [{ role: "user", content: "Synthetic boundary request" }],
        ...extra,
      }),
    }),
  );
}

function completedOutput(wire: string, stream: boolean): RecordValue[] {
  const body = stream
    ? record(sseData(wire).find((event) => event.type === "response.completed")?.response)
    : record(JSON.parse(wire));
  expect(body.status).toBe("completed");
  return body.output as RecordValue[];
}

describe("Responses omitted display policy boundaries", () => {
  test.each([MODEL, `${MODEL}-max`])(
    "explicit effort none keeps the original capability result and never enables thinking (%s)",
    async (model) => {
      const before = gateway({ responses_thinking_display_mode: "preserve", effort: "high" });
      const after = gateway({ effort: "high" });
      const request = { model, reasoning: { effort: "none" } };
      const previous = await post(before, request);
      const next = await post(after, request);
      expect(next.status).toBe(previous.status);
      const oldBody = record(await previous.json());
      const newBody = record(await next.json());
      expect(next.headers.get("x-kiro-thinking-display-mode")).toBeNull();
      if (previous.ok) {
        expect(completedOutput(JSON.stringify(newBody), false)).toEqual(
          completedOutput(JSON.stringify(oldBody), false).map((item, index) => ({
            ...item,
            id: (newBody.output as RecordValue[])[index]?.id,
          })),
        );
        expect(after.inputs).toHaveLength(1);
        expect(after.inputs[0]?.additionalModelRequestFields).toEqual(
          before.inputs[0]?.additionalModelRequestFields,
        );
        expect(
          record(after.inputs[0]?.additionalModelRequestFields ?? {}).thinking,
        ).toBeUndefined();
      } else {
        expect(newBody.error).toMatchObject({
          code: record(oldBody.error).code,
          message: record(oldBody.error).message,
        });
        expect(after.inputs).toHaveLength(0);
      }
      expect(audit.events("responses_thinking_display_forced")).toHaveLength(0);
    },
  );

  for (const stream of [false, true]) {
    test.each(["none", undefined])(
      `strict summary=%s accepts a signed omitted response (stream=${stream})`,
      async (summary) => {
        const f = gateway({ responses_fidelity_mode: "strict" }, true);
        const response = await post(f, {
          stream,
          reasoning: { effort: "max", ...(summary !== undefined ? { summary } : {}) },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const wire = await response.text();
        expect(wire).not.toContain(HIDDEN);
        expect(wire).not.toContain(SIGNATURE);
        const output = completedOutput(wire, stream);
        const reasoning = output.find((item) => item.type === "reasoning");
        expect(reasoning?.summary).toEqual([]);
        expect(reasoning?.encrypted_content).toStartWith("kr2_");
        expect(f.inputs[0]?.additionalModelRequestFields).toEqual({
          output_config: { effort: "max" },
          thinking: { type: "adaptive", display: "omitted" },
        });
        expect(audit.events("responses_thinking_display_forced")).toHaveLength(1);
      },
    );
  }

  test("authentication rejects before any display policy or upstream dispatch", async () => {
    const f = gateway({}, true);
    const response = await post(f, { stream: true, reasoning: { effort: "max" } }, "wrong-key");
    expect(response.status).toBe(401);
    expect(response.headers.get("x-kiro-thinking-display-mode")).toBeNull();
    await response.text();
    expect(f.inputs).toHaveLength(0);
    expect(audit.events("responses_thinking_display_forced")).toHaveLength(0);
    expect(audit.events("request_admission_acquired")).toHaveLength(0);
  });

  test.each(["client cancellation", "deadline"] as const)(
    "%s keeps hidden reasoning semantic and capacity held through delayed cleanup",
    async (cause) => {
      let releaseCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let waiting = false;
      let cleanupStarted = false;
      let cleanupFinished = false;
      const client = new AbortController();
      const f = messagesFixture([], {
        config: {
          protocol_projection_mode: "safe",
          dynamic_model_catalog: false,
          responses_thinking_display_mode: "omitted",
          max_inflight_requests: 1,
          account_inference_concurrency: 1,
          stream_max_attempts: 3,
          rate_limit_max_retries: 3,
          request_timeout_ms: cause === "deadline" ? 300 : 3_000,
        },
        stream: async function* (signal): AsyncGenerator<SdkStreamEvent> {
          if (f.inputs.length > 1) {
            yield { assistantResponseEvent: { content: "AFTER_CLEANUP" } };
            yield DONE;
            return;
          }
          try {
            yield { reasoningContentEvent: { text: HIDDEN, signature: SIGNATURE } };
            waiting = true;
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          } finally {
            cleanupStarted = true;
            await cleanup;
            cleanupFinished = true;
          }
        },
      });
      const request = () =>
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
          },
          signal: client.signal,
          body: JSON.stringify({
            model: MODEL,
            store: false,
            stream: true,
            reasoning: { effort: "max" },
            input: "Synthetic display cancellation",
          }),
        });
      const accountId = f.dependencies.accountManager.reconcileFromDb()[0]?.id;
      if (accountId === undefined) throw new Error("Missing fixture account");
      try {
        const response = await f.app(request());
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
        const reading = response.text();
        expect(await waitFor(() => waiting)).toBe(true);
        if (cause === "client cancellation")
          client.abort(new DOMException("fixture", "AbortError"));
        const wire = await reading;
        expect(wire).not.toContain(HIDDEN);
        expect(wire).not.toContain(SIGNATURE);
        expect(sseData(wire).some((event) => event.type === "response.completed")).toBe(false);
        if (cause === "deadline") expect(wire).toContain("request_deadline_exceeded");
        expect(await waitFor(() => cleanupStarted)).toBe(true);
        expect(cleanupFinished).toBe(false);
        expect(accountQueueDepth(accountId)).toBe(1);
        expect(audit.events("request_admission_released")).toHaveLength(0);
        expect(f.inputs).toHaveLength(1);
        expect(audit.events("sdk_stream_terminal").at(-1)).toMatchObject({
          reasoning_chars: HIDDEN.length,
          completion_witnessed: false,
        });
        const blocked = await f.app(
          new Request(request(), { signal: new AbortController().signal }),
        );
        expect(blocked.status).toBe(503);
        await blocked.text();
        expect(f.inputs).toHaveLength(1);
        releaseCleanup();
        expect(await waitFor(() => cleanupFinished && accountQueueDepth(accountId) === 0)).toBe(
          true,
        );
        expect(await waitFor(() => audit.events("request_admission_released").length === 1)).toBe(
          true,
        );
        const recovered = await f.app(
          new Request(request(), { signal: new AbortController().signal }),
        );
        expect(recovered.status).toBe(200);
        expect(await recovered.text()).toContain("AFTER_CLEANUP");
        expect(f.inputs).toHaveLength(2);
        expect(f.state.aborted).toBe(1);
      } finally {
        releaseCleanup();
      }
    },
  );

  test.each(["deadline", "client cancellation"] as const)(
    "%s during opaque-only non-stream cleanup takes precedence over its earlier transport fault",
    async (cause) => {
      const f = gateway({ request_timeout_ms: 5_000, rate_limit_max_retries: 3 });
      const deadline = new AbortController();
      const client = new AbortController();
      const cleanup = deferred();
      const catchEntered = deferred();
      let cleanupStarted = false;
      let cleanupFinished = false;
      let returns = 0;
      let sends = 0;
      const accountId = f.dependencies.accountManager.reconcileFromDb()[0]?.id;
      if (accountId === undefined) throw new Error("Missing fixture account");
      const sdkResponse: SdkStreamResponse = {
        generateAssistantResponseResponse: {
          [Symbol.asyncIterator]() {
            let next = 0;
            return {
              next(): Promise<IteratorResult<SdkStreamEvent>> {
                if (next++ === 0)
                  return Promise.resolve({
                    done: false,
                    value: { reasoningContentEvent: { signature: SIGNATURE } },
                  });
                return Promise.reject(new Error("Synthetic opaque-only transport fault"));
              },
              async return(): Promise<IteratorResult<SdkStreamEvent>> {
                returns += 1;
                cleanupStarted = true;
                await cleanup.promise;
                cleanupFinished = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      };
      const request = new Request("http://fixture/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: client.signal,
        body: JSON.stringify({
          model: MODEL,
          store: false,
          stream: false,
          reasoning: { effort: "max" },
          input: "Synthetic cleanup deadline race",
        }),
      });
      try {
        const pending = handleResponses(request, f.config, {
          ...f.dependencies,
          tenantId: "synthetic-cleanup-race-tenant",
          createRequestIdleTimeoutLease: undefined,
          // Drive the real pipeline's supported deadline signal only after
          // the upstream fault has entered catch and snapshotted cancellation.
          // This avoids wall-clock sleeps and the 500 ms cleanup grace timer.
          runPipeline: (options) =>
            runChatCompletion({
              ...options,
              deadlineSignal: AbortSignal.any([
                ...(options.deadlineSignal ? [options.deadlineSignal] : []),
                deadline.signal,
              ]),
            }),
          makeClient: () => ({
            async send(_command, options) {
              sends += 1;
              // runCollectAttempt calls abortUpstream after taking its first
              // signal snapshot, then waits for this iterator's return().
              options.abortSignal.addEventListener("abort", catchEntered.resolve, { once: true });
              return sdkResponse;
            },
          }),
        });
        await catchEntered.promise;
        expect(cleanupStarted).toBe(true);
        expect(cleanupFinished).toBe(false);
        expect(accountQueueDepth(accountId)).toBe(1);
        expect(audit.events("sdk_stream_terminal").at(-1)).toMatchObject({
          terminal_provenance: "upstream_error",
          reasoning_chars: 0,
          raw_event_count: 1,
          completion_witnessed: false,
        });

        if (cause === "deadline") {
          deadline.abort(new DOMException("Synthetic deadline during cleanup", "TimeoutError"));
        } else {
          client.abort(new DOMException("Synthetic cancellation during cleanup", "AbortError"));
        }
        expect(accountQueueDepth(accountId)).toBe(1);
        cleanup.resolve();
        const response = await pending;
        const wire = await response.text();
        expect(response.status).toBe(cause === "deadline" ? 504 : 499);
        expect(JSON.parse(wire)).toMatchObject({
          error: {
            code: cause === "deadline" ? "request_timeout" : "client_disconnected",
          },
        });
        expect(wire).not.toContain(SIGNATURE);
        expect(sends).toBe(1);
        expect(returns).toBe(1);
        expect(cleanupFinished).toBe(true);
        expect(accountQueueDepth(accountId)).toBe(0);
        expect(audit.events("sdk_stream_attempt_retry")).toHaveLength(0);
      } finally {
        cleanup.resolve();
      }
    },
  );

  test.each([false, true])(
    "hosted search hides both generations while their tokens authenticate complete history (stream=%s)",
    async (stream) => {
      const searchText = `${HIDDEN}: search`;
      const answerText = `${HIDDEN}: answer`;
      const f = webSearchFixture(
        [
          [
            { reasoningContentEvent: { text: searchText, signature: "fixture-search-signature" } },
            ...searchCallGeneration("fixture display query"),
          ],
          [
            { reasoningContentEvent: { text: answerText, signature: "fixture-answer-signature" } },
            ...textGeneration("VISIBLE_HOSTED_ANSWER"),
          ],
          textGeneration("HOSTED_CONTINUATION_OK"),
        ],
        { config: { responses_thinking_display_mode: "omitted", dynamic_model_catalog: false } },
      );
      databases.push(f.database);
      const user = { role: "user", content: "Search the synthetic runtime docs" };
      const request = {
        model: MODEL,
        store: false,
        stream,
        tools: [{ type: "web_search", external_web_access: true }],
        reasoning: { effort: "max", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        input: [user],
      };
      const response = await f.post("/v1/responses", request);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-thinking-display-mode")).toBe("forced-omitted");
      const wire = await response.text();
      expect(wire).not.toContain(HIDDEN);
      expect(wire).not.toContain("fixture-search-signature");
      expect(wire).not.toContain("fixture-answer-signature");
      expect(wire).toContain("VISIBLE_HOSTED_ANSWER");
      const output = completedOutput(wire, stream);
      const reasonings = output.filter((item) => item.type === "reasoning");
      expect(reasonings).toHaveLength(2);
      for (const item of reasonings) {
        expect(item.summary).toEqual([]);
        expect(item.encrypted_content).toStartWith("kr2_");
      }
      expect(output.filter((item) => item.type === "web_search_call")).toHaveLength(1);
      expect(f.inputs).toHaveLength(2);
      for (const input of f.inputs) {
        expect(input.additionalModelRequestFields).toMatchObject({
          output_config: { effort: "max" },
          thinking: { type: "adaptive", display: "omitted" },
        });
      }
      const replay = output.map((item) => {
        if (item.type === "web_search_call")
          return {
            type: item.type,
            id: item.id,
            status: item.status,
            action: { type: "search", query: record(item.action).query },
          };
        if (item.type === "message")
          return {
            type: item.type,
            id: item.id,
            role: "assistant",
            content: (item.content as RecordValue[]).map((part) => ({
              type: "output_text",
              text: part.text,
            })),
          };
        return item;
      });
      const continued = await f.post("/v1/responses", {
        ...request,
        stream: false,
        input: [user, ...replay, { role: "user", content: "Continue from the search result" }],
      });
      expect(continued.status).toBe(200);
      expect(await continued.text()).toContain("HOSTED_CONTINUATION_OK");
      expect(f.inputs).toHaveLength(3);
      const history = f.inputs[2]?.conversationState?.history ?? [];
      expect(
        history.flatMap((turn) =>
          turn.assistantResponseMessage?.reasoningContent?.reasoningText
            ? [turn.assistantResponseMessage.reasoningContent.reasoningText]
            : [],
        ),
      ).toEqual([
        { text: searchText, signature: "fixture-search-signature" },
        { text: answerText, signature: "fixture-answer-signature" },
      ]);
      expect(
        history
          .flatMap((turn) => turn.assistantResponseMessage?.toolUses ?? [])
          .map((call) => call.toolUseId),
      ).toEqual(["call_fixture_search_0001"]);
      expect(
        history
          .flatMap((turn) => turn.userInputMessage?.userInputMessageContext?.toolResults ?? [])
          .map((result) => result.toolUseId),
      ).toEqual(["call_fixture_search_0001"]);
      expect(f.mcpCalls.filter((call) => call.method === "tools/call")).toHaveLength(1);
      expect(JSON.stringify(audit.events())).not.toContain(HIDDEN);
      expect(JSON.stringify(audit.events())).not.toContain("fixture-search-signature");
    },
  );
});
