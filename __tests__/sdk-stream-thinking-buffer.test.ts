import { describe, expect, test } from "bun:test";
import {
	appendReasoningCapture,
	createReasoningCaptureState,
	resolveReasoningCapture,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { transformSdkStream } from "../src/kiro/transform/streaming/sdk-stream-transformer.js";
import {
	collectSdkChunks,
	contentOf,
	makeSdkResponse,
	reasoningOf,
	toolCallOf,
	toolCallStarts,
} from "./sdk-stream-test-helpers.js";

describe("SDK stream protocol fidelity", () => {
	test("preserves thinking-like tags as ordinary assistant text", async () => {
		const exact = "intro <thinking>literal</thinking>\r\n{";
		const chunks = await collectSdkChunks([
			{ assistantResponseEvent: { content: "intro <thin" } },
			{ assistantResponseEvent: { content: "king>literal</thinking>\r\n{" } },
		]);

		expect(contentOf(chunks)).toBe(exact);
		expect(reasoningOf(chunks)).toBe("");
	});

	test("preserves XML, DSML, and bracket pseudo-tool text without tool events", async () => {
		const exact =
			'<invoke name="read"><parameter name="path">/x</parameter></invoke>' +
			'<｜DSML｜function_calls name="grep" {"q":"x"}' +
			'[Called shell with args: {"cmd":"pwd"}]';
		const chunks = await collectSdkChunks([
			{ assistantResponseEvent: { content: exact } },
		]);

		expect(contentOf(chunks)).toBe(exact);
		expect(toolCallStarts(chunks)).toEqual([]);
	});

	test("uses only native reasoningContentEvent for reasoning deltas", async () => {
		const chunks = await collectSdkChunks([
			{ reasoningContentEvent: { text: "native reasoning", signature: "sig" } },
			{ assistantResponseEvent: { content: "answer" } },
		]);

		expect(reasoningOf(chunks)).toBe("native reasoning");
		expect(contentOf(chunks)).toBe("answer");
	});

	test("accepts a trailing signature event without concatenating repeated signatures", () => {
		const state = createReasoningCaptureState();
		appendReasoningCapture(state, { text: "native reasoning" });
		appendReasoningCapture(state, { signature: "sig" });
		appendReasoningCapture(state, { signature: "sig" });

		expect(resolveReasoningCapture(state)).toEqual({
			text: "native reasoning",
			signature: "sig",
		});
	});

	test("does not publish incomplete or ambiguous reasoning replay material", () => {
		const signatureOnly = createReasoningCaptureState();
		appendReasoningCapture(signatureOnly, { signature: "sig" });
		expect(resolveReasoningCapture(signatureOnly)).toEqual({ text: "" });

		const conflicting = createReasoningCaptureState();
		appendReasoningCapture(conflicting, { text: "native reasoning", signature: "sig-a" });
		appendReasoningCapture(conflicting, { signature: "sig-b" });
		expect(resolveReasoningCapture(conflicting)).toEqual({ text: "native reasoning" });

		const mixed = createReasoningCaptureState();
		appendReasoningCapture(mixed, { text: "native reasoning", signature: "sig" });
		appendReasoningCapture(mixed, { redactedContent: Uint8Array.from([1, 2, 3]) });
		expect(resolveReasoningCapture(mixed)).toEqual({ text: "native reasoning" });
	});

	test("emits only a complete reasoning signature before assistant text", async () => {
		const chunks = [];
		for await (const chunk of transformSdkStream(
			makeSdkResponse([
				{ reasoningContentEvent: { text: "native reasoning" } },
				{ reasoningContentEvent: { signature: "sig" } },
				{ assistantResponseEvent: { content: "answer" } },
			]),
			"claude-sonnet-5",
			"conversation",
			undefined,
			{ emitAnthropicReasoningMetadata: true },
		)) {
			chunks.push(chunk);
		}
		const deltas = chunks.map((chunk) => chunk.choices[0]?.delta ?? {});
		const signatureIndex = deltas.findIndex(
			(delta) => delta.reasoning_signature === "sig",
		);
		const textIndex = deltas.findIndex((delta) => delta.content === "answer");
		expect(signatureIndex).toBeGreaterThanOrEqual(0);
		expect(signatureIndex).toBeLessThan(textIndex);

		const signatureOnly = [];
		for await (const chunk of transformSdkStream(
			makeSdkResponse([
				{ reasoningContentEvent: { signature: "sig-only" } },
				{ assistantResponseEvent: { content: "answer" } },
			]),
			"claude-sonnet-5",
			"conversation",
			undefined,
			{ emitAnthropicReasoningMetadata: true },
		)) {
			signatureOnly.push(chunk);
		}
		expect(
			signatureOnly.some(
				(chunk) => chunk.choices[0]?.delta.reasoning_signature !== undefined,
			),
		).toBe(false);
	});
});

describe("SDK stream structural tool events", () => {
	test("aggregates fragmented native tool input by toolUseId", async () => {
		const chunks = await collectSdkChunks([
			{ toolUseEvent: { name: "write", toolUseId: "tid", input: '{"path":"a",' } },
			{ toolUseEvent: { name: "write", toolUseId: "tid", input: '"content":"b"}' } },
			{ toolUseEvent: { name: "write", toolUseId: "tid", input: "", stop: true } },
		]);

		const calls = chunks.map(toolCallOf).filter((call) => call !== undefined);
		expect(toolCallStarts(chunks)).toHaveLength(1);
		expect(
			calls.map((call) => call.function?.arguments ?? "").join(""),
		).toBe('{"path":"a","content":"b"}');
	});
});

describe("SDK stream usage and finalization", () => {
	test("uses direct metadata token counts when provided", async () => {
		const chunks = await collectSdkChunks([
			{ assistantResponseEvent: { content: "answer" } },
			{ metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 3 } } },
		]);

		expect(chunks.find((chunk) => chunk.usage !== undefined)?.usage).toEqual({
			prompt_tokens: 12,
			completion_tokens: 3,
			total_tokens: 15,
		});
	});

	test("sets finish reason from native tool events", async () => {
		const withTool = await collectSdkChunks([
			{ toolUseEvent: { name: "x", toolUseId: "t", input: "{}", stop: true } },
		]);
		const withoutTool = await collectSdkChunks([
			{ assistantResponseEvent: { content: "hi" } },
		]);

		expect(
			withTool.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]
				?.finish_reason,
		).toBe("tool_calls");
		expect(
			withoutTool.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]
				?.finish_reason,
		).toBe("stop");
	});

	test("rejects an SDK response without an event stream", async () => {
		const { transformSdkStream } = await import(
			"../src/kiro/transform/streaming/sdk-stream-transformer.js"
		);

		await expect(async () => {
			for await (const chunk of transformSdkStream({}, "auto", "id")) {
				void chunk;
			}
		}).toThrow("SDK response has no event stream");
	});
});
