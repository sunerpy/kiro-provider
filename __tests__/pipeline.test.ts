import { describe, expect, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import {
	type PipelineAccountManager,
	type PipelineSdkClient,
	type PipelineTokenRefresher,
	runChatCompletion,
} from "../src/core/pipeline.js";
import { createPipelineStreamResponse } from "../src/core/pipeline-stream.js";
import type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

const REQUEST_BODY = { messages: [{ role: "user", content: "hello" }] };

function account(id: string): ManagedAccount {
	return {
		id,
		email: `${id}@example.com`,
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: `${id}-refresh`,
		accessToken: `${id}-access`,
		expiresAt: Date.now() + 3_600_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
	};
}

class FakeAccountManager implements PipelineAccountManager {
	readonly rateLimited: string[] = [];
	readonly unhealthy: string[] = [];
	private cursor = 0;
	private stickyId: string | undefined;

	constructor(
		readonly accounts: ManagedAccount[],
		private readonly strategy: "round-robin" | "sticky" = "round-robin",
	) {}

	reconcileFromDb(): readonly ManagedAccount[] {
		return this.accounts;
	}

	selectHealthyAccount(): ManagedAccount | null {
		const now = Date.now();
		const selectable = this.accounts.filter(
			(candidate) => candidate.isHealthy && candidate.rateLimitResetTime <= now,
		);
		if (selectable.length === 0) return null;
		if (this.strategy === "sticky") {
			const selected =
				selectable.find((candidate) => candidate.id === this.stickyId) ??
				selectable[0];
			if (!selected) return null;
			this.stickyId = selected.id;
			return selected;
		}
		const selected = selectable[this.cursor % selectable.length];
		this.cursor += 1;
		return selected ?? null;
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
		return {
			refresh: selected.refreshToken,
			access: selected.accessToken,
			expires: selected.expiresAt,
			authMethod: selected.authMethod,
			region: selected.region,
			email: selected.email,
		};
	}

	markRateLimited(selected: ManagedAccount, resetTime: number): void {
		selected.rateLimitResetTime = resetTime;
		this.rateLimited.push(selected.id);
	}

	markUnhealthy(selected: ManagedAccount, reason: string): void {
		selected.failCount += 1;
		selected.isHealthy =
			selected.failCount < 10 && !reason.includes("InvalidTokenException");
		selected.unhealthyReason = reason;
		this.unhealthy.push(selected.id);
	}
}

class FakeTokenRefresher implements PipelineTokenRefresher {
	readonly refreshSignals: AbortSignal[] = [];
	readonly forceSignals: AbortSignal[] = [];
	refreshHandler?: (
		selected: ManagedAccount,
		signal: AbortSignal,
	) => Promise<ManagedAccount>;
	forceHandler?: (
		selected: ManagedAccount,
		signal: AbortSignal,
	) => Promise<ManagedAccount>;

	async refreshIfNeeded(
		selected: ManagedAccount,
		_auth: KiroAuthDetails,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		if (!signal)
			throw new TypeError("pipeline must pass a refresh AbortSignal");
		this.refreshSignals.push(signal);
		return this.refreshHandler
			? this.refreshHandler(selected, signal)
			: selected;
	}

	async forceRefresh(
		selected: ManagedAccount,
		signal?: AbortSignal,
	): Promise<ManagedAccount> {
		if (!signal)
			throw new TypeError("pipeline must pass a force-refresh AbortSignal");
		this.forceSignals.push(signal);
		return this.forceHandler ? this.forceHandler(selected, signal) : selected;
	}
}

function config(overrides: Partial<Config> = {}): Config {
	return ConfigSchema.parse({
		api_keys: ["sk-test"],
		request_timeout_ms: 5_000,
		stream_idle_timeout_ms: 1_000,
		rate_limit_retry_delay_ms: 10,
		...overrides,
	});
}

function responseFrom(events: readonly SdkStreamEvent[]): SdkStreamResponse {
	return {
		generateAssistantResponseResponse: {
			async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
				for (const event of events) yield event;
			},
		},
	};
}

