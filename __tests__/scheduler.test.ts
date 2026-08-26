import { afterEach, describe, expect, test } from "bun:test";
import type {
	GenerateAssistantResponseCommand,
} from "@aws/codewhisperer-streaming-client";
import { ConfigSchema } from "../src/config/schema.js";
import { AccountManager } from "../src/core/account-manager.js";
import {
	type PipelineSdkClient,
	type PipelineTokenRefresher,
	runChatCompletion,
} from "../src/core/pipeline.js";
import type {
	SdkStreamEvent,
	SdkStreamResponse,
} from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

const databases: AccountsDatabase[] = [];
const BODY = canonicalRequest([message("user", "hello")], { model: "auto" });

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
		usedCount: 0,
	};
}

function setup(accountIds: readonly string[]): {
	readonly database: AccountsDatabase;
	readonly manager: AccountManager;
} {
	const database = new AccountsDatabase(":memory:");
	databases.push(database);
	const stored = accountIds.map((id) => database.insertAccount(account(id)));
	return {
		database,
		manager: new AccountManager(stored, "lowest-usage", database),
	};
}

const refresher: PipelineTokenRefresher = {
	refreshIfNeeded(
		selected: ManagedAccount,
		_auth: KiroAuthDetails,
	): Promise<ManagedAccount> {
		return Promise.resolve(selected);
	},
	forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
		return Promise.resolve(selected);
	},
};

