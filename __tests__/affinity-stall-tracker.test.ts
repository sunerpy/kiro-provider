import { describe, expect, test } from "bun:test";
import { AffinityStallTracker } from "../src/core/affinity-stall.js";

/**
 * Short-term per-affinity failure state. The tracker only ever holds a key
 * hash, a count, two timestamps, and the ids of the accounts that stalled, so
 * nothing here can leak a session id or any model-visible payload.
 */

const WINDOW = 600_000;
const MAX = 100;

describe("AffinityStallTracker", () => {
  test("counts consecutive stalls inside the window and keeps the first timestamp", () => {
    const tracker = new AffinityStallTracker();

    expect(tracker.record("key-a", 1_000, WINDOW, MAX)).toEqual({
      count: 1,
      firstAt: 1_000,
      lastAt: 1_000,
      accountIds: new Set<string>(),
    });
    expect(tracker.record("key-a", 300_000, WINDOW, MAX)).toEqual({
      count: 2,
      firstAt: 1_000,
      lastAt: 300_000,
      accountIds: new Set<string>(),
    });
    expect(tracker.peek("key-a", 300_001, WINDOW)).toEqual({
      count: 2,
      firstAt: 1_000,
      lastAt: 300_000,
      accountIds: new Set<string>(),
    });
  });

  test("keeps affinity keys independent", () => {
    const tracker = new AffinityStallTracker();

    tracker.record("key-a", 1_000, WINDOW, MAX);
    tracker.record("key-a", 2_000, WINDOW, MAX);
    tracker.record("key-b", 2_000, WINDOW, MAX);

    expect(tracker.peek("key-a", 2_000, WINDOW)?.count).toBe(2);
    expect(tracker.peek("key-b", 2_000, WINDOW)?.count).toBe(1);
  });

  test("a gap longer than the window restarts the streak", () => {
    const tracker = new AffinityStallTracker();

    tracker.record("key-a", 1_000, WINDOW, MAX);
    const restarted = tracker.record("key-a", 1_000 + WINDOW + 1, WINDOW, MAX);

    expect(restarted).toEqual({
      count: 1,
      firstAt: 1_000 + WINDOW + 1,
      lastAt: 1_000 + WINDOW + 1,
      accountIds: new Set<string>(),
    });
  });

  test("peek drops and reports nothing for an entry older than the window", () => {
    const tracker = new AffinityStallTracker();
    tracker.record("key-a", 1_000, WINDOW, MAX);

    expect(tracker.peek("key-a", 1_000 + WINDOW, WINDOW)).toMatchObject({ count: 1 });
    expect(tracker.peek("key-a", 1_000 + WINDOW + 1, WINDOW)).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  test("peek reports nothing for an unknown key", () => {
    expect(new AffinityStallTracker().peek("missing", 1_000, WINDOW)).toBeUndefined();
  });

  test("clear forgets one key and reset forgets everything", () => {
    const tracker = new AffinityStallTracker();
    tracker.record("key-a", 1_000, WINDOW, MAX);
    tracker.record("key-b", 1_000, WINDOW, MAX);

    tracker.clear("key-a");

    expect(tracker.peek("key-a", 1_000, WINDOW)).toBeUndefined();
    expect(tracker.peek("key-b", 1_000, WINDOW)?.count).toBe(1);

    tracker.reset();

    expect(tracker.size).toBe(0);
  });

  test("prunes expired entries before evicting, and never evicts the key just recorded", () => {
    const tracker = new AffinityStallTracker();
    tracker.record("expired", 1_000, WINDOW, 2);
    tracker.record("fresh", 1_000 + WINDOW, WINDOW, 2);

    const recorded = tracker.record("newest", 1_000 + WINDOW + 1, WINDOW, 2);

    expect(recorded.count).toBe(1);
    expect(tracker.peek("expired", 1_000 + WINDOW + 1, WINDOW)).toBeUndefined();
    expect(tracker.peek("newest", 1_000 + WINDOW + 1, WINDOW)?.count).toBe(1);
    expect(tracker.size).toBeLessThanOrEqual(2);
  });

  test("evicts the least recently stalled key when every entry is still live", () => {
    const tracker = new AffinityStallTracker();
    tracker.record("oldest", 1_000, WINDOW, 2);
    tracker.record("middle", 2_000, WINDOW, 2);

    tracker.record("newest", 3_000, WINDOW, 2);

    expect(tracker.size).toBe(2);
    expect(tracker.peek("oldest", 3_000, WINDOW)).toBeUndefined();
    expect(tracker.peek("middle", 3_000, WINDOW)?.count).toBe(1);
    expect(tracker.peek("newest", 3_000, WINDOW)?.count).toBe(1);
  });

  test("accumulates every account that stalled inside one streak", () => {
    const tracker = new AffinityStallTracker();

    tracker.record("key-a", 1_000, WINDOW, MAX, "account-a");
    const second = tracker.record("key-a", 2_000, WINDOW, MAX, "account-b");

    expect(second.accountIds).toEqual(new Set(["account-a", "account-b"]));
    expect(tracker.peek("key-a", 2_000, WINDOW)?.accountIds).toEqual(
      new Set(["account-a", "account-b"]),
    );
  });

  test("a restarted streak forgets the accounts of the expired one", () => {
    const tracker = new AffinityStallTracker();

    tracker.record("key-a", 1_000, WINDOW, MAX, "account-a");
    const restarted = tracker.record("key-a", 1_000 + WINDOW + 1, WINDOW, MAX, "account-b");

    expect(restarted.accountIds).toEqual(new Set(["account-b"]));
  });
});