function stalledResponse(first?: SdkStreamEvent): SdkStreamResponse {
	return {
		generateAssistantResponseResponse: {
			[Symbol.asyncIterator](): AsyncIterator<SdkStreamEvent> {
				let emitted = false;
				return {
					next(): Promise<IteratorResult<SdkStreamEvent>> {
						if (!emitted && first) {
							emitted = true;
							return Promise.resolve({ done: false, value: first });
						}
						return new Promise<IteratorResult<SdkStreamEvent>>(() => undefined);
					},
					return(): Promise<IteratorResult<SdkStreamEvent>> {
						return Promise.resolve({ done: true, value: undefined });
					},
				};
			},
		},
	};
}

function trackedStalledResponse(first: SdkStreamEvent): {
	readonly sdkResponse: SdkStreamResponse;
	readonly state: { returnCalled: boolean };
} {
	const state = { returnCalled: false };
	return {
		state,
		sdkResponse: {
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

function sdkError(
	status: number,
	message: string,
	extras: Record<string, unknown> = {},
): unknown {
	return {
		name: "SdkError",
		message,
		$metadata: { httpStatusCode: status },
		...extras,
	};
}

function clientWith(
	send: (signal: AbortSignal) => Promise<SdkStreamResponse>,
): PipelineSdkClient {
	return {
		send(_command: unknown, options: { readonly abortSignal: AbortSignal }) {
			return send(options.abortSignal);
		},
	};
}

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

async function errorBody(response: Response): Promise<{
	readonly error: {
		readonly message: string;
		readonly type: string;
		readonly code?: string;
	};
}> {
	const body: unknown = await response.json();
	if (
		typeof body !== "object" ||
		body === null ||
		!("error" in body) ||
		typeof body.error !== "object" ||
		body.error === null ||
		!("message" in body.error) ||
		typeof body.error.message !== "string" ||
		!("type" in body.error) ||
		typeof body.error.type !== "string"
	) {
		throw new TypeError("Expected an OpenAI error envelope");
	}
	const code = "code" in body.error ? body.error.code : undefined;
	return {
		error: {
			message: body.error.message,
			type: body.error.type,
			...(typeof code === "string" ? { code } : {}),
		},
	};
}

describe("runChatCompletion success paths", () => {
	test.each([
		{
			label: "configured",
			proxyUrl: "http://p:1080",
			expectedProxyUrl: "http://p:1080",
		},
		{ label: "disabled", proxyUrl: null, expectedProxyUrl: undefined },
	])("passes the $label proxy URL to the SDK client factory", async ({
		proxyUrl,
		expectedProxyUrl,
	}) => {
		// Given
		const capturedProxyUrls: Array<string | undefined> = [];

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config({ proxy_url: proxyUrl }),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: (...factoryArgs) => {
				capturedProxyUrls.push(factoryArgs[4]);
				return clientWith(async () =>
					responseFrom([{ assistantResponseEvent: { content: "answer" } }]),
				);
			},
		});

		// Then
		expect(response.status).toBe(200);
		expect(capturedProxyUrls).toEqual([expectedProxyUrl]);
	});

	test("returns a non-streaming completion with reasoning_content", async () => {
		// Given
		const manager = new FakeAccountManager([account("account-a")]);
		const refresher = new FakeTokenRefresher();
		const controller = new AbortController();
		let sendSignal: AbortSignal | undefined;

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "claude-opus-4-8",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			deadlineSignal: controller.signal,
			makeClient: () =>
				clientWith(async (signal) => {
					sendSignal = signal;
					return responseFrom([
						{ reasoningContentEvent: { text: "reason" } },
						{ assistantResponseEvent: { content: "answer" } },
					]);
				}),
		});

		// Then
		const completion: unknown = await response.json();
		expect(response.status).toBe(200);
		expect(completion).toMatchObject({
			choices: [
				{
					message: {
						role: "assistant",
						content: "answer",
						reasoning_content: "reason",
					},
				},
			],
		});
		expect(sendSignal).toBe(controller.signal);
		expect(refresher.refreshSignals).toEqual([controller.signal]);
	});

	test("returns a raw NDJSON chunk stream without an SSE done sentinel", async () => {
		// Given
		const manager = new FakeAccountManager([account("account-a")]);
		const refresher = new FakeTokenRefresher();

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "claude-opus-4-8",
			stream: true,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			makeClient: () =>
				clientWith(async () =>
					responseFrom([
						{ assistantResponseEvent: { content: "streamed answer" } },
					]),
				),
		});
		const body = await response.text();

		// Then
		const content = body
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).choices[0].delta.content ?? "")
			.join("");
		expect(response.headers.get("Content-Type")).toContain(
			"application/x-ndjson",
		);
		expect(content).toBe("streamed answer");
		expect(body).not.toContain("[DONE]");
	});
});

