import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type {
	PipelineAccountManager,
	PipelineClientFactory,
	PipelineSdkClient,
	PipelineTokenRefresher,
} from "../src/core/pipeline.js";
import type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { createApp } from "../src/server/app.js";

const API_KEY = "sk-integration";
const encoder = new TextEncoder();

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
		id: "integration-account",
		email: "integration@example.com",
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

function failingSdkResponse(): SdkStreamResponse {
	return {
		generateAssistantResponseResponse: {
			async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
				yield { reasoningContentEvent: { text: "partial" } };
				throw new Error("upstream stream failed");
			},
		},
	};
}

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) throw new TypeError("deferred resolver was not initialized");
	return { promise, resolve: resolvePromise };
}

function client(response: SdkStreamResponse): PipelineSdkClient {
	return {
		async send(): Promise<SdkStreamResponse> {
			return response;
		},
	};
}

function makeClientFor(body: Record<string, unknown>): PipelineClientFactory {
	return () => {
		if (body.mode === "stream-error") return client(failingSdkResponse());
		if (body.stream === true) {
			return client(
				sdkResponse([
					{ reasoningContentEvent: { text: "thinking" } },
					{ assistantResponseEvent: { content: "answer" } },
					{
						toolUseEvent: {
							name: "first_tool",
							toolUseId: "tool-1",
							input: '{"a":1}',
							stop: true,
						},
					},
					{
						toolUseEvent: {
							name: "second_tool",
							toolUseId: "tool-2",
							input: '{"b":2}',
							stop: true,
						},
					},
				]),
			);
		}
		return client(
			sdkResponse([{ assistantResponseEvent: { content: "json answer" } }]),
		);
	};
}

function startTestServer(config: Config = testConfig()): {
	readonly server: ReturnType<typeof Bun.serve>;
	readonly baseUrl: string;
} {
	const app = createTestApp(config);
	const server = Bun.serve({ port: 0, fetch: app });
	return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

function createTestApp(config: Config = testConfig()): ReturnType<typeof createApp> {
	const manager = new FakeAccountManager();
	const refresher = new FakeTokenRefresher();
	return createApp(config, {
		accountManager: manager,
		tokenRefresher: refresher,
		makeClient: (...factoryArgs) => {
			const latestBody = requestBodies.at(-1) ?? {};
			return makeClientFor(latestBody)(...factoryArgs);
		},
	});
}

const requestBodies: Record<string, unknown>[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
	const started = startTestServer();
	server = started.server;
	baseUrl = started.baseUrl;
});

afterAll(() => {
	server.stop(true);
});

async function postJson(
	body: Record<string, unknown>,
	authorization = `Bearer ${API_KEY}`,
): Promise<Response> {
	requestBodies.push(body);
	return fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: "auto",
		messages: [{ role: "user", content: "hello" }],
		...overrides,
	};
}

async function expectOpenAiError(response: Response, status: number): Promise<void> {
	const body: unknown = await response.json();
	expect(response.status).toBe(status);
	expect(body).toMatchObject({
		error: { message: expect.any(String), type: expect.any(String) },
	});
}

