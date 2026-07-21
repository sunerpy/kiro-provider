import { randomUUID } from "node:crypto";
import type { Config } from "../../config/schema.js";
import {
	type PipelineAccountManager,
	type PipelineClientFactory,
	type PipelineTokenRefresher,
	type RunChatCompletionOptions,
	runChatCompletion,
} from "../../core/pipeline.js";
import { openAiError } from "../errors.js";
import {
	parseChatCompletionRequest,
	parseResponsesRequest,
} from "../request-schema.js";
import type {
	FunctionCallOutputItem,
	MessageOutputItem,
	ReasoningOutputItem,
	ResponseOutputItem,
	ResponseUsage,
} from "../responses/events.js";
import { responsesToInternalChat } from "../responses/request-adapter.js";
import { responsesSseAdapter } from "../responses/sse-adapter.js";

export type ResponsesDependencies = {
	readonly accountManager: PipelineAccountManager;
	readonly tokenRefresher: PipelineTokenRefresher;
	readonly makeClient?: PipelineClientFactory;
	readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
};

type BodyReadResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly response: Response };

type IngressSignals = {
	readonly combined: AbortSignal;
	readonly deadline: AbortSignal;
	readonly client: AbortSignal;
};

type ChatCompletionPayload = {
	readonly message: {
		readonly content: string;
		readonly reasoningContent: string | undefined;
		readonly toolCalls: readonly {
			readonly id: string;
			readonly name: string;
			readonly arguments: string;
		}[];
	};
	readonly usage: ResponseUsage;
};

class RequestBodyTooLargeError extends Error {
	readonly name = "RequestBodyTooLargeError";

	constructor(readonly limit: number) {
		super(`Request body exceeds the ${limit} byte limit`);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Request deadline exceeded", "TimeoutError");
}

async function readRequestBody(
	request: Request,
	limit: number,
	signals: IngressSignals,
): Promise<BodyReadResult> {
	const reader = request.body?.getReader();
	if (!reader) return { ok: true, text: "" };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let rejectAbort: ((reason: Error) => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = (): void => {
		const reason = abortReason(signals.combined);
		rejectAbort?.(reason);
		void reader.cancel(reason);
	};
	signals.combined.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signals.combined.aborted) throw abortReason(signals.combined);
			const next = await Promise.race([reader.read(), aborted]);
			if (signals.combined.aborted) throw abortReason(signals.combined);
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new RequestBodyTooLargeError(limit);
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { ok: true, text: new TextDecoder().decode(bytes) };
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) {
			void reader.cancel(error).catch(() => undefined);
			return {
				ok: false,
				response: openAiError(
					413,
					error.message,
					"invalid_request_error",
					"request_too_large",
				),
			};
		}
		if (signals.deadline.aborted) {
			void reader.cancel(error).catch(() => undefined);
			return {
				ok: false,
				response: openAiError(
					504,
					"Request deadline exceeded",
					"timeout_error",
					"request_timeout",
				),
			};
		}
		if (signals.client.aborted) {
			void reader.cancel(error).catch(() => undefined);
			return {
				ok: false,
				response: openAiError(
					499,
					"Client closed request",
					"request_aborted",
					"client_disconnected",
				),
			};
		}
		throw error;
	} finally {
		signals.combined.removeEventListener("abort", onAbort);
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatCompletion(value: unknown): ChatCompletionPayload | undefined {
	if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.usage)) {
		return undefined;
	}
	const choice = value.choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
	const message = choice.message;
	if (typeof message.content !== "string") return undefined;
	const reasoningContent = message.reasoning_content;
	if (reasoningContent !== undefined && typeof reasoningContent !== "string") {
		return undefined;
	}
	const toolCalls: Array<{
		readonly id: string;
		readonly name: string;
		readonly arguments: string;
	}> = [];
	if (message.tool_calls !== undefined) {
		if (!Array.isArray(message.tool_calls)) return undefined;
		for (const toolCall of message.tool_calls) {
			if (
				!isRecord(toolCall) ||
				typeof toolCall.id !== "string" ||
				!isRecord(toolCall.function) ||
				typeof toolCall.function.name !== "string" ||
				typeof toolCall.function.arguments !== "string"
			) {
				return undefined;
			}
			toolCalls.push({
				id: toolCall.id,
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
			});
		}
	}
	if (
		typeof value.usage.prompt_tokens !== "number" ||
		typeof value.usage.completion_tokens !== "number" ||
		typeof value.usage.total_tokens !== "number"
	) {
		return undefined;
	}
	return {
		message: { content: message.content, reasoningContent, toolCalls },
		usage: {
			input_tokens: value.usage.prompt_tokens,
			output_tokens: value.usage.completion_tokens,
			total_tokens: value.usage.total_tokens,
		},
	};
}

