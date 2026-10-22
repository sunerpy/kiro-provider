import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import type { PipelineReasoningReplayStore } from "../src/core/pipeline.js";
import { accountQueueDepth } from "../src/core/pipeline-runtime.js";
import { transformSdkOutputStream } from "../src/kiro/transform/streaming/sdk-output-transformer.js";
import type {
  SdkStreamEvent,
  SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const SUMMARY = "Synthetic reasoning summary";
const SIGNATURE = "synthetic-original-signature";
const COMPLETION: SdkStreamEvent = {
  metadataEvent: { tokenUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
};
const TOOL_EVENT: SdkStreamEvent = {
  toolUseEvent: {
    toolUseId: "synthetic_integrity_call",
    name: "synthetic_lookup",
    input: '{"value":41}',
    stop: true,
  },
};

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!check() && performance.now() < deadline) await Bun.sleep(2);
  expect(check()).toBe(true);
}

/** Real Responses ingress, pipeline, replay store and output adapters; only the SDK is fake. */
function gateway(events: readonly SdkStreamEvent[]) {
  const fixture = fidelityFixture({
    config: {
      dynamic_model_catalog: false,
      request_timeout_ms: 3_000,
      stream_idle_timeout_ms: 2_000,
      account_inference_concurrency: 1,
      rate_limit_max_retries: 3,
      reasoning_replay_keys: [`integrity-test:${Buffer.alloc(32, 9).toString("base64url")}`],
    },
  });
  fixture.accounts.splice(1);
  const store = new ReasoningReplayStore(fixture.database, fixture.config);
  const state = {
    captures: 0,
    closed: 0,
    commands: [] as GenerateAssistantResponseCommand[],
    signals: [] as AbortSignal[],
  };
  const replayStore: PipelineReasoningReplayStore = {
    readiness: () => store.readiness(),
    store: (...args) => {
      state.captures += 1;
      return store.store(...args);
    },
    resolveResponses: (...args) => store.resolveResponses(...args),
    resolveChat: (...args) => store.resolveChat(...args),
  };
  return {
    fixture,
    state,
    replayStore,
    async send(stream: boolean, input: unknown = "Synthetic integrity request") {
      return fixture.send(
        {
          model: "gpt-5.6-sol",
          store: false,
          stream,
          reasoning: { effort: "max" },
          include: ["reasoning.encrypted_content"],
          input,
          tools: [
            {
              type: "function",
              name: "synthetic_lookup",
              description: "Return a synthetic fixture value",
              parameters: { type: "object", properties: { value: { type: "number" } } },
            },
          ],
        },
        {
          runPipeline: undefined,
          reasoningReplayStore: replayStore,
          makeClient: () => ({
            async send(command, options) {
              state.commands.push(command);
              state.signals.push(options.abortSignal as AbortSignal);
              return {
                generateAssistantResponseResponse: (async function* () {
                  try {
                    yield* state.commands.length === 1
                      ? events
                      : [{ assistantResponseEvent: { content: "Continued" } }, COMPLETION];
                  } finally {
                    state.closed += 1;
                  }
                })(),
              };
            },
          }),
        },
      );
    },
  };
}

function outputOf(wire: string, stream: boolean): Array<Record<string, unknown>> {
  if (!stream) return JSON.parse(wire).output;
  const terminal = wire
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "response.completed");
  expect(terminal).toBeDefined();
  return terminal.response.output;
}