describe("POST /v1/chat/completions", () => {
	test("reframes successful NDJSON as SSE with one terminal sentinel", async () => {
		// Given / When
		const response = await postJson(validBody({ stream: true }));
		const text = await response.text();
		const frames = text.split("\n\n").filter(Boolean);
		const jsonFrames = frames
			.filter((frame) => frame !== "data: [DONE]")
			.map((frame) => JSON.parse(frame.slice("data: ".length)));
		const toolStarts = jsonFrames.flatMap((chunk) =>
			(chunk.choices?.[0]?.delta?.tool_calls ?? []).filter(
				(call: { readonly id?: string }) => call.id !== undefined,
			),
		);

		// Then
		expect(response.headers.get("Content-Type")).toContain("text/event-stream");
		expect(frames.filter((frame) => frame === "data: [DONE]")).toHaveLength(1);
		expect(frames.at(-1)).toBe("data: [DONE]");
		expect(
			jsonFrames.some(
				(chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls",
			),
		).toBe(true);
		expect(toolStarts.map((call) => call.index)).toEqual([0, 1]);
	});

	test("passes a non-streaming OpenAI completion through as JSON", async () => {
		// Given / When
		const response = await postJson(validBody());
		const body: unknown = await response.json();

		// Then
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(body).toMatchObject({
			object: "chat.completion",
			choices: [{ message: { role: "assistant", content: "json answer" } }],
		});
	});

	test("accepts an assistant tool-call turn with null content", async () => {
		// Given
		const body = validBody({
			messages: [
				{ role: "user", content: "call the tool" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call-1",
							type: "function",
							function: { name: "lookup", arguments: "{}" },
						},
					],
				},
				{ role: "tool", content: "tool result", tool_call_id: "call-1" },
			],
		});

		// When
		const response = await postJson(body);

		// Then
		expect(response.status).toBe(200);
	});

	test("emits an observable error frame without a done sentinel when the upstream stream errors", async () => {
		// Given
		const body = validBody({ stream: true, mode: "stream-error" });

		// When
		const response = await postJson(body);
		const received = await response.text();
		const frames = received.split("\n\n").filter(Boolean);
		const errorFrames = frames
			.filter((frame) => frame.startsWith("data: {") && frame !== "data: [DONE]")
			.map((frame) => JSON.parse(frame.slice("data: ".length)))
			.filter((frame) => frame.error !== undefined);

		// Then
		expect(errorFrames).toEqual([
			{
				error: {
					message: "Upstream stream error",
					type: "upstream_error",
				},
			},
		]);
		expect(received).not.toContain("data: [DONE]");
	});

	test("aborts the upstream signal when the client disconnects", async () => {
		// Given
		const upstreamAborted = deferred();
		const sendStarted = deferred();
		const manager = new FakeAccountManager();
		const refresher = new FakeTokenRefresher();
		const makeClient: PipelineClientFactory = () => ({
			async send(_command, options): Promise<SdkStreamResponse> {
				options.abortSignal.addEventListener(
					"abort",
					() => upstreamAborted.resolve(),
					{ once: true },
				);
				sendStarted.resolve();
				return new Promise<SdkStreamResponse>(() => undefined);
			},
		});
		const disconnectServer = Bun.serve({
			port: 0,
			fetch: createApp(testConfig({ request_timeout_ms: 5_000 }), {
				accountManager: manager,
				tokenRefresher: refresher,
				makeClient,
			}),
		});
		const clientController = new AbortController();
		const pendingResponse = fetch(
			`http://127.0.0.1:${disconnectServer.port}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(validBody({ stream: true })),
				signal: clientController.signal,
			},
		).catch((error: unknown) => error);
		await sendStarted.promise;

		// When
		clientController.abort();

		// Then
		await expect(
			Promise.race([
				upstreamAborted.promise,
				Bun.sleep(250).then(() => Promise.reject(new Error("upstream was not aborted"))),
			]),
		).resolves.toBeUndefined();
		expect(await pendingResponse).toBeInstanceOf(Error);
		disconnectServer.stop(true);
	});
});

describe("HTTP boundary errors", () => {
	test.each([
		["missing key", undefined],
		["wrong key", "Bearer wrong"],
	])("returns 401 for %s", async (_label, authorization) => {
		const response = await fetch(`${baseUrl}/v1/models`, {
			headers: authorization ? { Authorization: authorization } : {},
		});
		await expectOpenAiError(response, 401);
	});

	test("returns 404 for an unknown authenticated route", async () => {
		const response = await fetch(`${baseUrl}/unknown`, {
			headers: { Authorization: `Bearer ${API_KEY}` },
		});
		await expectOpenAiError(response, 404);
	});

	test("returns 413 while reading a body beyond the configured limit", async () => {
		const response = await postJson(validBody({ padding: "x".repeat(20_000) }));
		await expectOpenAiError(response, 413);
	});

	test("returns 400 for malformed JSON", async () => {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${API_KEY}`,
				"Content-Type": "application/json",
			},
			body: "{bad-json",
		});
		await expectOpenAiError(response, 400);
	});

	test.each([
		["missing messages", { model: "auto" }],
		[
			"malformed content part",
			validBody({ messages: [{ role: "user", content: [{ type: "audio" }] }] }),
		],
		[
			"missing tool_call_id",
			validBody({ messages: [{ role: "tool", content: "result" }] }),
		],
		[
			"non-string tool arguments",
			validBody({
				messages: [
					{
						role: "assistant",
						content: "calling",
						tool_calls: [
							{
								id: "call-1",
								type: "function",
								function: { name: "tool", arguments: { value: 1 } },
							},
						],
					},
				],
			}),
		],
		[
			"invalid JSON tool arguments",
			validBody({
				messages: [
					{
						role: "assistant",
						content: "calling",
						tool_calls: [
							{
								id: "call-1",
								type: "function",
								function: { name: "tool", arguments: "{" },
							},
						],
					},
				],
			}),
		],
		[
			"assistant without content or tool calls",
			validBody({ messages: [{ role: "assistant" }] }),
		],
		["invalid reasoning effort", validBody({ reasoning_effort: "extreme" })],
	])("returns 400 for %s", async (_label, body) => {
		const response = await postJson(body);
		await expectOpenAiError(response, 400);
	});

	test("returns 504 when a streamed request body stalls beyond the ingress deadline", async () => {
		// Given
		const timeoutServer = startTestServer(
			testConfig({ request_timeout_ms: 20, max_request_body_bytes: 16_384 }),
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"model":"auto","messages":['));
			},
		});

		// When
		const response = await fetch(
			`${timeoutServer.baseUrl}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_KEY}`,
					"Content-Type": "application/json",
				},
				body: stream,
			},
		);

		// Then
		await expectOpenAiError(response, 504);
		timeoutServer.server.stop(true);
	});
});
