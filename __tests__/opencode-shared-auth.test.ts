import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	OpenCodeAuthStore,
	OpenCodeAuthStoreError,
	openCodePluginDirForDatabase,
} from "../src/auth/opencode-auth-store.js";
import {
	OpenCodeAccountManager,
	OpenCodeTokenRefresher,
} from "../src/core/opencode-auth-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";

const realFetch = globalThis.fetch;
const stores: OpenCodeAuthStore[] = [];
const temporaryDirectories: string[] = [];

function installFetch(
	handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): void {
	globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect });
}

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		id: "shared-account-A",
		email: "shared-account@example.invalid",
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: "refresh-old",
		accessToken: "access-old",
		expiresAt: Date.now() - 1,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 0,
		limitCount: 100,
		overageCount: 0,
		lastSync: 0,
		lastUsed: 0,
		...overrides,
	};
}

function createDatabase(
	initialAccounts: readonly ManagedAccount[] = [account()],
): string {
	const directory = mkdtempSync(join(tmpdir(), "kiro-provider-shared-auth-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "opencode", "kiro.db");
	mkdirSync(dirname(databasePath), { recursive: true });
	const db = new Database(databasePath, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			auth_method TEXT NOT NULL,
			region TEXT NOT NULL,
			oidc_region TEXT,
			client_id TEXT,
			client_secret TEXT,
			profile_arn TEXT,
			start_url TEXT,
			refresh_token TEXT NOT NULL,
			access_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			rate_limit_reset INTEGER DEFAULT 0,
			is_healthy INTEGER DEFAULT 1,
			unhealthy_reason TEXT,
			recovery_time INTEGER,
			fail_count INTEGER DEFAULT 0,
			last_used INTEGER DEFAULT 0,
			used_count INTEGER DEFAULT 0,
			limit_count INTEGER DEFAULT 0,
			overage_count INTEGER DEFAULT 0,
			last_sync INTEGER DEFAULT 0
		)
	`);
	db.run(`
		CREATE TABLE removed_accounts (
			id TEXT PRIMARY KEY,
			removed_at INTEGER NOT NULL
		)
	`);
	const insert = db.query(`
		INSERT INTO accounts (
			id, email, auth_method, region, oidc_region, client_id, client_secret,
			profile_arn, start_url, refresh_token, access_token, expires_at,
			rate_limit_reset, is_healthy, unhealthy_reason, recovery_time,
			fail_count, last_used, used_count, limit_count, overage_count, last_sync
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const current of initialAccounts) {
		insert.run(
			current.id,
			current.email,
			current.authMethod,
			current.region,
			current.oidcRegion ?? null,
			current.clientId ?? null,
			current.clientSecret ?? null,
			current.profileArn ?? null,
			current.startUrl ?? null,
			current.refreshToken,
			current.accessToken,
			current.expiresAt,
			current.rateLimitResetTime,
			current.isHealthy ? 1 : 0,
			current.unhealthyReason ?? null,
			current.recoveryTime ?? null,
			current.failCount,
			current.lastUsed ?? 0,
			current.usedCount ?? 0,
			current.limitCount ?? 0,
			current.overageCount ?? 0,
			current.lastSync ?? 0,
		);
	}
	db.close();
	return databasePath;
}

function openStore(path: string): OpenCodeAuthStore {
	const store = new OpenCodeAuthStore(path);
	stores.push(store);
	return store;
}

function updateTokens(
	path: string,
	id: string,
	refreshToken: string,
	accessToken: string,
	expiresAt: number,
): void {
	const db = new Database(path, { strict: true });
	try {
		db.query(`
			UPDATE accounts
			SET refresh_token = ?, access_token = ?, expires_at = ?
			WHERE id = ?
		`).run(refreshToken, accessToken, expiresAt, id);
	} finally {
		db.close();
	}
}

function refreshResponse(
	accessToken = "access-rotated",
	refreshToken = "refresh-rotated",
): Response {
	return new Response(
		JSON.stringify({ accessToken, refreshToken, expiresIn: 3_600 }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) throw new TypeError("Deferred resolver was not initialized");
	return { promise, resolve: resolvePromise };
}

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const store of stores.splice(0)) store.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("OpenCode shared authentication runtime", () => {
	test("fails closed when the selected database is not an opencode-kiro-auth store", () => {
		const directory = mkdtempSync(join(tmpdir(), "kiro-provider-bad-auth-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "kiro.db");
		const db = new Database(databasePath, { create: true });
		db.run("CREATE TABLE unrelated (id TEXT)");
		db.close();

		expect(() => new OpenCodeAuthStore(databasePath)).toThrow(
			OpenCodeAuthStoreError,
		);
	});

	test("filters tombstones and persists account selection in the shared database", () => {
		const removed = account({ id: "removed-account" });
		const databasePath = createDatabase([account(), removed]);
		const db = new Database(databasePath, { strict: true });
		db.query(
			"INSERT INTO removed_accounts (id, removed_at) VALUES (?, ?)",
		).run(removed.id, Date.now());
		db.close();
		const store = openStore(databasePath);
		const manager = new OpenCodeAccountManager(store, "sticky");

		const selected = manager.selectHealthyAccount();

		expect(manager.getAccountCount()).toBe(1);
		expect(selected?.id).toBe("shared-account-A");
		expect(store.getById("shared-account-A")).toMatchObject({
			usedCount: 1,
		});
		expect(store.getById(removed.id)).toBeUndefined();
	});

	test("reuses a fresh token rotated by another process without a network refresh", async () => {
		const databasePath = createDatabase();
		const store = openStore(databasePath);
		const manager = new OpenCodeAccountManager(store, "sticky");
		const stale = manager.selectHealthyAccount();
		expect(stale).toBeDefined();
		if (!stale) return;
		updateTokens(
			databasePath,
			stale.id,
			"refresh-external",
			"access-external",
			Date.now() + 3_600_000,
		);
		let fetchCalls = 0;
		installFetch(async () => {
			fetchCalls += 1;
			return refreshResponse();
		});
		const refresher = new OpenCodeTokenRefresher(manager, store, 300_000);

		const refreshed = await refresher.refreshIfNeeded(
			stale,
			manager.toAuthDetails(stale),
		);

		expect(fetchCalls).toBe(0);
		expect(refreshed).toMatchObject({
			refreshToken: "refresh-external",
			accessToken: "access-external",
		});
	});

	test("serializes two provider processes through the opencode refresh lock", async () => {
		const databasePath = createDatabase();
		const firstStore = openStore(databasePath);
		const secondStore = openStore(databasePath);
		const firstManager = new OpenCodeAccountManager(firstStore, "sticky");
		const secondManager = new OpenCodeAccountManager(secondStore, "sticky");
		const firstAccount = firstManager.selectHealthyAccount();
		const secondAccount = secondManager.selectHealthyAccount();
		expect(firstAccount).toBeDefined();
		expect(secondAccount).toBeDefined();
		if (!firstAccount || !secondAccount) return;

		const started = deferred();
		const release = deferred();
		let fetchCalls = 0;
		installFetch(async () => {
			fetchCalls += 1;
			started.resolve();
			await release.promise;
			return refreshResponse();
		});
		const lockDirectory = openCodePluginDirForDatabase(databasePath);
		const firstRefresher = new OpenCodeTokenRefresher(
			firstManager,
			firstStore,
			300_000,
			undefined,
			lockDirectory,
		);
		const secondRefresher = new OpenCodeTokenRefresher(
			secondManager,
			secondStore,
			300_000,
			undefined,
			lockDirectory,
		);

		const first = firstRefresher.refreshIfNeeded(
			firstAccount,
			firstManager.toAuthDetails(firstAccount),
		);
		await started.promise;
		const second = secondRefresher.refreshIfNeeded(
			secondAccount,
			secondManager.toAuthDetails(secondAccount),
		);
		release.resolve();
		const results = await Promise.all([first, second]);

		expect(fetchCalls).toBe(1);
		expect(results.map(({ accessToken }) => accessToken)).toEqual([
			"access-rotated",
			"access-rotated",
		]);
		expect(firstStore.getById(firstAccount.id)).toMatchObject({
			refreshToken: "refresh-rotated",
			accessToken: "access-rotated",
		});
	});

	test("does not overwrite a newer login committed while refresh is in flight", async () => {
		const databasePath = createDatabase();
		const store = openStore(databasePath);
		const manager = new OpenCodeAccountManager(store, "sticky");
		const selected = manager.selectHealthyAccount();
		expect(selected).toBeDefined();
		if (!selected) return;

		const started = deferred();
		const release = deferred();
		installFetch(async () => {
			started.resolve();
			await release.promise;
			return refreshResponse("access-stale", "refresh-stale");
		});
		const refresher = new OpenCodeTokenRefresher(manager, store, 300_000);
		const refreshing = refresher.forceRefresh(selected);
		await started.promise;
		updateTokens(
			databasePath,
			selected.id,
			"refresh-relogin",
			"access-relogin",
			Date.now() + 7_200_000,
		);
		release.resolve();

		const result = await refreshing;

		expect(result).toMatchObject({
			refreshToken: "refresh-relogin",
			accessToken: "access-relogin",
		});
		expect(store.getById(selected.id)).toMatchObject({
			refreshToken: "refresh-relogin",
			accessToken: "access-relogin",
		});
	});
});
