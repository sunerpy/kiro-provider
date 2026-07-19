import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { transformSdkStream } from "../kiro/transform/streaming/sdk-stream-transformer.js";
import { abortReason } from "./pipeline-runtime.js";

export interface PipelineStreamResult {
	readonly sdkResponse: SdkStreamResponse;
	readonly model: string;
	readonly conversationId: string;
}

class StreamIdleTimeoutError extends Error {
	readonly name = "StreamIdleTimeoutError";

	constructor(readonly timeoutMs: number) {
		super(`SDK stream idle timeout after ${timeoutMs}ms`);
	}
}

export function createPipelineStreamResponse(
	result: PipelineStreamResult,
	signal: AbortSignal,
	idleTimeoutMs: number,
	finalize: () => void,
): Response {
	const streamAbort = new AbortController();
	const composedSignal = AbortSignal.any([signal, streamAbort.signal]);
	const iterator = transformSdkStream(
		result.sdkResponse,
		result.model,
		result.conversationId,
		composedSignal,
	)[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	let finalized = false;
	let activeIdleTimer: ReturnType<typeof setTimeout> | undefined;
	const clearIdleTimer = (): void => {
		if (activeIdleTimer === undefined) return;
		clearTimeout(activeIdleTimer);
		activeIdleTimer = undefined;
	};
	const finish = (): void => {
		if (finalized) return;
		finalized = true;
		finalize();
	};
	const cleanup = async (): Promise<void> => {
		await iterator.return?.(undefined);
	};

	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				let removeAbortListener: (() => void) | undefined;
				try {
					const next = await Promise.race([
						iterator.next(),
						new Promise<never>((_resolve, reject) => {
							const onAbort = (): void => {
								clearIdleTimer();
								reject(abortReason(composedSignal));
							};
							removeAbortListener = () =>
								composedSignal.removeEventListener("abort", onAbort);
							composedSignal.addEventListener("abort", onAbort, { once: true });
							activeIdleTimer = setTimeout(() => {
								activeIdleTimer = undefined;
								reject(new StreamIdleTimeoutError(idleTimeoutMs));
							}, idleTimeoutMs);
							if (composedSignal.aborted) onAbort();
						}),
					]);
					if (composedSignal.aborted) throw abortReason(composedSignal);
					if (next.done) {
						controller.close();
						finish();
						return;
					}
					controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
				} catch (error) {
					clearIdleTimer();
					removeAbortListener?.();
					if (streamAbort.signal.aborted) return;
					const streamError =
						error instanceof Error
							? error
							: new TypeError("SDK stream failed with a non-Error reason", {
								cause: error,
							});
					streamAbort.abort(streamError);
					controller.error(streamError);
					try {
						await cleanup();
					} finally {
						finish();
					}
				} finally {
					clearIdleTimer();
					removeAbortListener?.();
				}
			},
				async cancel() {
					clearIdleTimer();
					streamAbort.abort();
					try {
						await cleanup();
					} catch {
						return;
					} finally {
						finish();
					}
				},
		}),
		{ headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
	);
}
