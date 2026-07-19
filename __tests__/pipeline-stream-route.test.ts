import { describe, expect, test } from "bun:test";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ndjsonToSse } from "../src/server/routes/chat-completions.js";

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolver = resolve;
	});
	if (!resolver) throw new TypeError("deferred resolver was not initialized");
	return { promise, resolve: resolver };
}

function stalledSdkResponse(cleanup: Promise<void>): {
	readonly response: SdkStreamResponse;
	readonly state: { returnCalled: boolean };
} {
	const state = { returnCalled: false };
	const first: SdkStreamEvent = {
		assistantResponseEvent: { content: "partial" },
	};
	return {
		state,
		response: {
			generateAssistantResponseResponse: {
				[Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
					let emitted = false;
					return {
						next(): Promise<IteratorResult<SdkStreamEvent>> {
							if (!emitted) {
								emitted = true;
								return Promise.resolve({ done: false, value: first });
							}
							return new Promise<IteratorResult<SdkStreamEvent>>(
								() => undefined,
							);
						},
						async return(): Promise<IteratorResult<SdkStreamEvent>> {
							state.returnCalled = true;
							await cleanup;
							return { done: true, value: undefined };
						},
					};
				},
			},
		},
	};
}

function failingSdkResponse(): {
	readonly response: SdkStreamResponse;
	readonly state: { returnCalled: boolean };
} {
	const state = { returnCalled: false };
	let emitted = false;
	return {
		state,
		response: {
			generateAssistantResponseResponse: {
				[Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
					return {
						next(): Promise<IteratorResult<SdkStreamEvent>> {
							if (!emitted) {
								emitted = true;
								return Promise.resolve({
									done: false,
									value: { assistantResponseEvent: { content: "partial" } },
								});
							}
							return Promise.reject(new Error("SDK stream failed"));
						},
						return(): Promise<IteratorResult<SdkStreamEvent>> {
							state.returnCalled = true;
							return Promise.resolve({ done: true, value: undefined });
						},
					};
				},
			},
		},
	};
}

describe("pipeline stream route framing", () => {
	test("emits an SSE error frame before stalled SDK cleanup completes", async () => {
		// Given
		const cleanup = deferred();
		const finalized = deferred();
		const sdk = stalledSdkResponse(cleanup.promise);
		const ndjson = createPipelineStreamResponse(
			{
				sdkResponse: sdk.response,
				model: "claude-opus-4-8",
				conversationId: "route-regression",
			},
			new AbortController().signal,
			15,
			finalized.resolve,
		);
		const sse = ndjsonToSse(ndjson, () => undefined);

		// When
		const receivedText = sse.text();
		const beforeCleanup = await Promise.race([
			receivedText.then((text) => ({ kind: "read" as const, text })),
			Bun.sleep(75).then(() => ({ kind: "pending" as const })),
		]);
		cleanup.resolve();
		const received = await receivedText;
		await finalized.promise;

		// Then
		expect(sdk.state.returnCalled).toBe(true);
		expect(received).toStartWith("data: ");
		expect(received).toContain('data: {"error":');
		expect(received).not.toContain("data: [DONE]");
		expect(beforeCleanup.kind).toBe("read");
	});

	test("emits one SSE error frame and tears down the SDK iterator on a mid-stream error", async () => {
		// Given
		const sdk = failingSdkResponse();
		const ndjson = createPipelineStreamResponse(
			{
				sdkResponse: sdk.response,
				model: "claude-opus-4-8",
				conversationId: "route-mid-stream-error",
			},
			new AbortController().signal,
			1_000,
			() => undefined,
		);

		// When
		const received = await ndjsonToSse(ndjson, () => undefined).text();
		const errorFrames = received
			.split("\n\n")
			.filter((frame) => frame.includes('"error"'));

		// Then
		expect(errorFrames).toHaveLength(1);
		expect(received).not.toContain("data: [DONE]");
		expect(sdk.state.returnCalled).toBe(true);
	});
});
