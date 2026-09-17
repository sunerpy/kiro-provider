import { describe, expect, test } from "bun:test";
import {
  type AccountCapacityDecision,
  pendingAccountCapacityCount,
  reserveAccountCapacity,
} from "../src/core/account-capacity.js";
import { accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";

const select = (ids: readonly string[], value: string): AccountCapacityDecision<string> => {
  const accountId = ids.find((id) => accountQueueDepth(id) === 0);
  return accountId
    ? { kind: "ready", value, accountId }
    : { kind: "wait", accountIds: new Set(ids) };
};

describe("shared capacity admission lifecycle", () => {
  test("preserves FIFO for an account without blocking unrelated eligible capacity", async () => {
    const signal = new AbortController().signal;
    const releaseA = await acquireAccountQueue("admission-a", signal);
    const releaseB = await acquireAccountQueue("admission-b", signal);
    const order: string[] = [];
    const first = reserveAccountCapacity(() => select(["admission-a"], "owner"), signal);
    const second = reserveAccountCapacity(
      () => select(["admission-a", "admission-b"], "flexible"),
      signal,
    );
    const third = reserveAccountCapacity(() => select(["admission-a"], "later"), signal);
    try {
      expect(pendingAccountCapacityCount()).toBe(3);
      releaseB();
      const flexible = await second;
      order.push(flexible.value);
      const releaseFlexible = await flexible.lease;
      expect(order).toEqual(["flexible"]);
      expect(pendingAccountCapacityCount()).toBe(2);
      releaseFlexible?.();
      releaseA();
      const owner = await first;
      order.push(owner.value);
      const releaseOwner = await owner.lease;
      expect(pendingAccountCapacityCount()).toBe(1);
      releaseOwner?.();
      const later = await third;
      order.push(later.value);
      (await later.lease)?.();
      expect(order).toEqual(["flexible", "owner", "later"]);
      expect(pendingAccountCapacityCount()).toBe(0);
    } finally {
      releaseA();
      releaseB();
    }
  });

  test("removes aborted waiters, rejects failed selection, and preserves capacity for the next request", async () => {
    const signal = new AbortController().signal;
    const release = await acquireAccountQueue("admission-cancel", signal);
    const controller = new AbortController();
    const queued = reserveAccountCapacity(
      () => select(["admission-cancel"], "cancelled"),
      controller.signal,
    );
    const observed = queued.catch((error: unknown) => error);
    controller.abort();
    expect(await observed).toMatchObject({ name: "AbortError" });
    expect(pendingAccountCapacityCount()).toBe(0);
    release();
    await expect(
      reserveAccountCapacity<string>(() => {
        throw new Error("fixture database failed");
      }, signal),
    ).rejects.toThrow("fixture database failed");
    await expect(
      reserveAccountCapacity<string>(() => ({ kind: "wait", accountIds: new Set() }), signal),
    ).rejects.toThrow("eligible candidates");
    const next = await reserveAccountCapacity(() => select(["admission-cancel"], "next"), signal);
    (await next.lease)?.();
    expect(accountQueueDepth("admission-cancel")).toBe(0);
  });

  test("does not reserve after synchronous chooser cancellation or pre-aborted input", async () => {
    const controller = new AbortController();
    await expect(
      reserveAccountCapacity(() => {
        controller.abort();
        return select(["admission-sync-abort"], "unreachable");
      }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      reserveAccountCapacity(
        () => select(["admission-sync-abort"], "unreachable"),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(accountQueueDepth("admission-sync-abort")).toBe(0);
    expect(pendingAccountCapacityCount()).toBe(0);
  });

  test("handles capacity becoming free during another admission without losing the wake-up", async () => {
    const signal = new AbortController().signal;
    const release = await acquireAccountQueue("admission-reentrant-b", signal);
    const older = reserveAccountCapacity(() => select(["admission-reentrant-b"], "older"), signal);
    const newer = reserveAccountCapacity(() => {
      release();
      return select(["admission-reentrant-a"], "newer");
    }, signal);
    const first = await older;
    const second = await newer;
    expect(first.value).toBe("older");
    expect(second.value).toBe("newer");
    (await first.lease)?.();
    (await second.lease)?.();
    expect(pendingAccountCapacityCount()).toBe(0);
  });

  test("never overbooks a busy account even if a selector returns it as ready", async () => {
    const signal = new AbortController().signal;
    const release = await acquireAccountQueue("admission-busy", signal);
    const queued = reserveAccountCapacity(
      () => ({
        kind: "ready",
        value: "ready",
        accountId: "admission-busy",
      }),
      signal,
    );
    expect(accountQueueDepth("admission-busy")).toBe(1);
    release();
    const result = await queued;
    (await result.lease)?.();
    expect(accountQueueDepth("admission-busy")).toBe(0);
    const unavailable = await reserveAccountCapacity(
      () => ({ kind: "ready", value: null }),
      signal,
    );
    expect(unavailable.lease).toBeUndefined();
  });
});
