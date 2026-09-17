interface QueueEntry {
  tail: Promise<void>;
  waiters: number;
}

interface AccountWaiter {
  readonly concurrency: number;
  readonly grant: () => void;
}

interface AccountQueueEntry {
  active: number;
  readonly waiting: Set<AccountWaiter>;
}

const sessionQueues = new Map<string, QueueEntry>();
const accountQueues = new Map<string, AccountQueueEntry>();
const accountCapacityListeners = new Set<() => void>();

export interface PipelineDeadline {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The request was aborted", "AbortError");
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Sleeps for `ms` unless the signal aborts first. The underlying timer is
 * cleared on abort so a cancelled request never leaves a stray timer running.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireKeyedQueue(
  queues: Map<string, QueueEntry>,
  key: string,
  signal: AbortSignal,
): Promise<() => void> {
  let entry = queues.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), waiters: 0 };
    queues.set(key, entry);
  }
  const queueEntry = entry;
  const previous = queueEntry.tail;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  if (!releaseGate) throw new TypeError("Queue release was not initialized");
  const release = releaseGate;
  queueEntry.waiters += 1;
  queueEntry.tail = previous.catch(() => undefined).then(() => gate);
  const cleanup = (): void => {
    queueEntry.waiters -= 1;
    if (queueEntry.waiters !== 0) return;
    void queueEntry.tail.finally(() => {
      if (queueEntry.waiters === 0 && queues.get(key) === queueEntry) {
        queues.delete(key);
      }
    });
  };
  try {
    await abortable(previous, signal);
  } catch (error) {
    release();
    cleanup();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    cleanup();
  };
}

export function acquireSessionQueue(key: string, signal: AbortSignal): Promise<() => void> {
  return acquireKeyedQueue(sessionQueues, key, signal);
}

function drainAccountQueue(entry: AccountQueueEntry): void {
  for (const waiter of entry.waiting) {
    if (entry.active >= waiter.concurrency) break;
    entry.waiting.delete(waiter);
    waiter.grant();
  }
}

/**
 * Reserve synchronously, then hand the lease to its caller. Once handed off,
 * cancellation alone does not release it: the stream must finish its upstream
 * cleanup first. Direct internal callers retain the historical limit of one;
 * both gateway transports supply the configured inference concurrency.
 */
export async function acquireAccountQueue(
  accountId: string,
  signal: AbortSignal,
  concurrency = 1,
): Promise<() => void> {
  if (signal.aborted) throw abortReason(signal);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new RangeError("Account inference concurrency must be an integer between 1 and 10");
  }
  let entry = accountQueues.get(accountId);
  if (!entry) {
    entry = { active: 0, waiting: new Set() };
    accountQueues.set(accountId, entry);
  }
  const queueEntry = entry;
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  if (!open) throw new TypeError("Account capacity gate was not initialized");
  const grant = open;
  let acquired = false;
  let released = false;
  const waiter: AccountWaiter = {
    concurrency,
    grant: () => {
      acquired = true;
      queueEntry.active += 1;
      grant();
    },
  };
  const release = (): void => {
    if (released) return;
    released = true;
    if (acquired) queueEntry.active -= 1;
    else queueEntry.waiting.delete(waiter);
    drainAccountQueue(queueEntry);
    if (
      queueEntry.active === 0 &&
      queueEntry.waiting.size === 0 &&
      accountQueues.get(accountId) === queueEntry
    ) {
      accountQueues.delete(accountId);
    }
    for (const listener of accountCapacityListeners) listener();
  };
  queueEntry.waiting.add(waiter);
  drainAccountQueue(queueEntry);
  try {
    await abortable(gate, signal);
    if (signal.aborted) throw abortReason(signal);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** Includes the active lease and queued reservations, even before their first await resolves. */
export function accountQueueDepth(accountId: string): number {
  const entry = accountQueues.get(accountId);
  return entry ? entry.active + entry.waiting.size : 0;
}

/** Internal admission wake-up, synchronous with releasing any reservation. */
export function onAccountCapacityAvailable(listener: () => void): () => void {
  accountCapacityListeners.add(listener);
  return () => accountCapacityListeners.delete(listener);
}

export function createPipelineDeadline(
  provided: AbortSignal | undefined,
  timeoutMs: number,
): PipelineDeadline {
  if (provided) return { signal: provided, dispose: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")),
    timeoutMs,
  );
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
