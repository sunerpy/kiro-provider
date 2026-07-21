import { afterEach, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
	PipelineAccountManager,
	PipelineClientFactory,
	PipelineSdkClient,
	PipelineTokenRefresher,
	RunChatCompletionOptions,
} from "../src/core/pipeline.js";
import type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";

const API_KEY = "sk-responses-integration";
const MODEL = "gpt-5.6-sol";

function testConfig(overrides: Partial<Config> = {}): Config {
	return ConfigSchema.parse({
		api_keys: [API_KEY],
		request_timeout_ms: 1_000,
		stream_idle_timeout_ms: 1_000,
		max_request_body_bytes: 16_384,
		...overrides,
	});
}

function account(): ManagedAccount {
	return {
		id: "responses-account",
		email: "responses@example.com",
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: "refresh-token",
		accessToken: "access-token",
		expiresAt: Date.now() + 3_600_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
	};
}

class FakeAccountManager implements PipelineAccountManager {
	readonly selected = account();

	reconcileFromDb(): readonly ManagedAccount[] {
		return [this.selected];
	}

	selectHealthyAccount(): ManagedAccount {
		return this.selected;
	}

	getAccountCount(): number {
		return 1;
	}

	toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
		return {
			refresh: selected.refreshToken,
			access: selected.accessToken,
			expires: selected.expiresAt,
			authMethod: selected.authMethod,
			region: selected.region,
		};
	}

	markRateLimited(): void {}

	markUnhealthy(): void {}
}

class FakeTokenRefresher implements PipelineTokenRefresher {
	async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
		return selected;
	}

	async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
		return selected;
	}
}

function sdkResponse(events: readonly SdkStreamEvent[]): SdkStreamResponse {
	return {
		generateAssistantResponseResponse: {
			async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
				for (const event of events) yield event;
			},
		},
	};
}

function cancellableStalledSdkResponse(): {
	readonly response: SdkStreamResponse;
	readonly state: { cancelled: boolean };
} {
	const state = { cancelled: false };
	return {
		state,
		response: {
			generateAssistantResponseResponse: {
				[Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
					return {
						next(): Promise<IteratorResult<SdkStreamEvent>> {
							return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
						},
						return(): Promise<IteratorResult<SdkStreamEvent>> {
							state.cancelled = true;
							return Promise.resolve({ done: true, value: undefined });
						},
					};
				},
			},
		},
	};
}

type TestServer = {
	readonly server: ReturnType<typeof Bun.serve>;
	readonly baseUrl: string;
	readonly capturedCommandInputs: unknown[];
	readonly responseStatuses: number[];
};

type TestServerOptions = {
	readonly prepareRequest?: (request: Request) => Request;
	readonly runPipeline?: (options: RunChatCompletionOptions) => Promise<Response>;
};

const activeServers = new Set<ReturnType<typeof Bun.serve>>();

afterEach(() => {
	for (const server of activeServers) server.stop(true);
	activeServers.clear();
});

function startTestServer(
	makeClient: PipelineClientFactory,
	config: Config = testConfig(),
	options: TestServerOptions = {},
): TestServer {
	const capturedCommandInputs: unknown[] = [];
	const responseStatuses: number[] = [];
	const clientFactory: PipelineClientFactory = (...factoryArgs) => {
		const client = makeClient(...factoryArgs);
		return {
			async send(command, options): Promise<SdkStreamResponse> {
				capturedCommandInputs.push(command.input);
				return client.send(command, options);
			},
		};
	};
	const dependencies = {
		accountManager: new FakeAccountManager(),
		tokenRefresher: new FakeTokenRefresher(),
		makeClient: clientFactory,
		...(options.runPipeline ? { runPipeline: options.runPipeline } : {}),
	};
	const app = createApp(config, dependencies);
	const server = Bun.serve({
		port: 0,
		async fetch(request): Promise<Response> {
			const response = await app(options.prepareRequest?.(request) ?? request);
			responseStatuses.push(response.status);
			return response;
		},
	});
	activeServers.add(server);
	return {
		server,
		baseUrl: `http://127.0.0.1:${server.port}`,
		capturedCommandInputs,
		responseStatuses,
	};
}

function postPipelineAbortRequest(
	request: Request,
	ingressController: AbortController,
): Request {
	const abortedController = new AbortController();
	abortedController.abort();
	let signalReads = 0;
	Object.defineProperty(request, "signal", {
		get(): AbortSignal {
			signalReads += 1;
			return signalReads <= 2
				? ingressController.signal
				: abortedController.signal;
		},
	});
	return request;
}

