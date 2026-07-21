import { randomUUID } from "node:crypto";
import {
	type FunctionCallOutputItem,
	formatSseEvent,
	type MessageOutputItem,
	outputItemAdded,
	outputItemDone,
	outputTextDelta,
	type ReasoningOutputItem,
	type ResponseOutputItem,
	type ResponsesEvent,
	type ResponseUsage,
	reasoningSummaryTextDelta,
	reasoningSummaryTextDone,
	responseCompleted,
	responseCreated,
	responseFailed,
} from "./events.js";

type AdapterOptions = {
	readonly model: string;
	readonly finalize: () => void;
};

type ToolCallFragment = {
	readonly index: number;
	readonly id: string | undefined;
	readonly name: string | undefined;
	readonly arguments: string;
};

type PipelineDelta =
	| { readonly kind: "empty" }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "reasoning"; readonly text: string }
	| { readonly kind: "tool_calls"; readonly calls: readonly ToolCallFragment[] };

type PipelineChunk = {
	readonly delta: PipelineDelta;
	readonly finishReason: "stop" | "tool_calls" | null;
	readonly usage: ResponseUsage | undefined;
};

type ToolCallAccumulator = {
	readonly itemId: string;
	id: string;
	name: string;
	arguments: string;
};

type ReasoningRun = {
	readonly id: string;
	readonly outputIndex: number;
	text: string;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCall(value: unknown): ToolCallFragment | undefined {
	if (!isRecord(value) || typeof value.index !== "number" || !isRecord(value.function)) {
		return undefined;
	}
	const id = value.id;
	const name = value.function.name;
	const argumentsFragment = value.function.arguments;
	if (
		(id !== undefined && typeof id !== "string") ||
		(name !== undefined && typeof name !== "string") ||
		typeof argumentsFragment !== "string"
	) {
		return undefined;
	}
	return { index: value.index, id, name, arguments: argumentsFragment };
}

function parseDelta(value: unknown): PipelineDelta | undefined {
	if (!isRecord(value)) return undefined;
	const knownFields = ["content", "reasoning_content", "tool_calls"].filter(
		(field) => value[field] !== undefined,
	);
	if (knownFields.length === 0) return { kind: "empty" };
	if (knownFields.length !== 1) return undefined;
	if (typeof value.content === "string") return { kind: "text", text: value.content };
	if (typeof value.reasoning_content === "string") {
		return { kind: "reasoning", text: value.reasoning_content };
	}
	if (!Array.isArray(value.tool_calls)) return undefined;
	const calls: ToolCallFragment[] = [];
	for (const candidate of value.tool_calls) {
		const call = parseToolCall(candidate);
		if (!call) return undefined;
		calls.push(call);
	}
	return { kind: "tool_calls", calls };
}

function parseUsage(value: unknown): ResponseUsage | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.prompt_tokens !== "number" ||
		typeof value.completion_tokens !== "number" ||
		typeof value.total_tokens !== "number"
	) {
		return undefined;
	}
	return {
		input_tokens: value.prompt_tokens,
		output_tokens: value.completion_tokens,
		total_tokens: value.total_tokens,
	};
}

function parsePipelineChunk(line: string): PipelineChunk | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (
		!isRecord(parsed) ||
		parsed.object !== "chat.completion.chunk" ||
		!Array.isArray(parsed.choices)
	) {
		return undefined;
	}
	const choice = parsed.choices[0];
	if (!isRecord(choice)) return undefined;
	const delta = parseDelta(choice.delta);
	const finishReason = choice.finish_reason;
	if (
		!delta ||
		(finishReason !== null && finishReason !== "stop" && finishReason !== "tool_calls")
	) {
		return undefined;
	}
	const usage = parsed.usage === undefined ? undefined : parseUsage(parsed.usage);
	if (parsed.usage !== undefined && !usage) return undefined;
	return { delta, finishReason, usage };
}

