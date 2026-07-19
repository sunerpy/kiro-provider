import type { Config } from "../../config/schema.js";
import {
	type PipelineAccountManager,
	type PipelineClientFactory,
	type PipelineTokenRefresher,
	runChatCompletion,
} from "../../core/pipeline.js";
import { openAiError } from "../errors.js";
import { parseChatCompletionRequest } from "../request-schema.js";

export type ChatCompletionDependencies = {
	readonly accountManager: PipelineAccountManager;
	readonly tokenRefresher: PipelineTokenRefresher;
	readonly makeClient?: PipelineClientFactory;
};

type BodyReadResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly response: Response };

type IngressSignals = {
	readonly combined: AbortSignal;
	readonly deadline: AbortSignal;
	readonly client: AbortSignal;
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

export function ndjsonToSse(
	response: Response,
	finalize: () => void,
): Response {
	const upstream = response.body;
	if (!upstream) return response;
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let cleanEnd = false;
	let finalized = false;
	const finish = (): void => {
		if (finalized) return;
		finalized = true;
		finalize();
	};

	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					while (true) {
						const newline = buffer.indexOf("\n");
						if (newline >= 0) {
							const line = buffer.slice(0, newline).trimEnd();
							buffer = buffer.slice(newline + 1);
							if (line.length > 0) {
								controller.enqueue(encoder.encode(`data: ${line}\n\n`));
								return;
							}
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
							controller.enqueue(encoder.encode(`data: ${finalLine}\n\n`));
							return;
						}
						if (!cleanEnd) {
							cleanEnd = true;
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							return;
						}
						controller.close();
						finish();
						return;
					}
				} catch {
					const errorFrame = JSON.stringify({
						error: {
							message: "Upstream stream error",
							type: "upstream_error",
						},
					});
					controller.enqueue(encoder.encode(`data: ${errorFrame}\n\n`));
					controller.close();
					finish();
				}
			},
			cancel(reason) {
				void reader.cancel(reason).catch(() => undefined);
				finish();
			},
		}),
		{
			status: response.status,
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		},
	);
}

export async function handleChatCompletions(
	request: Request,
	config: Config,
	dependencies: ChatCompletionDependencies,
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
	const ingressSignals: IngressSignals = {
		combined: combinedSignal,
		deadline: deadlineController.signal,
		client: request.signal,
	};

	const bodyResult = await readRequestBody(
		request,
		config.max_request_body_bytes,
		ingressSignals,
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

	const parsed = parseChatCompletionRequest(raw);
	if (!parsed.ok) {
		clearTimeout(deadlineTimer);
		return parsed.response;
	}

	const pipelineResponse = await runChatCompletion({
		body: parsed.value,
		model: parsed.value.model,
		stream: parsed.value.stream,
		config,
		accountManager: dependencies.accountManager,
		tokenRefresher: dependencies.tokenRefresher,
		deadlineSignal: combinedSignal,
		...(dependencies.makeClient ? { makeClient: dependencies.makeClient } : {}),
	});
	if (request.signal.aborted && !deadlineController.signal.aborted) {
		clearTimeout(deadlineTimer);
		return openAiError(
			499,
			"Client closed request",
			"request_aborted",
			"client_disconnected",
		);
	}
	const contentType = pipelineResponse.headers.get("Content-Type") ?? "";
	if (!parsed.value.stream || contentType.includes("application/json")) {
		clearTimeout(deadlineTimer);
		return pipelineResponse;
	}
	if (!contentType.includes("application/x-ndjson")) {
		clearTimeout(deadlineTimer);
		return openAiError(
			500,
			"Pipeline returned an unsupported streaming response",
			"internal_error",
			"invalid_pipeline_response",
		);
	}
	return ndjsonToSse(pipelineResponse, () => clearTimeout(deadlineTimer));
}
