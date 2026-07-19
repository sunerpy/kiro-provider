import { DialectGate } from "./dialect-gate.js";
import { convertToOpenAI, type OpenAIStreamChunk } from "./openai-converter.js";
import {
	flushAssistantBuffer,
	processAssistantText,
} from "./sdk-stream-buffer.js";
import {
	appendToolFragment,
	createToolCallEvents,
	nextSdkEvent,
	resolveUsage,
	type SdkStreamResponse,
	type UsageState,
	updateUsageState,
} from "./sdk-stream-runtime.js";
import {
	createTextDeltaEvents,
	createThinkingDeltaEvents,
	stopBlock,
} from "./stream-state.js";
import type { StreamEvent, StreamState, ToolCallState } from "./types.js";

export type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "./sdk-stream-runtime.js";

export class MissingSdkEventStreamError extends Error {
	readonly name = "MissingSdkEventStreamError";

	constructor() {
		super("SDK response has no event stream");
	}
}

export async function* transformSdkStream(
	sdkResponse: SdkStreamResponse,
	model: string,
	conversationId: string,
	signal?: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk> {
	const eventStream = sdkResponse.generateAssistantResponseResponse;
	if (!eventStream) throw new MissingSdkEventStreamError();

	const streamState: StreamState = {
		thinkingRequested: true,
		buffer: "",
		inThinking: false,
		thinkingExtracted: false,
		thinkingBlockIndex: null,
		textBlockIndex: null,
		nextBlockIndex: 0,
		stoppedBlocks: new Set(),
	};
	const dialectGate = new DialectGate();
	const toolCalls = new Map<string, ToolCallState>();
	const usage: UsageState = {};
	const iterator = eventStream[Symbol.asyncIterator]();
	let textOnlyContent = "";
	let reasoningStarted = false;
	let reasoningClosed = false;
	let iteratorFinished = false;
	let iteratorClosed = false;

	const convert = (
		event: StreamEvent,
		gateText = false,
	): OpenAIStreamChunk | null => {
		if (
			gateText &&
			event.type === "content_block_delta" &&
			event.delta?.type === "text_delta"
		) {
			const safeText = dialectGate.push(event.delta.text ?? "");
			if (!safeText) return null;
			return convertToOpenAI(
				{ ...event, delta: { ...event.delta, text: safeText } },
				conversationId,
				model,
			);
		}
		return convertToOpenAI(event, conversationId, model);
	};

	try {
		while (true) {
			const next = await nextSdkEvent(iterator, signal);
			if (next.kind === "aborted") {
				if (iterator.return) await iterator.return();
				iteratorClosed = true;
				return;
			}
			if (next.result.done) {
				iteratorFinished = true;
				break;
			}

			const event = next.result.value;
			updateUsageState(usage, event);

			const reasoningText = event.reasoningContentEvent?.text;
			if (reasoningText) {
				if (reasoningClosed) {
					streamState.thinkingBlockIndex = null;
					reasoningClosed = false;
				}
				reasoningStarted = true;
				for (const deltaEvent of createThinkingDeltaEvents(
					reasoningText,
					streamState,
				)) {
					const chunk = convert(deltaEvent);
					if (chunk) yield chunk;
				}
				continue;
			}

			const assistantText = event.assistantResponseEvent?.content;
			if (assistantText) {
				textOnlyContent += assistantText;
				if (reasoningStarted && !reasoningClosed) {
					for (const stopEvent of stopBlock(
						streamState.thinkingBlockIndex,
						streamState,
					)) {
						const chunk = convert(stopEvent);
						if (chunk) yield chunk;
					}
					reasoningClosed = true;
				}

				const textEvents = reasoningStarted
					? createTextDeltaEvents(assistantText, streamState)
					: processAssistantText(assistantText, streamState);
				for (const textEvent of textEvents) {
					const chunk = convert(textEvent, true);
					if (chunk) yield chunk;
				}
				continue;
			}

			if (event.toolUseEvent) appendToolFragment(toolCalls, event.toolUseEvent);
		}
	} finally {
		if (!iteratorFinished && !iteratorClosed && iterator.return)
			await iterator.return();
	}

	if (reasoningStarted && !reasoningClosed) {
		for (const stopEvent of stopBlock(
			streamState.thinkingBlockIndex,
			streamState,
		)) {
			const chunk = convert(stopEvent);
			if (chunk) yield chunk;
		}
	}

	for (const bufferedEvent of flushAssistantBuffer(streamState)) {
		const chunk = convert(
			bufferedEvent,
			bufferedEvent.delta?.type === "text_delta",
		);
		if (chunk) yield chunk;
	}

	const { toolCalls: dialectToolCalls, remainderText } = dialectGate.finalize();
	for (const textEvent of createTextDeltaEvents(remainderText, streamState)) {
		const chunk = convert(textEvent);
		if (chunk) yield chunk;
	}
	for (const stopEvent of stopBlock(streamState.textBlockIndex, streamState)) {
		const chunk = convert(stopEvent);
		if (chunk) yield chunk;
	}

	for (const dialectToolCall of dialectToolCalls) {
		appendToolFragment(toolCalls, {
			toolUseId: dialectToolCall.toolUseId,
			name: dialectToolCall.name,
			input:
				typeof dialectToolCall.input === "string"
					? dialectToolCall.input
					: JSON.stringify(dialectToolCall.input),
			stop: true,
		});
	}

	for (const toolEvent of createToolCallEvents(toolCalls)) {
		const chunk = convert(toolEvent);
		if (chunk) yield chunk;
	}

	const tokenUsage = resolveUsage(usage, textOnlyContent, model);
	const finalChunk = convert({
		type: "message_delta",
		delta: {
			type: "message_delta",
			stop_reason: toolCalls.size > 0 ? "tool_use" : "end_turn",
		},
		usage: {
			input_tokens: tokenUsage.inputTokens,
			output_tokens: tokenUsage.outputTokens,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	});
	if (finalChunk) yield finalChunk;

	convert({ type: "message_stop" });
}
