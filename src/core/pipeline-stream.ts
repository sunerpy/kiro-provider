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
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const next = await Promise.race([
						iterator.next(),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new StreamIdleTimeoutError(idleTimeoutMs)),
								idleTimeoutMs,
							);
						}),
					]);
					if (timer) clearTimeout(timer);
					if (composedSignal.aborted) throw abortReason(composedSignal);
					if (next.done) {
						controller.close();
						finish();
						return;
					}
					controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
				} catch (error) {
					if (timer) clearTimeout(timer);
					const streamError =
						error instanceof Error
							? error
							: new TypeError("SDK stream failed with a non-Error reason", {
								cause: error,
							});
					streamAbort.abort(streamError);
					controller.error(streamError);
					await cleanup();
					finish();
				}
			},
			async cancel() {
				streamAbort.abort();
				await cleanup();
				finish();
			},
		}),
		{ headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
	);
}
