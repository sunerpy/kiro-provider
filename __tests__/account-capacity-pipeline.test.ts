import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config/schema.js";
import { pendingAccountCapacityCount } from "../src/core/account-capacity.js";
import { AccountSelector, selectableCandidates } from "../src/core/account-selection.js";
import { runChatCompletion } from "../src/core/pipeline.js";
import { abortable, accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import type { PipelineReasoningReplayStore } from "../src/core/pipeline-types.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";
import { fidelityFixture, nativeResponse } from "./responses-fidelity-helpers.js";

function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 500;
  while (!check() && performance.now() < deadline) await Bun.sleep(2);
  expect(check()).toBe(true);
}

function capacityFixture(count = 3, config: Partial<Config> = {}) {
  const f = fidelityFixture({
    config: {
      request_timeout_ms: 5000,
      stream_idle_timeout_ms: 2000,
      retry_empty_completion: false,
      ...config,
    },
  });
  const accounts = Array.from(
    { length: count },
    (_, index): ManagedAccount => ({
      ...f.primary,
      id: `${f.primary.id}-${index}`,
      profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture-${index}`,
      usedCount: index * 1000,
      limitCount: 100000,
    }),
  );
  const selector = new AccountSelector("lowest-usage");
  const finish = gate();
  const accountFinishes = new Map(accounts.map((account) => [account.id, gate()]));
  const sent: Array<{ accountId: string; conversationId: string; model: string }> = [];
  const active = new Map<string, number>();
  let peak = 0;
  let perAccountPeak = 0;
  let cleaned = 0;
  const dependencies: RouteDependencies = {
    ...f.dependencies,
    accountManager: {
      ...f.dependencies.accountManager,
      reconcileFromDb: () => accounts,
      getAccountCount: () => accounts.length,
      selectHealthyAccount: (preferred, eligible) => {
        const candidates = selectableCandidates(accounts, Date.now(), eligible);
        if (candidates.length === 0) return null;
        const selected = selector.pick(candidates, preferred);
        selected.usedCount = (selected.usedCount ?? 0) + 1;
        return selected;
      },
    },
    runPipeline: runChatCompletion,
    makeClient: (_auth, _region, _effort, _endpoint, _proxy, accountId) => ({
      async send(command, options) {
        const id = accountId as string;
        sent.push({
          accountId: id,
          conversationId: command.input.conversationState?.conversationId as string,
          model: command.input.conversationState?.currentMessage?.userInputMessage
            ?.modelId as string,
        });
        active.set(id, (active.get(id) ?? 0) + 1);
        peak = Math.max(
          peak,
          [...active.values()].reduce((sum, value) => sum + value, 0),
        );
        perAccountPeak = Math.max(perAccountPeak, active.get(id) ?? 0);
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              try {
                const accountFinish = accountFinishes.get(id);
                if (!accountFinish) throw new Error("Unknown fixture account");
                yield { assistantResponseEvent: { content: "FIXTURE_OK" } };
                await abortable(
                  Promise.race([finish.promise, accountFinish.promise]),
                  options.abortSignal as AbortSignal,
                );
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                };
              } finally {
                active.set(id, (active.get(id) ?? 1) - 1);
                cleaned++;
              }
            },
          },
        };
      },
    }),
  };
  const consume = async (response: Response) => ({
    status: response.status,
    text: await response.text(),
  });
  return {
    ...f,
    accounts,
    dependencies,
    sent,
    finish: finish.open,
    finishAccount: (accountId: string) => accountFinishes.get(accountId)?.open(),
    metrics: () => ({ peak, perAccountPeak, cleaned }),
    messages(session: string, agent?: string, signal?: AbortSignal, tenantId = "fixture-tenant") {
      return handleMessages(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": session,
            ...(agent ? { "x-claude-code-agent-id": agent } : {}),
          },
          body: JSON.stringify({
            model: "claude-opus-5",
            stream: true,
            max_tokens: 1024,
            messages: [{ role: "user", content: "synthetic capacity fixture" }],
          }),
          signal,
        }),
        f.config,
        { ...dependencies, tenantId },
      ).then(consume);
    },
    responses(thread: string, signal?: AbortSignal) {
      return handleResponses(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            store: false,
            stream: true,
            input: "synthetic capacity fixture",
            client_metadata: { thread_id: thread },
          }),
          signal,
        }),
        f.config,
        dependencies,
      ).then(consume);
    },
  };
}

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

describe("shared account capacity admission", () => {
  test("uses the first eligible account that becomes free instead of waiting behind a longer stream", async () => {
    const f = capacityFixture(2);
    const running = [f.messages("long-family")];
    try {
      await until(() => f.sent.length === 1);
      const short = f.messages("short-family");
      running.push(short);
      await until(() => f.sent.length === 2);
      const freeNext = f.sent[1]?.accountId as string;
      const third = f.responses("waiting-thread");
      running.push(third);
      await Bun.sleep(20);
      expect(f.sent).toHaveLength(2);
      f.finishAccount(freeNext);
      expect((await short).status).toBe(200);
      await until(() => f.sent.length === 3);
      expect(f.sent[2]?.accountId).toBe(freeNext);
      expect((await third).status).toBe(200);
      expect(f.metrics().perAccountPeak).toBe(1);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("spreads a simultaneous burst over all 39 eligible accounts before any stream finishes", async () => {
    const f = capacityFixture(39);
    const running = Array.from({ length: 39 }, (_, index) => f.responses(`thread-${index}`));
    try {
      await until(() => f.sent.length === 39);
      expect(new Set(f.sent.map((item) => item.accountId)).size).toBe(39);
      expect(f.metrics()).toMatchObject({ peak: 39, perAccountPeak: 1 });
      f.finish();
      const results = await Promise.all(running);
      expect(
        results.every(
          (result) => result.status === 200 && result.text.includes("response.completed"),
        ),
      ).toBe(true);
      await until(() => f.metrics().cleaned === 39);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("runs independent Claude clients, siblings and Responses threads in the same pool", async () => {
    const f = capacityFixture(6);
    const running = [
      f.messages("family-a"),
      f.messages("family-a", "child-a"),
      f.messages("family-a", "child-b"),
      f.messages("family-b"),
      f.responses("thread-a"),
      f.responses("thread-b"),
    ];
    try {
      await until(() => f.sent.length === 6);
      expect(new Set(f.sent.map((item) => item.accountId)).size).toBe(6);
      expect(new Set(f.sent.map((item) => item.conversationId)).size).toBe(6);
      expect(f.metrics()).toMatchObject({ peak: 6, perAccountPeak: 1 });
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("keeps successive requests for one true branch ordered", async () => {
    const f = capacityFixture();
    const first = f.messages("family", "same-child");
    const running = [first];
    try {
      await until(() => f.sent.length === 1);
      running.push(f.messages("family", "same-child"));
      await Bun.sleep(20);
      expect(f.sent).toHaveLength(1);
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
      expect(f.sent).toHaveLength(2);
      expect(f.sent[1]?.conversationId).toBe(f.sent[0]?.conversationId);
      expect(f.metrics().perAccountPeak).toBe(1);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("moves a soft binding off a busy account while preserving its tenant scope", async () => {
    const f = capacityFixture(2);
    const account = f.accounts[0] as ManagedAccount;
    const releaseBusy = await acquireAccountQueue(account.id, new AbortController().signal);
    const affinity = {
      keyHash: "fixture-soft-binding",
      source: "responses.client_metadata.thread_id",
    };
    f.database.claimSessionAffinity(
      affinity.keyHash,
      account.id,
      "old-conversation",
      Date.now(),
      60000,
      100,
    );
    const pending = runChatCompletion({
      body: canonicalRequest([message("user", "fixture")], { model: "gpt-5.6-sol", stream: true }),
      model: "gpt-5.6-sol",
      stream: true,
      config: f.config,
      ...f.dependencies,
      affinity,
      affinityStore: f.database,
    }).then((response) => response.text());
    try {
      await until(() => f.sent.length === 1);
      expect(f.sent[0]?.accountId).toBe(f.accounts[1]?.id);
      expect(f.sent[0]?.conversationId).not.toBe("old-conversation");
      expect(f.database.getSessionAffinity(affinity.keyHash)?.accountId).toBe(f.accounts[1]?.id);
    } finally {
      releaseBusy();
      f.finish();
      await pending;
      f.database.close();
    }
  });

  test("never moves owner-bound replay to a free account", async () => {
    const f = capacityFixture(2);
    const owner = f.accounts[0] as ManagedAccount;
    const releaseBusy = await acquireAccountQueue(owner.id, new AbortController().signal);
    const replayStore: PipelineReasoningReplayStore = {
      readiness: () => ({ writable: true, keyringAvailable: true, missingKeyIds: [] }),
      store: () => undefined,
      resolveResponses: (_token, _context, insertBeforeMessage) => ({
        accountId: owner.id,
        conversationId: "owner-conversation",
        replay: {
          insertBeforeMessage,
          content: { kind: "reasoning_text", text: "fixture reasoning", signature: "fixture" },
        },
      }),
      resolveChat: () => {
        throw new Error("unused");
      },
    };
    const pending = runChatCompletion({
      ...f.dependencies,
      config: f.config,
      tenantId: "fixture-tenant",
      reasoningReplayStore: replayStore,
      model: "claude-opus-5",
      stream: true,
      body: canonicalRequest([message("assistant", "prior"), message("user", "continue")], {
        model: "claude-opus-5",
        stream: true,
        reasoningReplays: [
          {
            lookup: { kind: "anthropic-token", signature: "kr1_fixture" },
            outputFingerprint: assistantOutputFingerprint({ text: "prior", toolCalls: [] }),
            insertBeforeMessage: 0,
            path: "fixture",
          },
        ],
      }),
    }).then((response) => response.text());
    try {
      await Bun.sleep(25);
      expect(f.sent).toHaveLength(0);
      releaseBusy();
      await until(() => f.sent.length === 1);
      expect(f.sent[0]).toMatchObject({
        accountId: owner.id,
        conversationId: "owner-conversation",
      });
    } finally {
      releaseBusy();
      f.finish();
      await pending;
      f.database.close();
    }
  });

  test("removes a cancelled queued request and admits the next request exactly once", async () => {
    const f = capacityFixture(1);
    const releaseBusy = await acquireAccountQueue(
      f.accounts[0]?.id as string,
      new AbortController().signal,
    );
    const controller = new AbortController();
    const cancelled = f.messages("cancelled-family", undefined, controller.signal);
    const next = f.responses("next-thread");
    try {
      await Bun.sleep(20);
      controller.abort();
      expect((await cancelled).status).toBe(499);
      expect(f.sent).toHaveLength(0);
      releaseBusy();
      await until(() => f.sent.length === 1);
      f.finish();
      expect((await next).status).toBe(200);
      expect(f.sent).toHaveLength(1);
      await until(() => f.metrics().cleaned === 1);
    } finally {
      releaseBusy();
      f.finish();
      await Promise.allSettled([cancelled, next]);
      f.database.close();
    }
  });

  test("uses idle native capacity for a new Responses request", async () => {
    const f = fidelityFixture({ config: { request_timeout_ms: 2000 } });
    const releaseBusy = await acquireAccountQueue(f.primary.id, new AbortController().signal);
    const pending = f.send({ model: "gpt-5.6-sol", input: "fixture" });
    try {
      await until(() => f.requests.length === 1);
      expect(f.selections[0]?.selected).toBe(f.accounts[1]?.id);
      expect((await pending).status).toBe(200);
    } finally {
      releaseBusy();
      await pending;
      f.database.close();
    }
  });

  test("lets a queued native request use capacity released by the shorter request", async () => {
    const long = gate();
    const short = gate();
    const f = fidelityFixture({
      config: { request_timeout_ms: 5000 },
      native: async (_body, call) => {
        if (call === 1) await long.promise;
        if (call === 2) await short.promise;
        return Response.json(nativeResponse(`resp_capacity_${call}`));
      },
    });
    const running = [f.send({ model: "gpt-5.6-sol", input: "long" })];
    try {
      await until(() => f.requests.length === 1);
      const second = f.send({ model: "gpt-5.6-sol", input: "short" });
      running.push(second);
      await until(() => f.requests.length === 2);
      const third = f.send({ model: "gpt-5.6-sol", input: "queued" });
      running.push(third);
      await Bun.sleep(20);
      expect(f.requests).toHaveLength(2);
      short.open();
      expect((await second).status).toBe(200);
      await until(() => f.requests.length === 3);
      expect(f.selections.at(-1)?.selected).toBe(f.accounts[1]?.id);
      expect((await third).status).toBe(200);
    } finally {
      long.open();
      short.open();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test.each(["messages", "native"] as const)(
    "cancels %s after capacity reservation without dispatching or leaking the lease",
    async (protocol) => {
      const f = capacityFixture(1);
      const controller = new AbortController();
      const original = console.error;
      let cancelled = false;
      console.error = (...args: unknown[]) => {
        original(...args);
        try {
          const event = JSON.parse(String(args[0])) as Record<string, unknown>;
          if (
            !cancelled &&
            event.event === "request_queue_wait" &&
            event.queue === "capacity" &&
            event.outcome === "acquired"
          ) {
            cancelled = true;
            controller.abort();
          }
        } catch {}
      };
      try {
        const response =
          protocol === "messages"
            ? await f.messages("cancel-reserved", undefined, controller.signal)
            : await f.send(
                { model: "gpt-5.6-sol", input: "fixture" },
                f.dependencies,
                controller.signal,
              );
        expect(response.status).toBe(499);
        expect(cancelled).toBe(true);
        expect(f.sent).toHaveLength(0);
        expect(f.requests).toHaveLength(0);
        expect(accountQueueDepth(f.accounts[0]?.id as string)).toBe(0);
        expect(pendingAccountCapacityCount()).toBe(0);
        f.finish();
        expect((await f.messages("after-cancel")).status).toBe(200);
      } finally {
        console.error = original;
        f.finish();
        f.database.close();
      }
    },
  );

  test("keeps native continuation on its busy owner even when another account is idle", async () => {
    const f = fidelityFixture();
    const initial = await f.send({ model: "gpt-5.6-sol", input: "fixture" });
    const previous = (await initial.json()) as { id: string };
    const releaseBusy = await acquireAccountQueue(f.primary.id, new AbortController().signal);
    const controller = new AbortController();
    const pending = f.send(
      { model: "gpt-5.6-sol", input: "continue", previous_response_id: previous.id },
      {},
      controller.signal,
    );
    try {
      await Bun.sleep(20);
      expect(f.requests).toHaveLength(1);
      controller.abort();
      expect((await pending).status).toBe(499);
      expect(f.requests).toHaveLength(1);
    } finally {
      controller.abort();
      releaseBusy();
      await pending;
      f.database.close();
    }
  });
});
