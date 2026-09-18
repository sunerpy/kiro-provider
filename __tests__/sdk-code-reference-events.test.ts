import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortable } from "../src/core/pipeline-runtime.js";
import { collectSdkResponse } from "../src/kiro/transform/sdk-collector.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { SqliteResponseStore } from "../src/server/responses/store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const text = "synthetic generated code\n".repeat(97);
const references = [
  {
    licenseName: "MIT",
    repository: "fixture/public",
    url: "https://example.invalid/fixture/reference",
    recommendationContentSpan: { start: 0, end: text.length },
  },
] as const;

function rawEvent(value: unknown): SdkStreamEvent {
  return value as SdkStreamEvent;
}

type WireFrame = {
  readonly type: string;
  readonly response?: {
    readonly id: string;
    readonly error?: { readonly code: string };
    readonly x_kiro?: { readonly code_references?: unknown };
  };
  readonly delta?: string | { readonly type?: string; readonly text?: string };
  readonly x_kiro?: { readonly code_references?: unknown };
};

function frames(text: string): WireFrame[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

function referenceFixture(
  options: {
    event?: unknown;
    overloadFirst?: boolean;
    omitCompletion?: boolean;
    stallAfterReference?: boolean;
    timeoutMs?: number;
    responseStore?: AppDependencies["responseStore"];
  } = {},
) {
  const f = fidelityFixture({
    config: {
      request_timeout_ms: options.timeoutMs ?? 5000,
      stream_idle_timeout_ms: 5000,
      max_request_iterations: 3,
      stream_max_attempts: 3,
      rate_limit_max_retries: 2,
      retry_empty_completion: false,
    },
  });
  f.accounts.splice(1);
  const metrics = { sends: 0, cleaned: 0 };
  const release = Promise.withResolvers<void>();
  let referenceSeen = false;
  const histories: unknown[] = [];
  const dependencies: AppDependencies = {
    ...f.dependencies,
    ...(options.responseStore ? { responseStore: options.responseStore } : {}),
    makeClient: () => ({
      async send(command, sendOptions) {
        metrics.sends++;
        histories.push(command.input.conversationState?.history);
        if (options.overloadFirst && metrics.sends === 1) {
          throw Object.assign(new Error("Synthetic upstream overload"), {
            name: "InternalServerException",
            reason: "MODEL_TEMPORARILY_UNAVAILABLE",
            $metadata: { httpStatusCode: 500 },
          });
        }
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              try {
                // Match the reported event ordering, including all 778 text fragments.
                for (let index = 0; index < 778; index++) {
                  yield {
                    assistantResponseEvent: {
                      content: text.slice(
                        Math.floor((index * text.length) / 778),
                        Math.floor(((index + 1) * text.length) / 778),
                      ),
                    },
                  };
                }
                yield rawEvent(
                  options.event ?? {
                    codeReferenceEvent: { references },
                  },
                );
                referenceSeen = true;
                if (options.stallAfterReference) {
                  if (!sendOptions.abortSignal) throw new Error("Missing fixture abort signal");
                  await abortable(release.promise, sendOptions.abortSignal);
                }
                if (!options.omitCompletion) {
                  yield { contextUsageEvent: { contextUsagePercentage: 1 } };
                  yield { meteringEvent: { usage: 1, unit: "credit" } };
                }
              } finally {
                metrics.cleaned++;
              }
            },
          },
        };
      },
    }),
  };
  const app = createApp(f.config, dependencies);
  return {
    ...f,
    metrics,
    app,
    dependencies,
    histories,
    referenceSeen: () => referenceSeen,
    release: () => release.resolve(),
    async request(
      protocol: "responses" | "messages",
      stream: boolean,
      signal?: AbortSignal,
      store = false,
    ) {
      const body =
        protocol === "responses"
          ? {
              model: "gpt-5.6-sol",
              reasoning: { effort: "max" },
              store,
              stream,
              input: [
                { role: "user", content: "Earlier synthetic development task" },
                { role: "assistant", content: "Earlier synthetic result" },
                { role: "user", content: "Continue the synthetic development task" },
              ],
              client_metadata: { thread_id: "code-reference-fixture" },
            }
          : {
              model: "claude-opus-5",
              max_tokens: 4096,
              stream,
              messages: [{ role: "user", content: "Synthetic development task" }],
            };
      return app(
        new Request(`http://fixture/v1/${protocol}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk-fidelity-test",
          },
          body: JSON.stringify(body),
          signal,
        }),
      );
    },
  };
}

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

describe("SDK code reference events through public routes", () => {
  for (const protocol of ["responses", "messages"] as const) {
    for (const stream of [true, false]) {
      test(`${protocol} preserves code references without changing ${stream ? "streamed" : "collected"} text`, async () => {
        const f = referenceFixture();
        try {
          const response = await f.request(protocol, stream);
          expect(response.status).toBe(200);
          const body = await response.text();
          const events = stream ? frames(body) : [];
          const terminal = stream
            ? events.find((event) =>
                protocol === "responses"
                  ? event.type === "response.completed"
                  : event.type === "message_delta",
              )
            : undefined;
          const result = stream
            ? protocol === "responses"
              ? terminal?.response
              : terminal
            : JSON.parse(body);
          expect(result?.x_kiro?.code_references).toEqual(references);
          const visible = stream
            ? events
                .filter((event) =>
                  protocol === "responses"
                    ? event.type === "response.output_text.delta"
                    : event.type === "content_block_delta" &&
                      typeof event.delta === "object" &&
                      event.delta?.type === "text_delta",
                )
                .map((event) =>
                  typeof event.delta === "string" ? event.delta : (event.delta?.text ?? ""),
                )
                .join("")
            : protocol === "responses"
              ? result.output.find((item: { type: string }) => item.type === "message").content[0]
                  .text
              : result.content.find((item: { type: string }) => item.type === "text").text;
          expect(visible).toBe(text);
          expect(body).not.toContain("unsupported_upstream_event");
          expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
          const logged = JSON.stringify(audit.events());
          expect(logged).not.toContain(references[0].url);
          expect(logged).not.toContain(references[0].repository);
        } finally {
          f.database.close();
        }
      });
    }
  }

  test("retains the original overload retry then completes the accepted Sol stream exactly once", async () => {
    const f = referenceFixture({ overloadFirst: true });
    try {
      const response = await f.request("responses", true);
      const events = frames(await response.text());
      expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "response.failed")).toHaveLength(0);
      expect(f.metrics).toEqual({ sends: 2, cleaned: 1 });
      expect(audit.events("request_cleanup_complete")).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

  test("empty reference metadata cannot substitute for completion", async () => {
    const f = referenceFixture({
      event: { codeReferenceEvent: { references: [] } },
      omitCompletion: true,
    });
    try {
      const events = frames(await (await f.request("responses", true)).text());
      expect(events.find((event) => event.type === "response.failed")?.response?.error?.code).toBe(
        "upstream_stream_incomplete",
      );
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
    } finally {
      f.database.close();
    }
  });

  test("rejects unauthenticated requests before any SDK dispatch", async () => {
    const f = referenceFixture();
    try {
      const response = await f.app(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "fixture" }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(response.status).toBe(401);
      expect(f.metrics).toEqual({ sends: 0, cleaned: 0 });
    } finally {
      f.database.close();
    }
  });

  test("cancels after references without completing or leaking the single account lease", async () => {
    const f = referenceFixture({ stallAfterReference: true });
    const abort = new AbortController();
    let reading: Promise<string> | undefined;
    try {
      reading = (await f.request("responses", true, abort.signal)).text().catch(() => "");
      const deadline = performance.now() + 1500;
      while (!f.referenceSeen() && performance.now() < deadline) await Bun.sleep(2);
      expect(f.referenceSeen()).toBe(true);
      abort.abort();
      const body = await reading;
      expect(body).not.toContain("response.completed");
      expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
      f.release();
      const next = frames(await (await f.request("responses", true)).text());
      expect(next.filter((event) => event.type === "response.completed")).toHaveLength(1);
      expect(f.metrics).toEqual({ sends: 2, cleaned: 2 });
    } finally {
      abort.abort();
      f.release();
      await reading;
      f.database.close();
    }
  });

  test("keeps the deadline authoritative after a reference event", async () => {
    const f = referenceFixture({ stallAfterReference: true, timeoutMs: 1200 });
    try {
      const events = frames(await (await f.request("responses", true)).text());
      expect(f.referenceSeen()).toBe(true);
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(events.find((event) => event.type === "response.failed")?.response?.error?.code).toBe(
        "request_deadline_exceeded",
      );
      expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
    } finally {
      f.release();
      f.database.close();
    }
  });

  test("persists attribution across database reopening without adding it to replay history or another tenant", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-reference-store-"));
    const file = join(root, "state.db");
    let database = new AccountsDatabase(file);
    const f = referenceFixture({ responseStore: new SqliteResponseStore(database) });
    try {
      const events = frames(await (await f.request("responses", true, undefined, true)).text());
      const completed = events.find((event) => event.type === "response.completed")?.response;
      expect(completed?.x_kiro?.code_references).toEqual(references);
      if (!completed) throw new Error("Missing stored response");
      database.close();
      database = new AccountsDatabase(file);
      const app = createApp(
        { ...f.config, api_keys: ["sk-fidelity-test", "sk-other-fixture"] },
        { ...f.dependencies, responseStore: new SqliteResponseStore(database) },
      );
      const stored = await app(
        new Request(`http://fixture/v1/responses/${completed.id}`, {
          headers: { Authorization: "Bearer sk-fidelity-test" },
        }),
      );
      expect(stored.status).toBe(200);
      expect(await stored.json()).toHaveProperty("x_kiro.code_references", references);
      const otherTenant = await app(
        new Request(`http://fixture/v1/responses/${completed.id}`, {
          headers: { Authorization: "Bearer sk-other-fixture" },
        }),
      );
      expect(otherTenant.status).toBe(404);
      const continued = await app(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: { Authorization: "Bearer sk-fidelity-test", "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            reasoning: { effort: "max" },
            store: false,
            previous_response_id: completed.id,
            input: "Continue the fixture",
            stream: false,
          }),
        }),
      );
      expect(continued.status).toBe(200);
      expect(await continued.json()).toHaveProperty("x_kiro.code_references", references);
      expect(f.histories).toHaveLength(2);
      expect(JSON.stringify(f.histories[1])).not.toContain(references[0].url);
      expect(JSON.stringify(f.histories[1])).not.toContain(references[0].repository);
    } finally {
      database.close();
      f.database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const event of [
    { codeReferenceEvent: null },
    { codeReferenceEvent: { references: "not-an-array" } },
    { codeReferenceEvent: { references: [{ privatePayload: "must-not-leak" }] } },
    { codeReferenceEvent: { references: [{ recommendationContentSpan: { start: -1 } }] } },
  ]) {
    test(`rejects malformed reference metadata: ${JSON.stringify(event)}`, async () => {
      const f = referenceFixture({ event });
      try {
        const body = await (await f.request("responses", true)).text();
        const failure = frames(body).find((item) => item.type === "response.failed");
        expect(failure?.response?.error?.code).toBe("invalid_upstream_response");
        expect(body).not.toContain("must-not-leak");
        expect(JSON.stringify(audit.events())).not.toContain("must-not-leak");
        expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
      } finally {
        f.database.close();
      }
    });
  }

  test("continues to reject unrelated unknown events without replaying accepted output", async () => {
    const f = referenceFixture({ event: { $unknown: ["futureEvent", {}] } });
    try {
      const events = frames(await (await f.request("responses", true)).text());
      expect(events.find((event) => event.type === "response.failed")?.response?.error?.code).toBe(
        "unsupported_upstream_event",
      );
      expect(f.metrics).toEqual({ sends: 1, cleaned: 1 });
    } finally {
      f.database.close();
    }
  });

  test("keeps the original signed assistant fingerprint and reasoning bytes", async () => {
    let capturedFingerprint: string | undefined;
    const completion = await collectSdkResponse(
      {
        generateAssistantResponseResponse: {
          async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
            yield {
              reasoningContentEvent: { text: "synthetic reasoning", signature: "signature" },
            };
            yield { assistantResponseEvent: { content: text } };
            yield rawEvent({ codeReferenceEvent: { references } });
            yield {
              metadataEvent: { tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
            };
          },
        },
      },
      "claude-opus-5",
      "fixture-conversation",
      undefined,
      {
        emitAnthropicReasoningMetadata: true,
        captureReasoning: (_reasoning, fingerprint) => {
          capturedFingerprint = fingerprint;
          return "opaque-fixture";
        },
      },
    );
    expect(completion.text).toBe(text);
    expect(completion.reasoning?.signature).toBe("signature");
    expect(capturedFingerprint).toBe(assistantOutputFingerprint({ text, toolCalls: [] }));
  });
});
