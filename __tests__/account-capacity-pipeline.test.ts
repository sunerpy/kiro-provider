import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ResponsesRequestSchema } from "../src/server/request-schema.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { responsesSessionAffinity } from "../src/server/session-affinity.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";
import { fidelityFixture, nativeResponse, sse, textEvents } from "./responses-fidelity-helpers.js";

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

function capacityFixture(
  count = 3,
  config: Partial<Config> = {},
  storage: { databasePath?: string; accountPrefix?: string } = {},
) {
  const f = fidelityFixture({
    ...storage,
    config: {
      // Retain the original single-slot saturation regressions explicitly.
      account_inference_concurrency: 1,
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
  const selectedAccounts: string[] = [];
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
        selectedAccounts.push(selected.id);
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
    selectedAccounts,
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
    responses(thread: string, signal?: AbortSignal, model = "gpt-5.6-sol") {
      return handleResponses(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
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

  test.each(["balanced", "session-first"] as const)(
    "never moves owner-bound replay to a free account with %s",
    async (session_affinity_policy) => {
      const f = capacityFixture(2, { session_affinity_policy });
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
    },
  );

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
      config: { request_timeout_ms: 5000, account_inference_concurrency: 1 },
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

  test.each(["balanced", "session-first"] as const)(
    "keeps native continuation on its busy owner with %s even when another account is idle",
    async (session_affinity_policy) => {
      const f = fidelityFixture({
        config: { account_inference_concurrency: 1, session_affinity_policy },
      });
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
    },
  );
});

describe("session-first account routing", () => {
  test.each(["messages", "responses"] as const)(
    "keeps an established %s session on its busier account while a slot remains",
    async (protocol) => {
      const f = capacityFixture(2, {
        session_affinity_policy: "session-first",
        account_inference_concurrency: 3,
      });
      const send = () =>
        protocol === "messages"
          ? f.messages("stable-family", "stable-child")
          : f.responses("stable-thread");
      const running = [send()];
      let releaseBusy = (): void => {};
      try {
        await until(() => f.sent.length === 1);
        const original = f.sent[0];
        if (!original) throw new Error("Expected first dispatch");
        f.finishAccount(original.accountId);
        expect((await running[0])?.status).toBe(200);
        releaseBusy = await acquireAccountQueue(
          original.accountId,
          new AbortController().signal,
          3,
        );
        running.push(send());
        await until(() => f.sent.length === 2);
        expect(f.sent[1]).toMatchObject({
          accountId: original.accountId,
          conversationId: original.conversationId,
        });
        expect((await running[1])?.status).toBe(200);
        expect(accountQueueDepth(original.accountId)).toBe(1);
      } finally {
        releaseBusy();
        f.finish();
        await Promise.allSettled(running);
        f.database.close();
      }
    },
  );

  for (const protocol of ["stateless", "native"] as const) {
    test.each(["full", "unhealthy", "quota", "cooldown", "refresh-backoff", "model"] as const)(
      `${protocol} rebinds an unavailable soft owner (%s) and keeps the replacement afterwards`,
      async (reason) => {
        const f = capacityFixture(2, {
          session_affinity_policy: "session-first",
          account_inference_concurrency: 2,
        });
        const body = ResponsesRequestSchema.parse({
          model: "gpt-5.6-sol",
          input: "fixture",
          client_metadata: { thread_id: "soft-owner-failover" },
        });
        const affinity = responsesSessionAffinity(body, f.dependencies.tenantId);
        if (!affinity) throw new Error("Expected explicit session key");
        const send = async () => {
          if (protocol === "stateless") return f.responses("soft-owner-failover");
          const response = await f.send(body, f.dependencies);
          return { status: response.status, text: await response.text() };
        };
        const releases: Array<() => void> = [];
        f.finish();
        try {
          expect((await send()).status).toBe(200);
          const initial = f.database.getSessionAffinity(affinity.keyHash);
          if (!initial) throw new Error("Expected stored session");
          const original = f.accounts.find((account) => account.id === initial.accountId);
          if (!original) throw new Error("Expected original account");
          const saved = { ...original };
          let excludedByModel = reason === "model";
          if (reason === "full") {
            releases.push(await acquireAccountQueue(original.id, new AbortController().signal, 2));
            releases.push(await acquireAccountQueue(original.id, new AbortController().signal, 2));
          }
          if (reason === "unhealthy") original.isHealthy = false;
          if (reason === "quota") original.usedCount = original.limitCount;
          if (reason === "cooldown") original.rateLimitResetTime = Date.now() + 60000;
          if (reason === "refresh-backoff") original.refreshRetryAt = Date.now() + 60000;
          if (reason === "model") {
            Object.assign(f.dependencies, {
              modelCapabilities: {
                eligibleAccountIds: (_model: string, ids: readonly string[]) =>
                  new Set(ids.filter((id) => !excludedByModel || id !== original.id)),
                ensureAccountModel: async (account: ManagedAccount) => ({
                  supported: !excludedByModel || account.id !== original.id,
                  source: "live" as const,
                }),
                isKnownModel: () => true,
                catalog: () => [],
                readiness: () => ({
                  enabled: true,
                  usable: true,
                  source: "live" as const,
                  freshAccounts: 2,
                  staleAccounts: 0,
                }),
                refreshAccounts: async () => {},
              } satisfies NonNullable<RouteDependencies["modelCapabilities"]>,
            });
          }
          expect((await send()).status).toBe(200);
          const replacement = f.database.getSessionAffinity(affinity.keyHash);
          expect(replacement?.accountId).not.toBe(original.id);
          expect(replacement?.conversationId).not.toBe(initial.conversationId);
          for (const release of releases.splice(0)) release();
          Object.assign(original, saved);
          delete original.refreshRetryAt;
          excludedByModel = false;
          if (!replacement) throw new Error("Expected replacement binding");
          releases.push(
            await acquireAccountQueue(replacement.accountId, new AbortController().signal, 2),
          );
          expect((await send()).status).toBe(200);
          expect(f.database.getSessionAffinity(affinity.keyHash)?.accountId).toBe(
            replacement.accountId,
          );
          expect(f.selectedAccounts).toEqual([
            original.id,
            replacement.accountId,
            replacement.accountId,
          ]);
        } finally {
          for (const release of releases) release();
          f.finish();
          f.database.close();
        }
      },
    );
  }

  test("keeps native sessions unbound under the default balanced policy", async () => {
    const f = fidelityFixture();
    const body = ResponsesRequestSchema.parse({
      model: "gpt-5.6-sol",
      input: "fixture",
      client_metadata: { thread_id: "balanced-native" },
    });
    try {
      await (await f.send(body)).text();
      await (await f.send(body)).text();
      expect(f.selections.map((selection) => selection.selected)).toEqual(
        f.accounts.map((account) => account.id),
      );
      const affinity = responsesSessionAffinity(body, f.dependencies.tenantId);
      if (!affinity) throw new Error("Expected session key");
      expect(f.database.getSessionAffinity(affinity.keyHash)).toBeUndefined();
    } finally {
      f.database.close();
    }
  });

  test("does not publish a replacement native binding before a cancelled stream completes", async () => {
    let cleaned = 0;
    const f = fidelityFixture({
      config: { session_affinity_policy: "session-first", account_inference_concurrency: 1 },
      native: (body, call) =>
        !body.stream
          ? Response.json(nativeResponse(`resp_cancel_policy_${call}`))
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      textEvents(`resp_cancel_policy_${call}`).slice(0, 4).map(sse).join(""),
                    ),
                  );
                },
                cancel() {
                  cleaned++;
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            ),
    });
    const body = ResponsesRequestSchema.parse({
      model: "gpt-5.6-sol",
      input: "fixture",
      client_metadata: { thread_id: "cancel-native-policy" },
    });
    const affinity = responsesSessionAffinity(body, f.dependencies.tenantId);
    if (!affinity) throw new Error("Expected session key");
    let releaseBusy = (): void => {};
    const controller = new AbortController();
    try {
      await (await f.send(body)).text();
      const initial = f.database.getSessionAffinity(affinity.keyHash);
      expect(initial?.accountId).toBe(f.primary.id);
      releaseBusy = await acquireAccountQueue(f.primary.id, new AbortController().signal);
      const response = await f.send({ ...body, stream: true }, {}, controller.signal);
      expect(response.status).toBe(200);
      expect(f.selections.at(-1)?.selected).toBe(f.accounts[1]?.id);
      expect(accountQueueDepth(f.accounts[1]?.id as string)).toBe(1);
      expect(f.database.getSessionAffinity(affinity.keyHash)).toEqual(initial);
      controller.abort();
      await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
      await until(() => cleaned === 1 && accountQueueDepth(f.accounts[1]?.id as string) === 0);
      expect(f.database.getSessionAffinity(affinity.keyHash)).toEqual(initial);
      expect(pendingAccountCapacityCount()).toBe(0);
    } finally {
      controller.abort();
      releaseBusy();
      f.database.close();
    }
  });

  test.each([false, true])(
    "does not replace a native soft binding after an upstream failure (stream=%s)",
    async (stream) => {
      const f = fidelityFixture({
        config: { session_affinity_policy: "session-first", account_inference_concurrency: 1 },
        native: (_body, call) => {
          const response = nativeResponse(`resp_failure_policy_${call}`);
          if (call === 1) return Response.json(response);
          const failed = {
            ...response,
            status: "failed",
            completed_at: null,
            error: { code: "fixture_upstream_failure", message: "Synthetic upstream failure" },
          };
          return stream
            ? new Response(
                [
                  ...textEvents(`resp_failure_policy_${call}`).slice(0, -1),
                  { type: "response.failed", sequence_number: 7, response: failed },
                ]
                  .map(sse)
                  .join(""),
                { headers: { "Content-Type": "text/event-stream" } },
              )
            : Response.json(failed);
        },
      });
      const body = ResponsesRequestSchema.parse({
        model: "gpt-5.6-sol",
        input: "fixture",
        client_metadata: { thread_id: "failed-native-policy" },
      });
      const affinity = responsesSessionAffinity(body, f.dependencies.tenantId);
      if (!affinity) throw new Error("Expected session key");
      let releaseBusy = (): void => {};
      try {
        await (await f.send(body)).text();
        const initial = f.database.getSessionAffinity(affinity.keyHash);
        expect(initial?.accountId).toBe(f.primary.id);
        releaseBusy = await acquireAccountQueue(f.primary.id, new AbortController().signal);
        const response = await f.send({ ...body, stream });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(stream ? "response.failed" : '"status":"failed"');
        expect(f.selections.at(-1)?.selected).toBe(f.accounts[1]?.id);
        expect(f.database.getSessionAffinity(affinity.keyHash)).toEqual(initial);
        expect(accountQueueDepth(f.accounts[1]?.id as string)).toBe(0);
      } finally {
        releaseBusy();
        f.database.close();
      }
    },
  );

  test("scopes identical native session metadata to its authenticated tenant", async () => {
    const f = fidelityFixture({
      config: { session_affinity_policy: "session-first", account_inference_concurrency: 3 },
    });
    const body = {
      model: "gpt-5.6-sol",
      input: "fixture",
      client_metadata: { thread_id: "same-native-thread" },
    };
    const tenants = [f.dependencies.tenantId, "other-native-tenant"];
    try {
      for (const tenantId of tenants) await (await f.send(body, { tenantId })).text();
      const initialAccounts = f.selections.map((selection) => selection.selected);
      expect(new Set(initialAccounts).size).toBe(2);
      for (const [index, tenantId] of tenants.entries()) {
        const accountId = initialAccounts[index];
        if (!accountId) throw new Error("Expected initial tenant account");
        const release = await acquireAccountQueue(accountId, new AbortController().signal, 3);
        try {
          const response = await f.send(body, { tenantId });
          expect(response.status).toBe(200);
          await response.text();
          expect(f.selections.at(-1)?.selected).toBe(accountId);
        } finally {
          release();
        }
      }
      expect(f.requests.every((request) => request.previous_response_id === undefined)).toBe(true);
    } finally {
      f.database.close();
    }
  });

  test("returns a completed native answer when soft-affinity persistence fails and logs only its source enum", async () => {
    const f = fidelityFixture({ config: { session_affinity_policy: "session-first" } });
    const failWrite = (): never => {
      throw new Error("Synthetic affinity write failure");
    };
    try {
      const response = await f.send(
        {
          model: "gpt-5.6-sol",
          input: "synthetic-private-input",
          client_metadata: { thread_id: "synthetic-private-thread" },
        },
        {
          affinityStore: {
            getSessionAffinity: () => undefined,
            claimSessionAffinity: failWrite,
            rebindSessionAffinity: failWrite,
            resolveOutputLineage: () => undefined,
            recordOutputLineage: () => {},
          },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"status":"completed"');
      const logged = audit.events("native_session_affinity_cache_failed");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        level: "warn",
        affinity_source: "responses.client_metadata.thread_id",
      });
      expect(JSON.stringify(logged)).not.toContain("synthetic-private-thread");
      expect(JSON.stringify(logged)).not.toContain("synthetic-private-input");
      expect(accountQueueDepth(f.primary.id)).toBe(0);
    } finally {
      f.database.close();
    }
  });

  test("restores a native explicit binding after reopening its database and scheduler", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-native-session-policy-"));
    const storage = { databasePath: join(directory, "accounts.db"), accountPrefix: randomUUID() };
    const config = {
      session_affinity_policy: "session-first" as const,
      account_inference_concurrency: 3,
    };
    const body = {
      model: "gpt-5.6-sol",
      input: "fixture",
      client_metadata: { thread_id: "native-restart-thread" },
    };
    const first = fidelityFixture({ ...storage, config });
    try {
      expect((await first.send(body)).status).toBe(200);
    } finally {
      first.database.close();
    }
    const second = fidelityFixture({ ...storage, config });
    let releaseBusy = (): void => {};
    try {
      releaseBusy = await acquireAccountQueue(second.primary.id, new AbortController().signal, 3);
      expect((await second.send(body)).status).toBe(200);
      expect(second.selections[0]?.selected).toBe(second.primary.id);
      expect(second.requests[0]?.previous_response_id).toBeUndefined();
    } finally {
      releaseBusy();
      second.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps history-lineage continuations without an explicit session key on their busier account", async () => {
    const f = capacityFixture(2, {
      session_affinity_policy: "session-first",
      account_inference_concurrency: 3,
    });
    const send = async (input: unknown) => {
      const response = await handleResponses(
        new Request("http://fixture/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-sol", store: false, stream: true, input }),
        }),
        f.config,
        f.dependencies,
      );
      return { status: response.status, text: await response.text() };
    };
    let releaseBusy = (): void => {};
    f.finish();
    try {
      expect((await send("initial fixture")).status).toBe(200);
      const initial = f.sent[0];
      if (!initial) throw new Error("Expected initial dispatch");
      releaseBusy = await acquireAccountQueue(initial.accountId, new AbortController().signal, 3);
      const response = await send([
        { role: "user", content: "initial fixture" },
        { role: "assistant", content: "FIXTURE_OK" },
        { role: "user", content: "follow up fixture" },
      ]);
      expect(response.status).toBe(200);
      expect(f.sent[1]).toMatchObject({
        accountId: initial.accountId,
        conversationId: initial.conversationId,
      });
    } finally {
      releaseBusy();
      f.finish();
      f.database.close();
    }
  });

  test("keeps parent, child, sibling, tenant and Responses branches independently bound", async () => {
    const f = capacityFixture(6, {
      session_affinity_policy: "session-first",
      account_inference_concurrency: 3,
    });
    const sends = [
      () => f.messages("fixture-family"),
      () => f.messages("fixture-family", "child-a"),
      () => f.messages("fixture-family", "child-b"),
      () => f.messages("fixture-family", "child-a", undefined, "other-tenant"),
      () => f.responses("fixture-thread-a"),
      () => f.responses("fixture-thread-b"),
    ];
    const running: Array<Promise<{ status: number; text: string }>> = [];
    try {
      for (const send of sends) {
        running.push(send());
        await until(() => f.sent.length === running.length);
      }
      const originals = [...f.sent];
      expect(new Set(originals.map((item) => item.accountId)).size).toBe(6);
      expect(new Set(originals.map((item) => item.conversationId)).size).toBe(6);
      f.finish();
      expect((await Promise.all(running)).every((result) => result.status === 200)).toBe(true);
      for (const [index, send] of sends.entries()) {
        const original = originals[index];
        if (!original) throw new Error("Expected branch dispatch");
        const release = await acquireAccountQueue(
          original.accountId,
          new AbortController().signal,
          3,
        );
        try {
          expect((await send()).status).toBe(200);
          expect(f.sent.at(-1)).toMatchObject({
            accountId: original.accountId,
            conversationId: original.conversationId,
          });
        } finally {
          release();
        }
      }
      expect(f.metrics().cleaned).toBe(12);
      expect(pendingAccountCapacityCount()).toBe(0);
    } finally {
      f.finish();
      await Promise.allSettled(running);
      f.database.close();
    }
  });

  test("restores a persisted session after database and scheduler reconstruction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kiro-session-policy-"));
    const storage = { databasePath: join(directory, "accounts.db"), accountPrefix: randomUUID() };
    const config = {
      session_affinity_policy: "session-first" as const,
      account_inference_concurrency: 3,
    };
    const first = capacityFixture(2, config, storage);
    let original: (typeof first.sent)[number] | undefined;
    const initial = first.responses("restart-thread");
    try {
      await until(() => first.sent.length === 1);
      original = first.sent[0];
      first.finish();
      expect((await initial).status).toBe(200);
    } finally {
      first.finish();
      await initial;
      first.database.close();
    }
    const second = capacityFixture(2, config, storage);
    let releaseBusy = (): void => {};
    try {
      if (!original) throw new Error("Expected initial dispatch");
      releaseBusy = await acquireAccountQueue(original.accountId, new AbortController().signal, 3);
      second.finish();
      expect((await second.responses("restart-thread")).status).toBe(200);
      expect(second.sent[0]).toMatchObject({
        accountId: original.accountId,
        conversationId: original.conversationId,
      });
    } finally {
      releaseBusy();
      second.finish();
      second.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])("keeps native session affinity for stream=%s", async (stream) => {
    const f = fidelityFixture({
      config: {
        session_affinity_policy: "session-first",
        account_inference_concurrency: 3,
      },
      native: (_body, call) =>
        stream
          ? new Response(textEvents(`resp_policy_${call}`).map(sse).join(""), {
              headers: { "Content-Type": "text/event-stream" },
            })
          : Response.json(nativeResponse(`resp_policy_${call}`)),
    });
    const body = {
      model: "gpt-5.6-sol",
      input: "fixture",
      stream,
      client_metadata: { thread_id: "native-stable-thread" },
    };
    let releaseBusy = (): void => {};
    try {
      const initial = await f.send(body);
      expect(initial.status).toBe(200);
      await initial.text();
      releaseBusy = await acquireAccountQueue(f.primary.id, new AbortController().signal, 3);
      const next = await f.send(body);
      expect(next.status).toBe(200);
      await next.text();
      expect(f.selections.map((selection) => selection.selected)).toEqual([
        f.primary.id,
        f.primary.id,
      ]);
      expect(f.requests.every((request) => request.previous_response_id === undefined)).toBe(true);
    } finally {
      releaseBusy();
      f.database.close();
    }
  });

  test.each(["native-first", "stateless-first"] as const)(
    "keeps the same explicit session safe across transport changes: %s",
    async (order) => {
      const f = capacityFixture(2, {
        session_affinity_policy: "session-first",
        account_inference_concurrency: 3,
      });
      const thread = "mixed-transport-thread";
      const native = async () => {
        const response = await f.send(
          {
            model: "gpt-5.6-sol",
            input: "native fixture",
            client_metadata: { thread_id: thread },
          },
          f.dependencies,
        );
        expect(response.status).toBe(200);
        await response.text();
      };
      let releaseBusy = (): void => {};
      const running: Array<Promise<unknown>> = [];
      try {
        if (order === "native-first") {
          await native();
        } else {
          const first = f.responses(thread);
          running.push(first);
          await until(() => f.sent.length === 1);
          f.finish();
          expect((await first).status).toBe(200);
        }
        const selected = f.selectedAccounts[0];
        if (!selected) throw new Error("Expected selected account");
        releaseBusy = await acquireAccountQueue(selected, new AbortController().signal, 3);
        if (order === "native-first") {
          f.finish();
          expect((await f.responses(thread, undefined, "claude-opus-5")).status).toBe(200);
        } else {
          await native();
        }
        expect(f.selectedAccounts).toEqual([selected, selected]);
        expect(f.requests[0]?.previous_response_id).toBeUndefined();
        expect(f.sent[0]?.conversationId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      } finally {
        releaseBusy();
        f.finish();
        await Promise.allSettled(running);
        f.database.close();
      }
    },
  );
});