describe("runChatCompletion retry and switching", () => {
	test("marks a 429 account rate-limited and switches to another account", async () => {
		// Given
		const manager = new FakeAccountManager([
			account("account-a"),
			account("account-b"),
		]);
		const refresher = new FakeTokenRefresher();
		let calls = 0;

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			makeClient: () =>
				clientWith(async () => {
					calls += 1;
					if (calls === 1) {
						throw sdkError(429, "rate limited", {
							$response: { headers: { "retry-after": "1" } },
						});
					}
					return responseFrom([
						{ assistantResponseEvent: { content: "second account" } },
					]);
				}),
		});

		// Then
		expect(response.status).toBe(200);
		expect(manager.rateLimited).toEqual(["account-a"]);
		expect(calls).toBe(2);
	});

	test("force-refreshes once after invalid-bearer 403 then retries", async () => {
		// Given
		const manager = new FakeAccountManager([account("account-a")]);
		const refresher = new FakeTokenRefresher();
		const controller = new AbortController();
		let calls = 0;

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			deadlineSignal: controller.signal,
			makeClient: () =>
				clientWith(async () => {
					calls += 1;
					if (calls === 1) {
						throw sdkError(
							403,
							"The bearer token included in the request is invalid",
						);
					}
					return responseFrom([
						{ assistantResponseEvent: { content: "refreshed" } },
					]);
				}),
		});

		// Then
		expect(response.status).toBe(200);
		expect(calls).toBe(2);
		expect(refresher.forceSignals).toEqual([controller.signal]);
	});

	test("permanently disables a suspended sticky account and sends next with the second account", async () => {
		// Given
		const suspended = account("account-a");
		const replacement = account("account-b");
		const manager = new FakeAccountManager(
			[suspended, replacement],
			"sticky",
		);
		const sentAccounts: string[] = [];

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: (auth) =>
				clientWith(async () => {
					sentAccounts.push(auth.email ?? "missing");
					if (auth.email === suspended.email) {
						throw sdkError(403, "Account is suspended", {
							reason: "TEMPORARILY_SUSPENDED",
						});
					}
					return responseFrom([
						{ assistantResponseEvent: { content: "replacement" } },
					]);
				}),
		});

		// Then
		expect(response.status).toBe(200);
		expect(sentAccounts).toEqual([suspended.email, replacement.email]);
		expect(suspended.isHealthy).toBe(false);
		expect(suspended.unhealthyReason).toContain("InvalidTokenException");
	});

	test("excludes a sticky account at the 500 threshold before the next send", async () => {
		// Given
		const failing = account("account-a");
		const replacement = account("account-b");
		const manager = new FakeAccountManager([failing, replacement], "sticky");
		const sentAccounts: string[] = [];

		// When
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config({
				max_request_iterations: 10,
				request_timeout_ms: 30_000,
			}),
			accountManager: manager,
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: (auth) =>
				clientWith(async () => {
					sentAccounts.push(auth.email ?? "missing");
					if (auth.email === failing.email) {
						throw sdkError(500, "server error");
					}
					return responseFrom([
						{ assistantResponseEvent: { content: "replacement" } },
					]);
				}),
		});

		// Then
		expect(response.status).toBe(200);
		expect(sentAccounts).toEqual([
			failing.email,
			failing.email,
			failing.email,
			failing.email,
			failing.email,
			replacement.email,
		]);
		expect(failing.rateLimitResetTime).toBeGreaterThan(Date.now());
	}, 30_000);

	test("returns an OpenAI error when every account is unhealthy", async () => {
		const unavailable = account("account-a");
		unavailable.isHealthy = false;
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([unavailable]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: () => clientWith(async () => responseFrom([])),
		});

		expect(response.status).toBe(503);
		expect((await errorBody(response)).error.type).toBe("service_unavailable");
	});

	test("stops at the configured request iteration cap", async () => {
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config({ max_request_iterations: 2, rate_limit_max_retries: 10 }),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: () =>
				clientWith(async () => Promise.reject(sdkError(401, "unauthorized"))),
		});

		expect(response.status).toBe(500);
		expect((await errorBody(response)).error.message).toContain(
			"Exceeded max iterations (2)",
		);
	});
});