// allow: SIZE_OK — this file is one indivisible stream state machine with typed boundary parsing.
export function responsesSseAdapter(
	pipelineResponse: Response,
	options: AdapterOptions,
): Response {
	const upstream = pipelineResponse.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const responseId = `resp_${randomUUID()}`;
	const messageId = `msg_${randomUUID()}`;
	const tools = new Map<number, ToolCallAccumulator>();
	const completedOutput = new Map<number, ResponseOutputItem>();
	let buffer = "";
	let text = "";
	let messageIndex: number | undefined;
	let activeReasoning: ReasoningRun | undefined;
	let nextOutputIndex = 0;
	let sequenceNumber = 0;
	let terminalSeen = false;
	let ended = false;
	let finalized = false;

	const finish = (): void => {
		if (finalized) return;
		finalized = true;
		options.finalize();
	};
	const emit = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		create: (sequence: number) => ResponsesEvent,
	): void => {
		controller.enqueue(encoder.encode(formatSseEvent(create(sequenceNumber))));
		sequenceNumber += 1;
	};
	const cancelUpstream = async (reason?: unknown): Promise<void> => {
		await reader.cancel(reason).catch(() => undefined);
	};
	const fail = async (
		controller: ReadableStreamDefaultController<Uint8Array>,
		message: string,
	): Promise<void> => {
		if (ended) return;
		ended = true;
		emit(controller, (sequence) =>
			responseFailed({
				responseId,
				model: options.model,
				error: { code: "upstream_error", message },
				sequenceNumber: sequence,
			}),
		);
		await cancelUpstream();
		finish();
		controller.close();
	};
	const closeReasoning = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	): void => {
		if (!activeReasoning) return;
		const item: ReasoningOutputItem = {
			id: activeReasoning.id,
			type: "reasoning",
			summary: [{ type: "summary_text", text: activeReasoning.text }],
		};
		emit(controller, (sequence) =>
			reasoningSummaryTextDone({
				itemId: activeReasoning?.id ?? "",
				outputIndex: activeReasoning?.outputIndex ?? 0,
				summaryIndex: 0,
				text: activeReasoning?.text ?? "",
				sequenceNumber: sequence,
			}),
		);
		emit(controller, (sequence) =>
			outputItemDone({
				item,
				outputIndex: activeReasoning?.outputIndex ?? 0,
				sequenceNumber: sequence,
			}),
		);
		completedOutput.set(activeReasoning.outputIndex, item);
		activeReasoning = undefined;
	};
	const addDelta = (
		controller: ReadableStreamDefaultController<Uint8Array>,
		delta: PipelineDelta,
	): void => {
		switch (delta.kind) {
			case "empty":
				return;
			case "reasoning": {
				if (!activeReasoning) {
					activeReasoning = {
						id: `rs_${randomUUID()}`,
						outputIndex: nextOutputIndex,
						text: "",
					};
					nextOutputIndex += 1;
					emit(controller, (sequence) =>
						outputItemAdded({
							item: { id: activeReasoning?.id ?? "", type: "reasoning", summary: [] },
							outputIndex: activeReasoning?.outputIndex ?? 0,
							sequenceNumber: sequence,
						}),
					);
				}
				activeReasoning.text += delta.text;
				emit(controller, (sequence) =>
					reasoningSummaryTextDelta({
						itemId: activeReasoning?.id ?? "",
						outputIndex: activeReasoning?.outputIndex ?? 0,
						summaryIndex: 0,
						delta: delta.text,
						sequenceNumber: sequence,
					}),
				);
				return;
			}
			case "text": {
				closeReasoning(controller);
				if (messageIndex === undefined) {
					messageIndex = nextOutputIndex;
					nextOutputIndex += 1;
					emit(controller, (sequence) =>
						outputItemAdded({
							item: { id: messageId, type: "message", role: "assistant", content: [] },
							outputIndex: messageIndex ?? 0,
							sequenceNumber: sequence,
						}),
					);
				}
				text += delta.text;
				emit(controller, (sequence) =>
					outputTextDelta({
						itemId: messageId,
						outputIndex: messageIndex ?? 0,
						contentIndex: 0,
						delta: delta.text,
						sequenceNumber: sequence,
					}),
				);
				return;
			}
			case "tool_calls":
				closeReasoning(controller);
				for (const fragment of delta.calls) {
					const existing = tools.get(fragment.index) ?? {
						itemId: `fc_${randomUUID()}`,
						id: "",
						name: "",
						arguments: "",
					};
					if (existing.id.length === 0 && fragment.id !== undefined) existing.id = fragment.id;
					if (existing.name.length === 0 && fragment.name !== undefined) existing.name = fragment.name;
					existing.arguments += fragment.arguments;
					tools.set(fragment.index, existing);
				}
				return;
		}
	};

	const complete = async (
		controller: ReadableStreamDefaultController<Uint8Array>,
		usage: ResponseUsage,
	): Promise<void> => {
		const invalidTool = [...tools.values()].some((tool) => tool.id.length === 0 || tool.name.length === 0);
		if (invalidTool) {
			await fail(controller, "Malformed upstream tool call");
			return;
		}
		closeReasoning(controller);
		if (messageIndex !== undefined) {
			const item: MessageOutputItem = {
				id: messageId,
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text }],
			};
			emit(controller, (sequence) => outputItemDone({ item, outputIndex: messageIndex ?? 0, sequenceNumber: sequence }));
			completedOutput.set(messageIndex, item);
		}
		for (const [, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
			const outputIndex = nextOutputIndex;
			nextOutputIndex += 1;
			const item: FunctionCallOutputItem = { id: tool.itemId, type: "function_call", call_id: tool.id, name: tool.name, arguments: tool.arguments };
			emit(controller, (sequence) => outputItemDone({ item, outputIndex, sequenceNumber: sequence }));
			completedOutput.set(outputIndex, item);
		}
		const output = [...completedOutput.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, item]) => item);
		terminalSeen = true;
		ended = true;
		emit(controller, (sequence) => responseCompleted({ responseId, model: options.model, output, usage, sequenceNumber: sequence }));
		await cancelUpstream();
		finish();
		controller.close();
	};

	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				emit(controller, (sequence) => responseCreated({ responseId, model: options.model, sequenceNumber: sequence }));
			},
			async pull(controller) {
				try {
					while (!ended) {
						const newline = buffer.indexOf("\n");
						if (newline >= 0) {
							const line = buffer.slice(0, newline).trimEnd();
							buffer = buffer.slice(newline + 1);
							if (line.length === 0) continue;
							const parsed = parsePipelineChunk(line);
							if (!parsed) {
								await fail(controller, "Malformed upstream stream");
								return;
							}
							addDelta(controller, parsed.delta);
							if (parsed.finishReason !== null) {
								if (!parsed.usage) {
									await fail(controller, "Terminal upstream chunk omitted usage");
									return;
								}
								await complete(controller, parsed.usage);
								return;
							}
							if (parsed.delta.kind !== "tool_calls" && parsed.delta.kind !== "empty") return;
							continue;
						}
						const next = await reader.read();
						if (!next.done) {
							buffer += decoder.decode(next.value, { stream: true });
							continue;
						}
						buffer += decoder.decode();
						const finalLine = buffer.trim();
						buffer = "";
						if (finalLine.length > 0) {
							const parsed = parsePipelineChunk(finalLine);
							if (!parsed) {
								await fail(controller, "Malformed upstream stream");
								return;
							}
							addDelta(controller, parsed.delta);
							if (parsed.finishReason !== null && parsed.usage) {
								await complete(controller, parsed.usage);
								return;
							}
						}
						if (!terminalSeen) await fail(controller, "Upstream stream ended before completion");
						return;
					}
				} catch {
					await fail(controller, "Upstream stream error");
				} finally {
					if (ended) finish();
				}
			},
			async cancel(reason) {
				ended = true;
				await cancelUpstream(reason);
				finish();
			},
		}),
		{
			headers: {
				"Cache-Control": "no-cache",
				"Content-Type": "text/event-stream; charset=utf-8",
			},
		},
	);
}
