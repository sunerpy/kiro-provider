let requestQueue: Promise<void> = Promise.resolve();

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

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return abortable(Bun.sleep(ms), signal);
}

export async function acquirePipelineQueue(
	signal: AbortSignal,
): Promise<() => void> {
	const previous = requestQueue;
	let releaseGate: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	if (!releaseGate) throw new TypeError("Queue release was not initialized");
	const release = releaseGate;
	requestQueue = previous.catch(() => undefined).then(() => gate);
	try {
		await abortable(previous, signal);
	} catch (error) {
		release();
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
	};
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
