import { DEFAULT_OVERAGE_POLICY, type OveragePolicy } from "../kiro/health.js";
import type { ManagedAccount } from "../kiro/types.js";
import { isSelectableAccount } from "./account-selection.js";
import {
  abortReason,
  accountQueueDepth,
  acquireAccountQueue,
  onAccountCapacityAvailable,
} from "./pipeline-runtime.js";

/**
 * Restrict soft selection to the least occupied eligible accounts. The normal
 * selection strategy and affinity preference break ties within this set.
 *
 * Selection and acquireAccountQueue must run in one synchronous section:
 * acquisition reserves its queue position before yielding, so another request
 * observes that reservation. Owner-bound requests must keep their original
 * owner restriction instead of using this soft-affinity filter.
 */
export function leastQueuedAccountIds(
  accounts: readonly ManagedAccount[],
  eligibleAccountIds?: ReadonlySet<string>,
  policy: OveragePolicy = DEFAULT_OVERAGE_POLICY,
): ReadonlySet<string> {
  const now = Date.now();
  const leastQueued = new Set<string>();
  let minimum = Number.POSITIVE_INFINITY;
  for (const account of accounts) {
    if (
      !(eligibleAccountIds?.has(account.id) ?? true) ||
      !isSelectableAccount(account, now, policy)
    ) {
      continue;
    }
    const depth = accountQueueDepth(account.id);
    if (depth > minimum) continue;
    if (depth < minimum) {
      minimum = depth;
      leastQueued.clear();
    }
    leastQueued.add(account.id);
  }
  return leastQueued;
}

export type AccountCapacityDecision<T> =
  | { readonly kind: "wait"; readonly accountIds: ReadonlySet<string> }
  | { readonly kind: "ready"; readonly value: T; readonly accountId?: string };

export interface AccountCapacityReservation<T> {
  readonly value: T;
  /** The queue position is already reserved when this promise is handed off. */
  readonly lease?: Promise<() => void>;
}

interface PendingAdmission {
  readonly tryStart: () => void;
}

const pendingAdmissions = new Set<PendingAdmission>();
let draining = false;
let drainAgain = false;

function hasFreeAccount(ids: ReadonlySet<string>): boolean {
  for (const id of ids) if (accountQueueDepth(id) === 0) return true;
  return false;
}

function drainAdmissions(): void {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      // FIFO among requests that can use the available capacity. An older
      // owner-bound request cannot block a different account it cannot use.
      for (const pending of [...pendingAdmissions]) pending.tryStart();
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

onAccountCapacityAvailable(drainAdmissions);

/**
 * Wait for any eligible free account, then choose and reserve synchronously.
 * Eligibility is rechecked by the caller on every possible admission. While
 * all remembered candidates remain occupied, wake-ups use only the queue map,
 * avoiding repeated database/replay work for every pending request.
 */
export function reserveAccountCapacity<T>(
  choose: () => AccountCapacityDecision<T>,
  signal: AbortSignal,
): Promise<AccountCapacityReservation<T>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    let waitingFor: ReadonlySet<string> | undefined;
    const detach = (): void => {
      settled = true;
      pendingAdmissions.delete(pending);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      detach();
      reject(abortReason(signal));
    };
    const pending: PendingAdmission = {
      tryStart() {
        if (settled) return;
        if (signal.aborted) return onAbort();
        if (waitingFor && !hasFreeAccount(waitingFor)) return;
        let decision: AccountCapacityDecision<T>;
        try {
          decision = choose();
          if (decision.kind === "wait" && decision.accountIds.size === 0) {
            throw new TypeError("Account capacity wait requires eligible candidates");
          }
        } catch (error) {
          detach();
          reject(error);
          return;
        }
        // A synchronous chooser may itself cause cancellation.
        if (settled) return;
        if (signal.aborted) return onAbort();
        if (decision.kind === "wait") {
          waitingFor = decision.accountIds;
          return;
        }
        if (decision.accountId !== undefined && accountQueueDepth(decision.accountId) > 0) {
          waitingFor = new Set([decision.accountId]);
          return;
        }
        detach();
        const lease =
          decision.accountId === undefined
            ? undefined
            : acquireAccountQueue(decision.accountId, signal);
        // The caller awaits the original promise. Attach rejection handling now
        // so cancellation between reservation and hand-off cannot go unhandled.
        void lease?.catch(() => undefined);
        resolve({ value: decision.value, ...(lease ? { lease } : {}) });
      },
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pendingAdmissions.add(pending);
    drainAdmissions();
  });
}

export function pendingAccountCapacityCount(): number {
  return pendingAdmissions.size;
}