function completedResponse(payload: ChatCompletionPayload, model: string): Response {
	const output: ResponseOutputItem[] = [];
	if (payload.message.reasoningContent) {
		const reasoning: ReasoningOutputItem = {
			id: `rs_${randomUUID()}`,
			type: "reasoning",
			summary: [{ type: "summary_text", text: payload.message.reasoningContent }],
		};
		output.push(reasoning);
	}
	const message: MessageOutputItem = {
		id: `msg_${randomUUID()}`,
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: payload.message.content }],
	};
	output.push(message);
	for (const toolCall of payload.message.toolCalls) {
		const functionCall: FunctionCallOutputItem = {
			type: "function_call",
			call_id: toolCall.id,
			name: toolCall.name,
			arguments: toolCall.arguments,
		};
		output.push(functionCall);
	}
	return Response.json({
		id: `resp_${randomUUID()}`,
		object: "response",
		status: "completed",
		model,
		output,
		usage: payload.usage,
	});
}

// allow: SIZE_OK — mirrors the established ingress boundary and owns one response conversion.
export async function handleResponses(
	request: Request,
	config: Config,
	dependencies: ResponsesDependencies,
): Promise<Response> {
	const deadlineController = new AbortController();
	const deadlineTimer = setTimeout(
		() =>
			deadlineController.abort(
				new DOMException("Request deadline exceeded", "TimeoutError"),
			),
		config.request_timeout_ms,
	);
	const combinedSignal = AbortSignal.any([
		deadlineController.signal,
		request.signal,
	]);
	const bodyResult = await readRequestBody(
		request,
		config.max_request_body_bytes,
		{
			combined: combinedSignal,
			deadline: deadlineController.signal,
			client: request.signal,
		},
	);
	if (!bodyResult.ok) {
		clearTimeout(deadlineTimer);
		return bodyResult.response;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(bodyResult.text);
	} catch (error) {
		clearTimeout(deadlineTimer);
		if (!(error instanceof SyntaxError)) throw error;
		return openAiError(
			400,
			"Request body must contain valid JSON",
			"invalid_request_error",
			"invalid_json",
		);
	}

	const parsed = parseResponsesRequest(raw);
	if (!parsed.ok) {
		clearTimeout(deadlineTimer);
		return parsed.response;
	}
	const adapted = responsesToInternalChat(parsed.value);
	if (!adapted.ok) {
		clearTimeout(deadlineTimer);
		return openAiError(
			400,
			"input produced no messages",
			"invalid_request_error",
			"empty_input",
		);
	}
	const internal = parseChatCompletionRequest(adapted.body);
	if (!internal.ok) {
		clearTimeout(deadlineTimer);
		return internal.response;
	}

	const stream = parsed.value.stream;
	const pipelineResponse = await (dependencies.runPipeline ?? runChatCompletion)({
		body: internal.value,
		model: internal.value.model,
		stream,
		config,
		accountManager: dependencies.accountManager,
		tokenRefresher: dependencies.tokenRefresher,
		deadlineSignal: combinedSignal,
		...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
	});
	if (request.signal.aborted && !deadlineController.signal.aborted) {
		await pipelineResponse.body?.cancel().catch(() => undefined);
		clearTimeout(deadlineTimer);
		return openAiError(
			499,
			"Client closed request",
			"request_aborted",
			"client_disconnected",
		);
	}

	const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
	if (stream && contentType.includes("application/x-ndjson")) {
		return responsesSseAdapter(pipelineResponse, {
			model: internal.value.model,
			finalize: () => clearTimeout(deadlineTimer),
		});
	}
	if (contentType.includes("application/json")) {
		clearTimeout(deadlineTimer);
		if (stream || !pipelineResponse.ok) return pipelineResponse;
		const completion: unknown = await pipelineResponse.json();
		const payload = parseChatCompletion(completion);
		if (payload) return completedResponse(payload, internal.value.model);
		return openAiError(
			500,
			"Pipeline returned an invalid non-streaming response",
			"internal_error",
			"invalid_pipeline_response",
		);
	}
	await pipelineResponse.body?.cancel().catch(() => undefined);
	clearTimeout(deadlineTimer);
	return openAiError(
		500,
		"Pipeline returned an unsupported response",
		"internal_error",
		"invalid_pipeline_response",
	);
}