function scriptedServer(
	scripts: readonly (readonly SdkStreamEvent[])[],
	config: Config = testConfig(),
): TestServer {
	let requestIndex = 0;
	const makeClient: PipelineClientFactory = (): PipelineSdkClient => ({
		async send(): Promise<SdkStreamResponse> {
			const events = scripts[requestIndex];
			requestIndex += 1;
			if (!events) throw new TypeError("Missing scripted SDK response");
			return sdkResponse(events);
		},
	});
	return startTestServer(makeClient, config);
}

function postJson(
	server: TestServer,
	path: string,
	body: unknown,
	authorization: string | null = `Bearer ${API_KEY}`,
): Promise<Response> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (authorization !== null) headers.set("Authorization", authorization);
	return fetch(`${server.baseUrl}${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function postResponse(
	server: TestServer,
	body: unknown,
	authorization: string | null = `Bearer ${API_KEY}`,
): Promise<Response> {
	return postJson(server, "/v1/responses", body, authorization);
}

function eventsWith(options: {
	readonly reasoning?: string;
	readonly text?: string;
	readonly tool?: {
		readonly id: string;
		readonly name: string;
		readonly arguments: string;
	};
}): readonly SdkStreamEvent[] {
	return [
		...(options.reasoning
			? [{ reasoningContentEvent: { text: options.reasoning } }]
			: []),
		...(options.text
			? [{ assistantResponseEvent: { content: options.text } }]
			: []),
		...(options.tool
			? [
					{
						toolUseEvent: {
							name: options.tool.name,
							toolUseId: options.tool.id,
							input: options.tool.arguments,
							stop: true,
						},
					},
				]
			: []),
		{
			metadataEvent: {
				tokenUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
			},
		},
	];
}

function parseSseFrames(text: string): Readonly<Record<string, unknown>>[] {
	return text
		.split("\n\n")
		.map((frame) => frame.trim())
		.filter((frame) => frame.length > 0)
		.map((frame) => {
			const dataLine = frame
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("data:"));
			const parsed: unknown = JSON.parse(
				dataLine ? dataLine.slice("data:".length).trim() : frame,
			);
			if (!isReadonlyRecord(parsed)) {
				throw new TypeError("SSE data must be an object");
			}
			if (
				parsed.object === "response" &&
				parsed.status === "completed" &&
				typeof parsed.id === "string"
			) {
				return { type: "response.completed", response: parsed };
			}
			return parsed;
		});
}

async function expectOpenAiError(response: Response, status: number): Promise<void> {
	const body: unknown = await response.json();
	expect(response.status).toBe(status);
	expect(body).toMatchObject({
		error: { message: expect.any(String), type: expect.any(String) },
	});
}

describe("POST /v1/responses", () => {
	test("streams Responses events with one completed event and an assembled message", async () => {
		// Given
		const server = scriptedServer([
			eventsWith({ reasoning: "considering", text: "full answer" }),
		]);

		// When
		const response = await postResponse(
			server,
			{ model: MODEL, input: "hello", stream: true },
		);
		const frames = parseSseFrames(await response.text());

		// Then
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");
		expect(frames.some((frame) => frame.type === "response.created")).toBe(true);
		const completed = frames.filter((frame) => frame.type === "response.completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			response: {
				id: expect.any(String),
				usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
			},
		});
		expect(
			frames.find(
				(frame) =>
					frame.type === "response.output_item.done" &&
					typeOfNested(frame, "item") === "message",
			),
		).toMatchObject({
			item: {
				type: "message",
				content: [{ type: "output_text", text: "full answer" }],
			},
		});
	});

	test("uses the schema default when stream is omitted", async () => {
		// Given
		const server = scriptedServer([eventsWith({ text: "default JSON" })]);

		// When
		const response = await postResponse(server, { model: MODEL, input: "hello" });
		const body: unknown = await response.json();

		// Then
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(body).toMatchObject({
			object: "response",
			status: "completed",
		});
		if (!isReadonlyRecord(body) || !Array.isArray(body.output)) {
			throw new TypeError("Responses body must contain output items");
		}
		expect(body.output).toContainEqual({
			type: "message",
			id: expect.any(String),
			role: "assistant",
			content: [{ type: "output_text", text: "default JSON" }],
		});
	});

	test("rejects an unsupported model before invoking the SDK", async () => {
		// Given
		const server = scriptedServer([eventsWith({ text: "must not run" })]);

		// When
		const response = await postResponse(
			server,
			{ model: "unsupported-model", input: "hello" },
		);

		// Then
		await expectOpenAiError(response, 400);
		expect(server.capturedCommandInputs).toHaveLength(0);
	});

	test("cancels a queue-owning pipeline stream before returning 499", async () => {
		// Given
		const stalled = cancellableStalledSdkResponse();
		let sendCalls = 0;
		const makeClient: PipelineClientFactory = () => ({
			async send(): Promise<SdkStreamResponse> {
				sendCalls += 1;
				return sendCalls === 1
					? stalled.response
					: sdkResponse(eventsWith({ text: "next request" }));
			},
		});
		const ingressController = new AbortController();
		let requestCount = 0;
		const server = startTestServer(makeClient, testConfig(), {
			prepareRequest(request) {
				requestCount += 1;
				return requestCount === 1
					? postPipelineAbortRequest(request, ingressController)
					: request;
			},
		});

		// When
		const abortedResponse = await postResponse(server, {
			model: MODEL,
			input: "first",
			stream: true,
		});
		const nextResponse = await Promise.race([
			postResponse(server, { model: MODEL, input: "second", stream: false }),
			Bun.sleep(50).then(() => new Response(null, { status: 408 })),
		]);

		// Then
		expect(abortedResponse.status).toBe(499);
		expect(server.responseStatuses).toContain(499);
		expect(stalled.state.cancelled).toBe(true);
		expect(nextResponse.status).toBe(200);
	});

	test("cancels an unsupported pipeline response before serving the next request", async () => {
		// Given
		const cancellation = { called: false };
		let pipelineCalls = 0;
		const makeClient: PipelineClientFactory = () => ({
			async send(): Promise<SdkStreamResponse> {
				throw new TypeError("Injected pipeline runner must bypass the SDK client");
			},
		});
		const runPipeline = async (): Promise<Response> => {
			pipelineCalls += 1;
			if (pipelineCalls === 1) {
				return new Response(
					new ReadableStream({
						cancel(): void {
							cancellation.called = true;
						},
					}),
					{ headers: { "Content-Type": "application/octet-stream" } },
				);
			}
			return Response.json({
				choices: [
					{
						message: {
							content: "next request",
							reasoning_content: "queue released",
							tool_calls: [],
						},
					},
				],
				usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
			});
		};
		const server = startTestServer(makeClient, testConfig(), { runPipeline });

		// When
		const unsupportedResponse = await postResponse(server, {
			model: MODEL,
			input: "first",
			stream: false,
		});
		const nextResponse = await Promise.race([
			postResponse(server, { model: MODEL, input: "second", stream: false }),
			Bun.sleep(50).then(() => new Response(null, { status: 408 })),
		]);

		// Then
		expect(unsupportedResponse.status).toBe(500);
		expect(cancellation.called).toBe(true);
		expect(nextResponse.status).toBe(200);
		expect(pipelineCalls).toBe(2);
	});

	test("returns a complete non-stream Responses object", async () => {
		// Given
		const server = scriptedServer([
			eventsWith({ reasoning: "reason", text: "json answer" }),
		]);

		// When
		const response = await postResponse(
			server,
			{ model: MODEL, input: "hello", stream: false },
		);
		const body: unknown = await response.json();

		// Then
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			id: expect.any(String),
			object: "response",
			status: "completed",
			model: MODEL,
			output: [
				{ type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "json answer" }],
				},
			],
			usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
		});
	});

	test("returns completed function calls with Responses field names", async () => {
		// Given
		const tool = {
			id: "call_weather",
			name: "get_weather",
			arguments: '{"city":"Seattle"}',
		};
		const server = scriptedServer([[...eventsWith({ tool })]]);

		// When
		const response = await postResponse(
			server,
			{ model: MODEL, input: "weather", stream: false },
		);
		const body: unknown = await response.json();

		// Then
		expect(body).toMatchObject({
			status: "completed",
			output: expect.arrayContaining([
				{
					type: "function_call",
					call_id: tool.id,
					name: tool.name,
					arguments: tool.arguments,
				},
			]),
		});
	});

	test("preserves reasoning, function call, and tool output in a second-turn SDK request", async () => {
		// Given
		const firstTool = {
			id: "call_lookup",
			name: "lookup",
			arguments: '{"query":"status"}',
		};
		const server = scriptedServer([
			eventsWith({ reasoning: "inspect status", tool: firstTool }),
			eventsWith({ text: "done" }),
		]);
		const first = await postResponse(
			server,
			{ model: MODEL, input: "check status", stream: true },
		);
		expect(first.status).toBe(200);
		const firstFrames = parseSseFrames(await first.text());
		const completed = firstFrames.find(
			(frame) => frame.type === "response.completed",
		);
		const completedResponse = completed?.response;
		if (!isReadonlyRecord(completedResponse) || !Array.isArray(completedResponse.output)) {
			throw new TypeError("Turn one must emit completed response output");
		}
		const emittedReasoning = completedResponse.output.find(
			(item) => isReadonlyRecord(item) && item.type === "reasoning",
		);
		const emittedFunctionCall = completedResponse.output.find(
			(item) => isReadonlyRecord(item) && item.type === "function_call",
		);
		if (!isReadonlyRecord(emittedReasoning) || !isReadonlyRecord(emittedFunctionCall)) {
			throw new TypeError("Turn one must emit reasoning and function call items");
		}
		const emittedCallId = emittedFunctionCall.call_id;
		const emittedCallName = emittedFunctionCall.name;
		if (typeof emittedCallId !== "string" || typeof emittedCallName !== "string") {
			throw new TypeError("Emitted function call must contain call_id and name");
		}

		// When
		const second = await postResponse(
			server,
			{
				model: MODEL,
				input: [
					emittedReasoning,
					emittedFunctionCall,
					{
						type: "function_call_output",
						call_id: emittedCallId,
						output: "service is healthy",
					},
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "finish" }],
					},
				],
				stream: false,
			},
		);

		// Then
		expect(second.status).toBe(200);
		expect(emittedReasoning).toMatchObject({
			type: "reasoning",
			summary: [{ type: "summary_text", text: "inspect status" }],
		});
		expect(emittedFunctionCall).toMatchObject({
			type: "function_call",
			call_id: firstTool.id,
			name: firstTool.name,
			arguments: firstTool.arguments,
		});
		const secondCommand = JSON.stringify(server.capturedCommandInputs[1]);
		expect(secondCommand).toContain("<thinking>inspect status</thinking>");
		expect(secondCommand).toContain(emittedCallId);
		expect(secondCommand).toContain(emittedCallName);
		expect(secondCommand).toContain("service is healthy");
	});

	test.each([
		["missing authorization", null],
		["wrong authorization", "Bearer wrong"],
	])("returns 401 for %s", async (_label, authorization) => {
		const server = scriptedServer([eventsWith({ text: "unused" })]);
		const response = await postResponse(
			server,
			{ model: MODEL, input: "hello" },
			authorization,
		);
		await expectOpenAiError(response, 401);
	});

	test("returns 404 for an unknown authenticated route", async () => {
		const server = scriptedServer([eventsWith({ text: "unused" })]);
		const response = await postJson(server, "/unknown", {});
		await expectOpenAiError(response, 404);
	});

	test("returns 400 for malformed JSON", async () => {
		const server = scriptedServer([eventsWith({ text: "unused" })]);
		const response = await fetch(`${server.baseUrl}/v1/responses`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"Content-Type": "application/json",
				},
				body: "{bad-json",
			});
		await expectOpenAiError(response, 400);
	});

	test("returns 400 when input produces no executable messages", async () => {
		const server = scriptedServer([eventsWith({ text: "unused" })]);
		const response = await postResponse(
			server,
			{
				model: MODEL,
				instructions: "policy only",
				input: [{ type: "future_item", payload: true }],
			},
		);
		const body: unknown = await response.json();
		expect(response.status).toBe(400);
		expect(body).toMatchObject({ error: { code: "empty_input" } });
	});

	test("returns 413 for an oversized request body", async () => {
		const server = scriptedServer(
			[eventsWith({ text: "unused" })],
			testConfig({ max_request_body_bytes: 64 }),
		);
		const response = await postResponse(
			server,
			{ model: MODEL, input: "x".repeat(256) },
		);
		await expectOpenAiError(response, 413);
	});

	test("keeps POST /v1/chat/completions working", async () => {
		const server = scriptedServer([eventsWith({ text: "chat regression" })]);
		const response = await postJson(server, "/v1/chat/completions", {
				model: MODEL,
				messages: [{ role: "user", content: "hello" }],
				stream: false,
			});
		const body: unknown = await response.json();
		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			object: "chat.completion",
			choices: [{ message: { content: "chat regression" } }],
		});
	});
});

function typeOfNested(
	value: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const nested = value[key];
	if (!isReadonlyRecord(nested)) return undefined;
	return typeof nested.type === "string" ? nested.type : undefined;
}

function isReadonlyRecord(
	value: unknown,
): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