describe("Responses upstream reasoning integrity", () => {
  for (const stream of [false, true]) {
    for (const late of [false, true]) {
      for (const kind of ["conflicting signatures", "mixed text and redacted"] as const) {
        test(`${kind} cannot complete or mint replay material (stream=${stream}, late=${late})`, async () => {
          const conflicting: SdkStreamEvent = {
            reasoningContentEvent:
              kind === "conflicting signatures"
                ? { signature: "synthetic-conflicting-signature" }
                : { redactedContent: Uint8Array.from([1, 2, 3]) },
          };
          const visible = [{ assistantResponseEvent: { content: "Visible partial" } }, TOOL_EVENT];
          const f = gateway([
            { reasoningContentEvent: { text: SUMMARY, signature: SIGNATURE } },
            ...(late ? visible : []),
            conflicting,
            ...(!late ? visible : []),
            COMPLETION,
          ]);
          try {
            const response = await f.send(stream);
            const wire = await response.text();
            expect(wire).toContain("invalid_upstream_reasoning");
            expect(wire).not.toContain('"type":"response.completed"');
            expect(wire).not.toContain('"status":"completed"');
            expect(wire).not.toContain("encrypted_content");
            expect(wire).not.toContain(SIGNATURE);
            expect(wire).not.toContain("synthetic-conflicting-signature");
            if (stream) {
              expect(response.status).toBe(200);
              expect(wire).toContain('"type":"response.failed"');
            } else {
              expect(response.status).toBe(502);
              expect(JSON.parse(wire)).toMatchObject({
                error: { type: "upstream_error", code: "invalid_upstream_reasoning" },
              });
            }
            await until(() => accountQueueDepth(f.fixture.primary.id) === 0);
            expect(f.state.commands).toHaveLength(1);
            expect(f.state.captures).toBe(0);
            expect(f.state.signals[0]?.aborted).toBe(true);
            expect(f.state.closed).toBe(1);
            expect(
              audit
                .events("sdk_stream_terminal")
                .some((entry) => entry.terminal_provenance === "normal_complete"),
            ).toBe(false);
            const logged = JSON.stringify(audit.events());
            expect(logged).not.toContain(SUMMARY);
            expect(logged).not.toContain(SIGNATURE);
            expect(logged).not.toContain("synthetic-conflicting-signature");
          } finally {
            f.fixture.database.close();
          }
        });
      }
    }

    test(`duplicate late signatures keep authenticated tool history replayable (stream=${stream})`, async () => {
      const f = gateway([
        { reasoningContentEvent: { text: SUMMARY } },
        { assistantResponseEvent: { content: "Visible answer" } },
        TOOL_EVENT,
        { reasoningContentEvent: { signature: SIGNATURE } },
        { reasoningContentEvent: { signature: SIGNATURE } },
        COMPLETION,
      ]);
      try {
        const response = await f.send(stream);
        expect(response.status).toBe(200);
        const wire = await response.text();
        const output = outputOf(wire, stream);
        const reasoning = output.find((item) => item.type === "reasoning");
        expect(reasoning?.encrypted_content).toStartWith("kr2_");
        expect(wire).not.toContain(SIGNATURE);
        expect(f.state.captures).toBe(1);
        await until(() => accountQueueDepth(f.fixture.primary.id) === 0);
        const call = output.find((item) => item.type === "function_call");
        expect(call).toMatchObject({ name: "synthetic_lookup", arguments: '{"value":41}' });
        const continued = await f.send(false, [
          { role: "user", content: "Synthetic integrity request" },
          ...output,
          { type: "function_call_output", call_id: call?.call_id, output: "41" },
        ]);
        expect(continued.status).toBe(200);
        expect(await continued.text()).toContain("Continued");
        expect(f.state.commands).toHaveLength(2);
        expect(
          f.state.commands[1]?.input.conversationState?.history?.find(
            (entry) => entry.assistantResponseMessage?.reasoningContent !== undefined,
          )?.assistantResponseMessage?.reasoningContent,
        ).toEqual({ reasoningText: { text: SUMMARY, signature: SIGNATURE } });
        await until(() => accountQueueDepth(f.fixture.primary.id) === 0);
      } finally {
        f.fixture.database.close();
      }
    });
  }

  test.each(["conflict", "mixed"] as const)(
    "validates %s metadata before a co-located completion witness or capture",
    async (kind) => {
      let captures = 0;
      let outputCaptures = 0;
      const emitted: string[] = [];
      const drain = async () => {
        for await (const event of transformSdkOutputStream(
          makeSdkResponse([
            { reasoningContentEvent: { text: SUMMARY, signature: SIGNATURE } },
            {
              ...COMPLETION,
              reasoningContentEvent:
                kind === "conflict"
                  ? { signature: "synthetic-conflicting-signature" }
                  : { redactedContent: Uint8Array.from([1, 2, 3]) },
            },
          ]),
          "gpt-5.6-sol",
          "synthetic-completion-boundary",
          undefined,
          {
            emitEncryptedReasoning: true,
            captureReasoning: () => {
              captures += 1;
              return "must-not-mint";
            },
            captureOutput: () => {
              outputCaptures += 1;
            },
          },
        )) {
          emitted.push(event.type);
        }
      };
      await expect(drain()).rejects.toMatchObject({ code: "invalid_upstream_reasoning" });
      expect(emitted).not.toContain("completed");
      expect(emitted).not.toContain("reasoning_encrypted");
      expect(captures).toBe(0);
      expect(outputCaptures).toBe(0);
    },
  );

  test("a conflicting stream retains account capacity until upstream cleanup settles", async () => {
    const f = gateway([]);
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted = false;
    let cleanupFinished = false;
    let upstream: AbortSignal | undefined;
    let sends = 0;
    try {
      const response = await f.fixture.send(
        { model: "gpt-5.6-sol", input: "Synthetic cleanup", stream: true, store: false },
        {
          runPipeline: undefined,
          reasoningReplayStore: f.replayStore,
          makeClient: () => ({
            async send(_command, options) {
              sends += 1;
              upstream = options.abortSignal as AbortSignal;
              return {
                generateAssistantResponseResponse: (async function* () {
                  try {
                    yield { reasoningContentEvent: { text: SUMMARY, signature: SIGNATURE } };
                    yield {
                      reasoningContentEvent: { signature: "synthetic-conflicting-signature" },
                    };
                    yield COMPLETION;
                  } finally {
                    cleanupStarted = true;
                    await cleanup;
                    cleanupFinished = true;
                  }
                })(),
              };
            },
          }),
        },
      );
      expect(await response.text()).toContain("invalid_upstream_reasoning");
      expect(cleanupStarted).toBe(true);
      expect(cleanupFinished).toBe(false);
      expect(upstream?.aborted).toBe(true);
      expect(accountQueueDepth(f.fixture.primary.id)).toBe(1);
      expect(sends).toBe(1);
      expect(f.state.captures).toBe(0);
      releaseCleanup();
      await until(() => cleanupFinished && accountQueueDepth(f.fixture.primary.id) === 0);
    } finally {
      releaseCleanup();
      f.fixture.database.close();
    }
  });

  test("client cancellation during unfinished reasoning aborts upstream and releases its lease", async () => {
    const f = gateway([]);
    const client = new AbortController();
    let waiting = false;
    let returns = 0;
    let upstream: AbortSignal | undefined;
    let finishRead: ((value: IteratorResult<SdkStreamEvent>) => void) | undefined;
    let sent = 0;
    const sdkResponse: SdkStreamResponse = {
      generateAssistantResponseResponse: {
        [Symbol.asyncIterator]() {
          let first = true;
          return {
            next() {
              if (first) {
                first = false;
                return Promise.resolve({
                  done: false as const,
                  value: { reasoningContentEvent: { text: SUMMARY, signature: SIGNATURE } },
                });
              }
              waiting = true;
              return new Promise<IteratorResult<SdkStreamEvent>>((resolve) => {
                finishRead = resolve;
              });
            },
            return() {
              returns += 1;
              finishRead?.({ done: true, value: undefined });
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      },
    };
    try {
      const response = await f.fixture.send(
        { model: "gpt-5.6-sol", input: "Synthetic cancellation", stream: true, store: false },
        {
          runPipeline: undefined,
          reasoningReplayStore: f.replayStore,
          makeClient: () => ({
            async send(_command, options) {
              sent += 1;
              upstream = options.abortSignal as AbortSignal;
              return sdkResponse;
            },
          }),
        },
        client.signal,
      );
      const reading = response.text();
      await until(() => waiting);
      expect(accountQueueDepth(f.fixture.primary.id)).toBe(1);
      client.abort(new DOMException("Synthetic client cancellation", "AbortError"));
      expect(await reading).not.toContain('"type":"response.completed"');
      await until(() => returns > 0 && accountQueueDepth(f.fixture.primary.id) === 0);
      expect(upstream?.aborted).toBe(true);
      expect(sent).toBe(1);
      expect(f.state.captures).toBe(0);
    } finally {
      finishRead?.({ done: true, value: undefined });
      f.fixture.database.close();
    }
  });
});