function config() {
	return ConfigSchema.parse({
		api_keys: ["sk-test"],
		request_timeout_ms: 2_000,
		stream_idle_timeout_ms: 1_000,
		rate_limit_retry_delay_ms: 1,
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

function conversationId(command: GenerateAssistantResponseCommand): string {
	return command.input.conversationState?.conversationId ?? "";
}

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	if (!resolve) throw new TypeError("deferred resolver was not initialized");
	return { promise, resolve };
}

async function waitFor(
	condition: () => boolean,
	message: string,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(1);
	}
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("standard-driven scheduler", () => {
	test("reuses the persisted account and Kiro conversation id for one session", async () => {
		const { database, manager } = setup(["account-a", "account-b"]);
		const accounts: string[] = [];
		const conversations: string[] = [];
		const makeClient = (
			_auth: KiroAuthDetails,
			_region: string,
			_effort?: unknown,
			_endpoint?: string,
			_proxy?: string,
			accountId?: string,
		): PipelineSdkClient => ({
			send(command) {
				accounts.push(accountId ?? "");
				conversations.push(conversationId(command));
				return Promise.resolve(
					responseFrom([{ assistantResponseEvent: { content: "ok" } }]),
				);
			},
		});
		const options = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinity: { keyHash: "session-stable", source: "test" },
			affinityStore: database,
			makeClient,
		} as const;

		const first = await runChatCompletion(options);
		const second = await runChatCompletion({
			...options,
			body: canonicalRequest(
				[
					message("user", "hello", "messages.0"),
					message("assistant", "ok", "messages.1"),
					message("user", "follow-up", "messages.2"),
				],
				{ model: "auto" },
			),
		});

		expect([first.status, second.status]).toEqual([200, 200]);
		expect(accounts).toEqual(["account-a", "account-a"]);
		expect(conversations[0]).toBeString();
		expect(conversations[1]).toBe(conversations[0]);
		expect(database.getSessionAffinity("session-stable")).toMatchObject({
			accountId: "account-a",
			conversationId: conversations[0],
		});
	});

	test("uses a fresh Kiro conversation for identical requests without explicit affinity", async () => {
		const { manager } = setup(["account-a"]);
		const conversations: string[] = [];
		const makeClient = (): PipelineSdkClient => ({
			send(command) {
				conversations.push(conversationId(command));
				return Promise.resolve(
					responseFrom([{ assistantResponseEvent: { content: "ok" } }]),
				);
			},
		});
		const options = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			makeClient,
		} as const;

		const first = await runChatCompletion(options);
		const second = await runChatCompletion(options);

		expect([first.status, second.status]).toEqual([200, 200]);
		expect(conversations).toHaveLength(2);
		expect(conversations[1]).not.toBe(conversations[0]);
	});

	test("serializes one explicit session and reuses its account and conversation", async () => {
		const { database, manager } = setup(["account-a", "account-b"]);
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const accounts: string[] = [];
		const conversations: string[] = [];
		let sends = 0;
		const makeClient = (
			_auth: KiroAuthDetails,
			_region: string,
			_effort?: unknown,
			_endpoint?: string,
			_proxy?: string,
			accountId?: string,
		): PipelineSdkClient => ({
			async send(command) {
				sends += 1;
				accounts.push(accountId ?? "");
				conversations.push(conversationId(command));
				if (sends === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				}
				return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
			},
		});
		const options = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinity: { keyHash: "session-concurrent", source: "test" },
			affinityStore: database,
			makeClient,
		} as const;

		const first = runChatCompletion(options);
		await firstEntered.promise;
		const second = runChatCompletion(options);
		await Bun.sleep(20);

		expect(sends).toBe(1);
		releaseFirst.resolve();
		expect([(await first).status, (await second).status]).toEqual([200, 200]);
		expect(accounts).toEqual(["account-a", "account-a"]);
		expect(conversations).toHaveLength(2);
		expect(conversations[1]).toBe(conversations[0]);
	});

	test("runs different sessions concurrently when lowest-usage selects different accounts", async () => {
		const { database, manager } = setup(["account-a", "account-b"]);
		const release = deferred();
		const entered: string[] = [];
		const makeClient = (
			_auth: KiroAuthDetails,
			_region: string,
			_effort?: unknown,
			_endpoint?: string,
			_proxy?: string,
			accountId?: string,
		): PipelineSdkClient => ({
			async send() {
				entered.push(accountId ?? "");
				await release.promise;
				return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
			},
		});
		const base = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinityStore: database,
			makeClient,
		} as const;

		const first = runChatCompletion({
			...base,
			affinity: { keyHash: "session-a", source: "test" },
		});
		await waitFor(() => entered.length === 1, "first account did not enter");
		const second = runChatCompletion({
			...base,
			affinity: { keyHash: "session-b", source: "test" },
		});
		await waitFor(
			() => entered.length === 2,
			"different-account requests were globally serialized",
		);

		expect([...entered].sort()).toEqual(["account-a", "account-b"]);
		release.resolve();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
	});

	test("serializes different sessions that share one account", async () => {
		const { database, manager } = setup(["account-a"]);
		const releaseFirst = deferred();
		let sends = 0;
		const makeClient = (): PipelineSdkClient => ({
			async send() {
				sends += 1;
				if (sends === 1) await releaseFirst.promise;
				return responseFrom([{ assistantResponseEvent: { content: "ok" } }]);
			},
		});
		const base = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinityStore: database,
			makeClient,
		} as const;

		const first = runChatCompletion({
			...base,
			affinity: { keyHash: "session-a", source: "test" },
		});
		await waitFor(() => sends === 1, "first send did not enter");
		const second = runChatCompletion({
			...base,
			affinity: { keyHash: "session-b", source: "test" },
		});
		await Bun.sleep(20);

		expect(sends).toBe(1);
		releaseFirst.resolve();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(sends).toBe(2);
	});

	test("holds the account lease until a committed stream is consumed or cancelled", async () => {
		const { database, manager } = setup(["account-a"]);
		let sends = 0;
		const makeClient = (): PipelineSdkClient => ({
			send() {
				sends += 1;
				return Promise.resolve(
					responseFrom([{ assistantResponseEvent: { content: "ok" } }]),
				);
			},
		});
		const base = {
			body: BODY,
			model: "auto",
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinityStore: database,
			makeClient,
		} as const;

		const first = await runChatCompletion({
			...base,
			stream: true,
			affinity: { keyHash: "stream-session", source: "test" },
		});
		const secondPromise = runChatCompletion({
			...base,
			stream: false,
			affinity: { keyHash: "waiting-session", source: "test" },
		});
		await Bun.sleep(20);

		expect(sends).toBe(1);
		await first.body?.cancel("test completed");
		const second = await secondPromise;
		expect(second.status).toBe(200);
		expect(sends).toBe(2);
	});

	test("rotates the conversation on failover and reuses the replacement binding", async () => {
		const { database, manager } = setup(["account-a", "account-b"]);
		const accounts: string[] = [];
		const conversations: string[] = [];
		const makeClient = (
			_auth: KiroAuthDetails,
			_region: string,
			_effort?: unknown,
			_endpoint?: string,
			_proxy?: string,
			accountId?: string,
		): PipelineSdkClient => ({
			send(command) {
				accounts.push(accountId ?? "");
				conversations.push(conversationId(command));
				if (accountId === "account-a") {
					return Promise.reject({
						name: "RateLimitError",
						message: "rate limited",
						$metadata: { httpStatusCode: 429 },
						$response: { headers: { "retry-after": "0" } },
					});
				}
				return Promise.resolve(
					responseFrom([{ assistantResponseEvent: { content: "ok" } }]),
				);
			},
		});
		const options = {
			body: BODY,
			model: "auto",
			stream: false,
			config: config(),
			accountManager: manager,
			tokenRefresher: refresher,
			affinity: { keyHash: "session-failover", source: "test" },
			affinityStore: database,
			makeClient,
		} as const;

		expect((await runChatCompletion(options)).status).toBe(200);
		expect((await runChatCompletion(options)).status).toBe(200);

		expect(accounts).toEqual(["account-a", "account-b", "account-b"]);
		expect(conversations[0]).not.toBe(conversations[1]);
		expect(conversations[2]).toBe(conversations[1]);
		expect(database.getSessionAffinity("session-failover")).toMatchObject({
			accountId: "account-b",
			conversationId: conversations[1],
		});
	});
});
