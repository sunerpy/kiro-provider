interface QueueEntry {
	tail: Promise<void>;
	waiters: number;
}

const sessionQueues = new Map<string, QueueEntry>();
const accountQueues = new Map<string, QueueEntry>();

export interface PipelineDeadline {
	readonly signal: AbortSignal;
	readonly dispose: () => void;
}

export function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The request was aborted", "AbortError");
}

export function abortable<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
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

export function acquireSessionQueue(
	key: string,
	signal: AbortSignal,
): Promise<() => void> {
	return acquireKeyedQueue(sessionQueues, key, signal);
}

export function acquireAccountQueue(
	accountId: string,
	signal: AbortSignal,
): Promise<() => void> {
	return acquireKeyedQueue(accountQueues, accountId, signal);
}

export function createPipelineDeadline(
	provided: AbortSignal | undefined,
	timeoutMs: number,
): PipelineDeadline {
	if (provided) return { signal: provided, dispose: () => undefined };
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException("Request deadline exceeded", "TimeoutError"),
			),
		timeoutMs,
	);
	return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
