/**
 * Short-lived, per-process record of consecutive published-stream failures for
 * one session-affinity key.
 *
 * Kiro can leave a single conversation binding wedged: the upstream accepts the
 * request, emits partial output, then stops producing frames until the idle
 * watchdog fires. Every following request that resolves the same stored
 * affinity binding lands on the same wedged account/conversation pair, so a
 * client that immediately re-sends reproduces the stall instead of recovering.
 * This tracker is the memory that lets the *next independent request* notice
 * the pattern and route away from it.
 *
 * Deliberately in-memory and window-bounded:
 *
 * - The state is short-term operational health, not durable provider-owned
 *   data. A restart clearing it is correct, so it stays out of the
 *   tenant-bound schema in `accounts-db.ts`.
 * - Only the affinity key hash, a count, two timestamps, and the ids of the
 *   accounts that stalled are stored. The account ids never leave the process
 *   and are never logged unhashed; no conversation id, prompt, or tool payload
 *   ever enters it.
 */

export interface AffinityStallSnapshot {
  /** Consecutive abnormal published-stream terminals inside the window. */
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  /**
   * The accounts those terminals happened on.
   *
   * Failover has to route away from the account that actually stalled, which is
   * not the same thing as the account the stored binding currently names: a
   * failover rebinds storage to its replacement before that replacement has
   * served anything, so a request that dies afterwards leaves storage pointing
   * at an unproven account while the streak is still armed. Excluding by stored
   * account would then hold out the replacement and re-select the wedged
   * account. Excluding by this set cannot invert that way.
   */
  readonly accountIds: ReadonlySet<string>;
}

interface StallEntry {
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly accountIds: ReadonlySet<string>;
}

export class AffinityStallTracker {
  readonly #entries = new Map<string, StallEntry>();

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Counts one abnormal terminal. A gap longer than `windowMs` since the last
   * one restarts the streak, so an account that stalled once an hour ago never
   * accumulates toward a failover.
   */
  record(
    keyHash: string,
    now: number,
    windowMs: number,
    maxEntries: number,
    accountId?: string,
  ): AffinityStallSnapshot {
    const previous = this.#entries.get(keyHash);
    const continues = previous !== undefined && now - previous.lastAt <= windowMs;
    const accountIds = new Set<string>(continues ? previous.accountIds : []);
    if (accountId !== undefined) accountIds.add(accountId);
    const entry: StallEntry =
      continues && previous !== undefined
        ? { count: previous.count + 1, firstAt: previous.firstAt, lastAt: now, accountIds }
        : { count: 1, firstAt: now, lastAt: now, accountIds };
    this.#entries.set(keyHash, entry);
    if (this.#entries.size > maxEntries) this.#prune(now, windowMs, maxEntries, keyHash);
    return entry;
  }

  /** Reads the live streak, dropping the entry when the window has passed. */
  peek(keyHash: string, now: number, windowMs: number): AffinityStallSnapshot | undefined {
    const entry = this.#entries.get(keyHash);
    if (entry === undefined) return undefined;
    if (now - entry.lastAt > windowMs) {
      this.#entries.delete(keyHash);
      return undefined;
    }
    return entry;
  }

  /** A healthy terminal on this key ends the streak. */
  clear(keyHash: string): void {
    this.#entries.delete(keyHash);
  }

  /** Drops all state. Intended for tests. */
  reset(): void {
    this.#entries.clear();
  }

  #prune(now: number, windowMs: number, maxEntries: number, preserveKey: string): void {
    for (const [keyHash, entry] of this.#entries) {
      if (now - entry.lastAt > windowMs) this.#entries.delete(keyHash);
    }
    if (this.#entries.size <= maxEntries) return;
    const oldestFirst = [...this.#entries.entries()]
      .filter(([keyHash]) => keyHash !== preserveKey)
      .sort((left, right) => left[1].lastAt - right[1].lastAt);
    for (const [keyHash] of oldestFirst) {
      if (this.#entries.size <= maxEntries) return;
      this.#entries.delete(keyHash);
    }
  }
}

/** Process-wide tracker. Tests inject their own through the pipeline options. */
export const affinityStallTracker = new AffinityStallTracker();