describe("runChatCompletion cancellation", () => {
	test("cancels a request waiting in the serial queue", async () => {
		// Given
		const firstStarted = deferred();
		const firstController = new AbortController();
		const secondController = new AbortController();
		let sendCalls = 0;
		const makeClient = (): PipelineSdkClient =>
			clientWith(async () => {
				sendCalls += 1;
				firstStarted.resolve();
				return new Promise<SdkStreamResponse>(() => undefined);
			});
		const first = runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			deadlineSignal: firstController.signal,
			makeClient,
		});
		await firstStarted.promise;

		// When
		const second = runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-b")]),
			tokenRefresher: new FakeTokenRefresher(),
			deadlineSignal: secondController.signal,
			makeClient,
		});
		secondController.abort();
		const secondResponse = await second;

		// Then
		expect(secondResponse.status).toBe(504);
		expect(sendCalls).toBe(1);
		firstController.abort();
		expect((await first).status).toBe(504);
	});

	test("cancels token refresh with the same ingress signal", async () => {
		// Given
		const controller = new AbortController();
		const refresher = new FakeTokenRefresher();
		const refreshStarted = deferred();
		refresher.refreshHandler = (_selected, signal) => {
			refreshStarted.resolve();
			return new Promise<ManagedAccount>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		};
		const pending = runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: refresher,
			deadlineSignal: controller.signal,
			makeClient: () => clientWith(async () => responseFrom([])),
		});
		await refreshStarted.promise;

		// When
		controller.abort();
		const response = await pending;

		// Then
		expect(response.status).toBe(504);
		expect(refresher.refreshSignals).toEqual([controller.signal]);
	});

	test.each([
		{
			label: "429 retry-after",
			error: sdkError(429, "rate limited", {
				$response: { headers: { "retry-after": "10" } },
			}),
		},
		{ label: "500 backoff", error: sdkError(500, "server error") },
	])("cancels during $label sleep", async ({ error }) => {
		// Given
		const controller = new AbortController();
		const sendFinished = deferred();
		const pending = runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			deadlineSignal: controller.signal,
			makeClient: () =>
				clientWith(async () => {
					sendFinished.resolve();
					throw error;
				}),
		});
		await sendFinished.promise;
		await Bun.sleep(0);

		// When
		controller.abort();
		const response = await pending;

		// Then
		expect(response.status).toBe(504);
	});

	test("passes the ingress signal to send and maps a pre-commit deadline to 504", async () => {
		// Given
		const controller = new AbortController();
		const sendStarted = deferred();
		let capturedSignal: AbortSignal | undefined;
		const pending = runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			deadlineSignal: controller.signal,
			makeClient: () =>
				clientWith(async (signal) => {
					capturedSignal = signal;
					sendStarted.resolve();
					return new Promise<SdkStreamResponse>(() => undefined);
				}),
		});
		await sendStarted.promise;

		// When
		controller.abort();
		const response = await pending;

		// Then
		expect(capturedSignal).toBe(controller.signal);
		expect(response.status).toBe(504);
		expect((await errorBody(response)).error.type).toBe("timeout_error");
	});

	test("the internally-created deadline cancels a pre-commit send", async () => {
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config({ request_timeout_ms: 15 }),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: () =>
				clientWith(async () => new Promise<SdkStreamResponse>(() => undefined)),
		});

		expect(response.status).toBe(504);
	});

	test("aborts an active stream after commit without emitting a done sentinel", async () => {
		// Given
		const controller = new AbortController();
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: true,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			deadlineSignal: controller.signal,
			makeClient: () =>
				clientWith(async () =>
					stalledResponse({ reasoningContentEvent: { text: "partial" } }),
				),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new TypeError("streaming response must have a body");
		const first = await reader.read();

		// When
		controller.abort();

		// Then
		await expect(reader.read()).rejects.toBeDefined();
		const partial = new TextDecoder().decode(first.value);
		expect(partial).toContain("partial");
		expect(partial).not.toContain("[DONE]");
	});

	test("errors a stream that exceeds its idle timeout without a done sentinel", async () => {
		// Given
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: true,
			config: config({ stream_idle_timeout_ms: 15 }),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: () =>
				clientWith(async () =>
					stalledResponse({ reasoningContentEvent: { text: "partial" } }),
				),
		});
		const reader = response.body?.getReader();
		if (!reader) throw new TypeError("streaming response must have a body");
		const first = await reader.read();

		// When / Then
		await expect(reader.read()).rejects.toThrow(/idle timeout/i);
		expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]");
	});

	test("tears down a stalled SDK iterator before finalizing an idle stream", async () => {
		// Given
		const stalled = trackedStalledResponse({
			reasoningContentEvent: { text: "partial" },
		});
		const ingress = new AbortController();
		let finalizeCalls = 0;
		let finalizedAfterReturn = false;
		const response = createPipelineStreamResponse(
			{
				sdkResponse: stalled.sdkResponse,
				model: "claude-opus-4-8",
				conversationId: "conversation-id",
			},
			ingress.signal,
			15,
			() => {
				finalizeCalls += 1;
				finalizedAfterReturn = stalled.state.returnCalled;
			},
		);
		const reader = response.body?.getReader();
		if (!reader) throw new TypeError("streaming response must have a body");
		const first = await reader.read();

		// When
		const idleRead = reader.read();

		// Then
		await expect(idleRead).rejects.toThrow(/idle timeout/i);
		expect(new TextDecoder().decode(first.value)).not.toContain("[DONE]");
		expect(stalled.state.returnCalled).toBe(true);
		expect(finalizedAfterReturn).toBe(true);
		expect(finalizeCalls).toBe(1);
		expect(ingress.signal.aborted).toBe(false);
	});
});

describe("runChatCompletion terminal errors", () => {
	test("returns the exact status in a standard OpenAI error envelope", async () => {
		const response = await runChatCompletion({
			body: REQUEST_BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: new FakeAccountManager([account("account-a")]),
			tokenRefresher: new FakeTokenRefresher(),
			makeClient: () =>
				clientWith(async () =>
					Promise.reject(sdkError(402, "quota exhausted")),
				),
		});

		expect(response.status).toBe(402);
		expect(await errorBody(response)).toEqual({
			error: {
				message: "quota exhausted",
				type: "upstream_error",
				code: "SdkError",
			},
		});
	});
});
