import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { pendingAccountCapacityCount } from "../src/core/account-capacity.js";
import { runChatCompletion } from "../src/core/pipeline.js";
import { abortable, accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture, nativeResponse, sse, textEvents } from "./responses-fidelity-helpers.js";

function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 1000;
  while (!check() && performance.now() < deadline) await Bun.sleep(2);
  expect(check()).toBe(true);
}

type Lane = "messages" | "stateless" | "native";

function fixture(config: Partial<Config> = { account_inference_concurrency: 5 }, accountCount = 1) {
  const f = fidelityFixture({
    config: {
      request_timeout_ms: 4000,
      stream_idle_timeout_ms: 2500,
      retry_empty_completion: false,
      ...config,
    },
  });
  f.accounts.splice(accountCount);
  for (const [index, account] of f.accounts.entries()) {
    account.profileArn = `arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture-${index}`;
    account.accessToken = `fixture-access-${index}`;
  }
  const allFinished = gate();
  const allCleaned = gate();
  const sent: Array<{
    lane: Lane;
    accountId: string;
    conversationId?: string;
    done: ReturnType<typeof gate>;
    cleanup: ReturnType<typeof gate>;
    delayCleanup: boolean;
    cleaned: boolean;
    signal: AbortSignal;
  }> = [];
  let peak = 0;
  let accountPeak = 0;
  let sdkAttempts = 0;
  let nextSdkFailure: unknown;
  const observe = (lane: Lane, accountId: string, signal: AbortSignal, conversationId?: string) => {
    const record = {
      lane,
      accountId,
      signal,
      conversationId,
      done: gate(),
      cleanup: gate(),
      delayCleanup: false,
      cleaned: false,
    };
    sent.push(record);
    const active = sent.filter((item) => !item.cleaned);
    peak = Math.max(peak, active.length);
    accountPeak = Math.max(
      accountPeak,
      active.filter((item) => item.accountId === accountId).length,
    );
    return record;
  };
  const clean = async (record: (typeof sent)[number]) => {
    if (record.delayCleanup) await Promise.race([allCleaned.promise, record.cleanup.promise]);
    record.cleaned = true;
  };
  const dependencies: RouteDependencies = {
    ...f.dependencies,
    runPipeline: runChatCompletion,
    makeClient: (_auth, _region, _effort, _endpoint, _proxy, accountId) => ({
      async send(command, options) {
        sdkAttempts++;
        if (nextSdkFailure !== undefined) {
          const failure = nextSdkFailure;
          nextSdkFailure = undefined;
          throw failure;
        }
        const model = command.input.conversationState?.currentMessage?.userInputMessage?.modelId;
        const record = observe(
          model?.startsWith("claude") ? "messages" : "stateless",
          accountId as string,
          options.abortSignal as AbortSignal,
          command.input.conversationState?.conversationId,
        );
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              try {
                yield { assistantResponseEvent: { content: "FIXTURE_OK" } };
                await abortable(
                  Promise.race([allFinished.promise, record.done.promise]),
                  record.signal,
                );
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                };
              } finally {
                await clean(record);
              }
            },
          },
        };
      },
    }),
    nativeResponsesFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const auth = new Headers(init?.headers).get("authorization");
      const account = f.accounts.find((item) => auth === `Bearer ${item.accessToken}`);
      if (!account) throw new Error("Unknown synthetic credential");
      const record = observe("native", account.id, init?.signal as AbortSignal);
      const id = `resp_capacity_${sent.length}`;
      if (!body.stream) {
        try {
          await abortable(Promise.race([allFinished.promise, record.done.promise]), record.signal);
          return Response.json(nativeResponse(id));
        } finally {
          await clean(record);
        }
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const events = textEvents(id);
            const encoder = new TextEncoder();
            try {
              for (const event of events.slice(0, 4)) {
                controller.enqueue(encoder.encode(sse(event)));
              }
              await abortable(
                Promise.race([allFinished.promise, record.done.promise]),
                record.signal,
              );
              for (const event of events.slice(4)) {
                controller.enqueue(encoder.encode(sse(event)));
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            } finally {
              await clean(record);
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  return {
    ...f,
    sent,
    dependencies,
    metrics: () => ({
      peak,
      accountPeak,
      sdkAttempts,
      active: sent.filter((record) => !record.cleaned).length,
    }),
    failNext: (error: unknown) => {
      nextSdkFailure = error;
    },
    finish: () => {
      allFinished.open();
      allCleaned.open();
    },
    send(
      lane: Lane,
      branch: string,
      options: {
        signal?: AbortSignal;
        tenant?: string;
        stream?: boolean;
        body?: Record<string, unknown>;
      } = {},
    ) {
      const tenant = options.tenant ?? "capacity-tenant";
      const request = new Request(
        `http://fixture/v1/${lane === "messages" ? "messages" : "responses"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(lane === "messages"
              ? {
                  "x-claude-code-session-id": "one-main-process",
                  "x-claude-code-agent-id": branch,
                }
              : {}),
          },
          body: JSON.stringify(
            lane === "messages"
              ? {
                  model: "claude-opus-5",
                  max_tokens: 1024,
                  stream: options.stream ?? true,
                  messages: [{ role: "user", content: "synthetic independent task" }],
                  ...options.body,
                }
              : {
                  model: "gpt-5.6-sol",
                  store: lane === "native",
                  stream: options.stream ?? true,
                  input: "synthetic independent task",
                  client_metadata: { thread_id: branch },
                  ...options.body,
                },
          ),
          signal: options.signal,
        },
      );
      return (lane === "messages" ? handleMessages : handleResponses)(request, f.config, {
        ...dependencies,
        tenantId: tenant,
      }).then(async (response) => ({ status: response.status, text: await response.text() }));
    },
  };
}

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

describe("configurable inference slots through public protocol routes", () => {
  test.each([undefined, 1, 3, 5, 10])(
    "enforces capacity %s, admits a waiting request on any released slot, and drains cleanly",
    async (configured) => {
      const limit = configured ?? 10;
      const f = fixture(
        configured === undefined ? {} : { account_inference_concurrency: configured },
      );
      const running = Array.from({ length: limit + 2 }, (_, index) =>
        f.send(index % 2 ? "stateless" : "messages", `branch-${index}`),
      );
      try {
        await until(() => f.sent.length === limit);
        expect(f.metrics()).toMatchObject({ peak: limit, accountPeak: limit });
        await Bun.sleep(20);
        expect(f.sent).toHaveLength(limit);
        expect(accountQueueDepth(f.primary.id)).toBe(limit);
        f.sent[limit - 1]?.done.open();
        await until(() => f.sent.length === limit + 1);
        if (limit > 1) expect(f.sent[0]?.cleaned).toBe(false);
        expect(f.metrics().accountPeak).toBe(limit);
        f.finish();
        const results = await Promise.all(running);
        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(f.sent).toHaveLength(limit + 2);
        expect(f.metrics()).toMatchObject({ accountPeak: limit, active: 0 });
        // Client terminal delivery precedes asynchronous lease cleanup.
        await until(() => accountQueueDepth(f.primary.id) === 0);
        expect(accountQueueDepth(f.primary.id)).toBe(0);
        expect(pendingAccountCapacityCount()).toBe(0);
      } finally {
        f.finish();
        await Promise.allSettled(running);
        f.database.close();
      }
    },
  );

  test.each([true, false])(
    "shares the five slots with native Responses (stream=%s) without oversubscription",
    async (stream) => {
      const f = fixture();
      const lanes: Lane[] = ["messages", "stateless", "native", "messages", "native", "native"];
      const running = lanes.map((lane, index) =>
        f.send(lane, `mixed-${index}`, { stream: lane === "native" ? stream : true }),
      );
      try {
        await until(() => f.sent.length === 5);
        await Bun.sleep(20);
        expect(f.sent).toHaveLength(5);
        expect(new Set(f.sent.map((record) => record.lane))).toEqual(
          new Set(["messages", "stateless", "native"]),
        );
        expect(new Set(f.sent.map((record) => record.accountId))).toEqual(new Set([f.primary.id]));
        f.sent[2]?.done.open();
        await until(() => f.sent.length === 6);
        expect(f.metrics().accountPeak).toBe(5);
        f.finish();
        expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
        await until(() => accountQueueDepth(f.primary.id) === 0);
        expect(accountQueueDepth(f.primary.id)).toBe(0);
      } finally {
        f.finish();
        await Promise.allSettled(running);
        f.database.close();
      }
    },
  );

  test.each(["messages", "stateless", "native"] as const)(
    "orders one %s branch while independent siblings and tenants make progress",
    async (lane) => {
      const f = fixture();
      const running = [f.send(lane, "same-branch")];
      try {
        await until(() => f.sent.length === 1);
        running.push(f.send(lane, "same-branch"));
        running.push(f.send(lane, "different-child"));
        running.push(f.send(lane, "same-branch", { tenant: "other-tenant" }));
        await until(() => f.sent.length === 3);
        await Bun.sleep(20);
        expect(f.sent).toHaveLength(3);
        f.sent[0]?.done.open();
        await until(() => f.sent.length === 4);
        if (lane !== "native") {
          expect(f.sent[3]?.conversationId).toBe(f.sent[0]?.conversationId);
        }
        f.finish();
        expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
      } finally {
        f.finish();
        await Promise.allSettled(running);
        f.database.close();
      }
    },
  );

  test("uses the same execution lock when a Responses branch changes native/stateless lanes", async () => {
    const f = fixture();
    const running = [f.send("native", "shared-thread")];
    try {
      await until(() => f.sent.length === 1);
      running.push(f.send("stateless", "shared-thread"));
      running.push(f.send("messages", "independent-child"));
      await until(() => f.sent.length === 2);
      await Bun.sleep(20);
      expect(f.sent.map((record) => record.lane)).toEqual(["native", "messages"]);
      f.sent[0]?.done.open();
      await until(() => f.sent.length === 3);
      expect(f.sent[2]?.lane).toBe("stateless");
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("cancels a queued request without taking a slot or starving its successor", async () => {
    const f = fixture();
    const running = Array.from({ length: 5 }, (_, index) => f.send("messages", `active-${index}`));
    const controller = new AbortController();
    try {
      await until(() => f.sent.length === 5);
      const cancelled = f.send("stateless", "cancelled", { signal: controller.signal });
      running.push(cancelled);
      running.push(f.send("native", "next"));
      await Bun.sleep(20);
      controller.abort();
      expect((await cancelled).status).toBe(499);
      expect(f.sent).toHaveLength(5);
      f.sent[4]?.done.open();
      await until(() => f.sent.length === 6);
      expect(f.sent[5]?.lane).toBe("native");
      f.finish();
      await Promise.all(running);
      expect(f.sent).toHaveLength(6);
      await until(() => accountQueueDepth(f.primary.id) === 0);
      expect(accountQueueDepth(f.primary.id)).toBe(0);
      expect(pendingAccountCapacityCount()).toBe(0);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("retains a cancelled accepted stream's slot until upstream cleanup finishes", async () => {
    const f = fixture();
    const controller = new AbortController();
    const running = [
      f.send("messages", "cancel-active", { signal: controller.signal }),
      ...Array.from({ length: 4 }, (_, index) => f.send("stateless", `other-${index}`)),
    ];
    try {
      await until(() => f.sent.length === 5);
      const cancelled = f.sent.find((record) => record.lane === "messages");
      if (!cancelled) throw new Error("Missing synthetic accepted stream");
      cancelled.delayCleanup = true;
      running.push(f.send("messages", "replacement"));
      controller.abort();
      await until(() => cancelled.signal.aborted);
      await Bun.sleep(20);
      expect(f.sent).toHaveLength(5);
      expect(accountQueueDepth(f.primary.id)).toBe(5);
      cancelled.cleanup.open();
      await until(() => f.sent.length === 6);
      expect(f.metrics().accountPeak).toBe(5);
      f.finish();
      await Promise.allSettled(running);
      expect(f.sent).toHaveLength(6);
      await until(() => accountQueueDepth(f.primary.id) === 0);
      expect(accountQueueDepth(f.primary.id)).toBe(0);
      expect(f.metrics().active).toBe(0);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("keeps native continuation ownership while using five slots of that account", async () => {
    const f = fixture({ account_inference_concurrency: 5 }, 2);
    for (let index = 0; index < 6; index++) {
      const response = nativeResponse(`resp_owner_${index}`);
      f.responseStore.putNative(
        "capacity-tenant",
        response as unknown as Parameters<typeof f.responseStore.putNative>[1],
        [],
        {
          transport: "native",
          owner: {
            accountId: f.primary.id,
            region: f.primary.region,
            profileArn: f.primary.profileArn,
            responseId: `resp_owner_${index}`,
          },
          request: { model: "gpt-5.6-sol", input: "fixture", stream: true },
          output: response.output as never[],
          tools: [],
        },
      );
    }
    const running = Array.from({ length: 6 }, (_, index) =>
      f.send("native", `owner-branch-${index}`, {
        body: { previous_response_id: `resp_owner_${index}` },
      }),
    );
    try {
      await until(() => f.sent.length === 5);
      expect(f.sent.every((record) => record.accountId === f.primary.id)).toBe(true);
      running.push(f.send("messages", "unrelated"));
      await until(() => f.sent.length === 6);
      expect(f.sent[5]?.accountId).toBe(f.accounts[1]?.id);
      f.sent[0]?.done.open();
      await until(() => f.sent.length === 7);
      expect(f.sent[6]?.accountId).toBe(f.primary.id);
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("serializes a native continuation without explicit branch metadata on its previous response", async () => {
    const f = fixture();
    const initial = f.send("native", "seed", { stream: false });
    const running = [initial];
    try {
      await until(() => f.sent.length === 1);
      f.sent[0]?.done.open();
      const previous = JSON.parse((await initial).text) as { id: string };
      const options = {
        body: { previous_response_id: previous.id, client_metadata: undefined },
      };
      running.push(f.send("native", "ignored", options));
      await until(() => f.sent.length === 2);
      running.push(f.send("native", "ignored", options));
      running.push(f.send("messages", "independent"));
      await until(() => f.sent.length === 3);
      await Bun.sleep(20);
      expect(f.sent).toHaveLength(3);
      expect(f.sent[2]?.lane).toBe("messages");
      f.sent[1]?.done.open();
      await until(() => f.sent.length === 4);
      expect(f.sent[3]?.accountId).toBe(f.primary.id);
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("times out while all ten slots are held, detaches the waiter, and serves the next request", async () => {
    const f = fixture({ account_inference_concurrency: 10, request_timeout_ms: 35 });
    const releases = await Promise.all(
      Array.from({ length: 10 }, () =>
        acquireAccountQueue(f.primary.id, new AbortController().signal, 10),
      ),
    );
    try {
      const result = await f.send("native", "deadline");
      expect(result.status).toBe(504);
      expect(f.sent).toHaveLength(0);
      expect(accountQueueDepth(f.primary.id)).toBe(10);
      expect(pendingAccountCapacityCount()).toBe(0);
      for (const release of releases) release();
      f.finish();
      expect((await f.send("native", "deadline")).status).toBe(200);
      expect(f.sent).toHaveLength(1);
      expect(accountQueueDepth(f.primary.id)).toBe(0);
    } finally {
      for (const release of releases) release();
      f.finish();
      f.database.close();
    }
  });

  test("a pre-acceptance failure releases only its reservation and does not replay accepted siblings", async () => {
    const f = fixture();
    const running = Array.from({ length: 5 }, (_, index) =>
      f.send("messages", `accepted-${index}`),
    );
    try {
      await until(() => f.sent.length === 5);
      const failed = f.send("messages", "fail-before-acceptance");
      running.push(failed, f.send("stateless", "successor"));
      f.failNext({
        name: "ValidationException",
        message: "synthetic invalid request",
        $metadata: { httpStatusCode: 400 },
      });
      f.sent[4]?.done.open();
      expect((await failed).status).toBe(400);
      await until(() => f.sent.length === 6);
      expect(f.metrics()).toMatchObject({ accountPeak: 5, sdkAttempts: 7 });
      f.finish();
      await Promise.all(running);
      expect(f.sent).toHaveLength(6);
      await until(() => accountQueueDepth(f.primary.id) === 0);
      expect(accountQueueDepth(f.primary.id)).toBe(0);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });
});

describe("inference capacity configuration and lease lifecycle", () => {
  test("defaults to ten, accepts 1–10, and applies environment precedence", () => {
    expect(ConfigSchema.parse({ api_keys: ["fixture"] }).account_inference_concurrency).toBe(10);
    for (const capacity of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(
        ConfigSchema.parse({
          api_keys: ["fixture"],
          account_inference_concurrency: capacity,
        }).account_inference_concurrency,
      ).toBe(capacity);
    }
    for (const capacity of [0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        ConfigSchema.safeParse({
          api_keys: ["fixture"],
          account_inference_concurrency: capacity,
        }).success,
      ).toBe(false);
    }
    const directory = mkdtempSync(join(tmpdir(), "kiro-capacity-config-"));
    const path = join(directory, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ api_keys: ["fixture"], account_inference_concurrency: 1 }),
        { mode: 0o600 },
      );
      const env = { KIRO_PROVIDER_ACCOUNT_INFERENCE_CONCURRENCY: "3" };
      expect(loadConfig({ configPath: path, env }).account_inference_concurrency).toBe(3);
      expect(
        loadConfig({
          configPath: path,
          env,
          overrides: { account_inference_concurrency: 10 },
        }).account_inference_concurrency,
      ).toBe(10);
      expect(() =>
        loadConfig({
          configPath: path,
          env: { KIRO_PROVIDER_ACCOUNT_INFERENCE_CONCURRENCY: "11" },
        }),
      ).toThrow(/account_inference_concurrency/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reserves synchronously, wakes on any slot, and releases each lease only once", async () => {
    const id = "fixture-five-account-slots";
    const signal = new AbortController().signal;
    const first = Array.from({ length: 5 }, () => acquireAccountQueue(id, signal, 5));
    const releases: Array<() => void> = [];
    for (const pending of first) void pending.then((release) => releases.push(release));
    try {
      await until(() => releases.length === 5);
      expect(accountQueueDepth(id)).toBe(5);
      const controller = new AbortController();
      const cancelled = acquireAccountQueue(id, controller.signal, 5).catch(
        (error: unknown) => error,
      );
      const next = acquireAccountQueue(id, signal, 5);
      expect(accountQueueDepth(id)).toBe(7);
      controller.abort();
      expect(await cancelled).toMatchObject({ name: "AbortError" });
      expect(accountQueueDepth(id)).toBe(6);
      releases[4]?.();
      releases[4]?.();
      const releaseNext = await next;
      releases.push(releaseNext);
      expect(accountQueueDepth(id)).toBe(5);
      releaseNext();
      releaseNext();
      expect(accountQueueDepth(id)).toBe(4);
    } finally {
      for (const release of releases) release();
      for (const pending of first) (await pending)();
    }
    expect(accountQueueDepth(id)).toBe(0);
    const aborted = AbortSignal.abort();
    await expect(acquireAccountQueue(id, aborted, 5)).rejects.toMatchObject({ name: "AbortError" });
    for (const invalid of [0, 11, 1.5]) {
      await expect(acquireAccountQueue(id, signal, invalid)).rejects.toBeInstanceOf(RangeError);
    }
    expect(accountQueueDepth(id)).toBe(0);
  });
});
