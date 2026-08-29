import { describe, expect, test } from "bun:test";
import { QuotaRechecker } from "../src/core/quota-rechecker.js";
import { isQuotaExhausted } from "../src/kiro/health.js";
import type {
	KiroAuthDetails,
	KiroUsageSnapshot,
	ManagedAccount,
} from "../src/kiro/types.js";
import { KiroUsageError } from "../src/kiro/usage-client.js";

function account(
	id = "account-a",
	overrides: Partial<ManagedAccount> = {},
): ManagedAccount {
	return {
		id,
		email: `${id}@example.com`,
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: `${id}-refresh`,
		accessToken: `${id}-access`,
		expiresAt: Date.now() + 60_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 100,
		limitCount: 100,
		overageCount: 0,
		lastSync: 1,
		...overrides,
	};
}

class FakeManager {
	readonly scheduled: number[] = [];
	readonly unhealthy: string[] = [];

	constructor(readonly accounts: ManagedAccount[]) {}

	toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
		return {
			refresh: selected.refreshToken,
			access: selected.accessToken,
			expires: selected.expiresAt,
			authMethod: selected.authMethod,
			region: selected.region,
			email: selected.email,
			...(selected.profileArn ? { profileArn: selected.profileArn } : {}),
		};
	}

	markUnhealthy(
		selected: ManagedAccount,
		reason: string,
	): ManagedAccount | undefined {
		const current = this.accounts.find(({ id }) => id === selected.id);
		if (!current) return undefined;
		current.isHealthy = false;
		current.unhealthyReason = reason;
		current.failCount = 10;
		this.unhealthy.push(reason);
		return current;
	}

	scheduleQuotaRecheck(
		selected: ManagedAccount,
		recheckAfter: number,
	): ManagedAccount | undefined {
		const current = this.accounts.find(({ id }) => id === selected.id);
		if (!current) return undefined;
		if (isQuotaExhausted(current)) {
			current.rateLimitResetTime = Math.max(
				current.rateLimitResetTime,
				recheckAfter,
			);
			this.scheduled.push(recheckAfter);
		}
		return current;
	}

	updateQuotaUsage(
		selected: ManagedAccount,
		usage: KiroUsageSnapshot & { readonly lastSync: number },
		nextRecheckAt: number,
	): ManagedAccount | undefined {
		const current = this.accounts.find(({ id }) => id === selected.id);
		if (!current) return undefined;
		if ((current.lastSync ?? 0) > usage.lastSync) return current;
		current.email = usage.email ?? current.email;
		current.usedCount = usage.usedCount;
		current.limitCount = usage.limitCount;
		current.overageCount = usage.overageCount;
		current.lastSync = usage.lastSync;
		current.rateLimitResetTime = nextRecheckAt;
		current.isHealthy = true;
		current.failCount = 0;
		current.unhealthyReason = undefined;
		current.recoveryTime = undefined;
		return current;
	}
}

class FakeRefresher {
	refreshCalls = 0;
	forceCalls = 0;

	async refreshIfNeeded(
		selected: ManagedAccount,
		_auth: KiroAuthDetails,
		_signal?: AbortSignal,
	): Promise<ManagedAccount> {
		this.refreshCalls += 1;
		return selected;
	}

	async forceRefresh(
		selected: ManagedAccount,
		_signal?: AbortSignal,
	): Promise<ManagedAccount> {
		this.forceCalls += 1;
		selected.accessToken = `${selected.id}-rotated-access`;
		return selected;
	}
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) throw new TypeError("Deferred resolver was not initialized");
	return { promise, resolve: resolvePromise };
}

function rechecker(
	manager: FakeManager,
	refresher: FakeRefresher,
	fetchUsage: (
		auth: KiroAuthDetails,
		options: { readonly signal?: AbortSignal },
	) => Promise<KiroUsageSnapshot>,
	now = 1_000_000,
): QuotaRechecker {
	return new QuotaRechecker({
		accountManager: manager,
		tokenRefresher: refresher,
		intervalMs: 60_000,
		usageRefreshIntervalMs: 60_000,
		timeoutMs: 1_000,
		concurrency: 2,
		now: () => now,
		fetchUsage,
	});
}

describe("QuotaRechecker", () => {
	test("restores a due account only after the authoritative usage snapshot recovers", async () => {
		const exhausted = account();
		const manager = new FakeManager([exhausted]);
		const refresher = new FakeRefresher();
		const service = rechecker(manager, refresher, async () => ({
			usedCount: 0,
			limitCount: 100,
			overageCount: 0,
			email: "updated@example.com",
		}));

		await service.recheckDueAccounts(
			[exhausted],
			new AbortController().signal,
		);

		expect(refresher.refreshCalls).toBe(1);
		expect(exhausted).toMatchObject({
			email: "updated@example.com",
			usedCount: 0,
			limitCount: 100,
			overageCount: 0,
			lastSync: 1_000_000,
			rateLimitResetTime: 0,
		});
		expect(isQuotaExhausted(exhausted)).toBe(false);
	});

	test("keeps a still-exhausted account excluded until the next probe window", async () => {
		const exhausted = account();
		const manager = new FakeManager([exhausted]);
		const service = rechecker(
			manager,
			new FakeRefresher(),
			async () => ({
				usedCount: 100,
				limitCount: 100,
				overageCount: 0,
			}),
		);

		await service.recheckDueAccounts(
			[exhausted],
			new AbortController().signal,
		);

		expect(exhausted.rateLimitResetTime).toBe(1_060_000);
		expect(isQuotaExhausted(exhausted)).toBe(true);
	});

	test("does not probe an account before its persisted recheck time", async () => {
		const exhausted = account("future", {
			rateLimitResetTime: 1_000_001,
		});
		const manager = new FakeManager([exhausted]);
		let fetchCalls = 0;
		const service = rechecker(manager, new FakeRefresher(), async () => {
			fetchCalls += 1;
			return { usedCount: 0, limitCount: 100, overageCount: 0 };
		});

		await service.recheckDueAccounts(
			[exhausted],
			new AbortController().signal,
		);

		expect(fetchCalls).toBe(0);
	});

	test("backs off a failed probe without sending a model request", async () => {
		const exhausted = account();
		const manager = new FakeManager([exhausted]);
		const service = rechecker(manager, new FakeRefresher(), async () => {
			throw new Error("offline");
		});

		await service.recheckDueAccounts(
			[exhausted],
			new AbortController().signal,
		);

		expect(manager.scheduled).toEqual([1_060_000]);
		expect(exhausted.rateLimitResetTime).toBe(1_060_000);
		expect(isQuotaExhausted(exhausted)).toBe(true);
	});

	test("force-refreshes once after an invalid bearer usage response", async () => {
		const exhausted = account();
		const manager = new FakeManager([exhausted]);
		const refresher = new FakeRefresher();
		const accessTokens: string[] = [];
		const service = rechecker(manager, refresher, async (auth) => {
			accessTokens.push(auth.access);
			if (accessTokens.length === 1) {
				throw new KiroUsageError(
					"The bearer token included in the request is invalid",
					403,
				);
			}
			return { usedCount: 0, limitCount: 100, overageCount: 0 };
		});

		await service.recheckDueAccounts(
			[exhausted],
			new AbortController().signal,
		);

		expect(refresher.forceCalls).toBe(1);
		expect(accessTokens).toEqual([
			"account-a-access",
			"account-a-rotated-access",
		]);
		expect(isQuotaExhausted(exhausted)).toBe(false);
	});

	test("deduplicates concurrent probes for the same account", async () => {
		const exhausted = account();
		const manager = new FakeManager([exhausted]);
		const pending = deferred<KiroUsageSnapshot>();
		let fetchCalls = 0;
		const service = rechecker(manager, new FakeRefresher(), async () => {
			fetchCalls += 1;
			return pending.promise;
		});
		const signal = new AbortController().signal;

		const first = service.recheckDueAccounts([exhausted], signal);
		const second = service.recheckDueAccounts([exhausted], signal);
		await Promise.resolve();
		expect(fetchCalls).toBe(1);
		pending.resolve({ usedCount: 0, limitCount: 100, overageCount: 0 });
		await Promise.all([first, second]);

		expect(fetchCalls).toBe(1);
		expect(isQuotaExhausted(exhausted)).toBe(false);
	});

	test("periodically refreshes a stale non-exhausted usage snapshot", async () => {
		const healthy = account("healthy", {
			usedCount: 20,
			limitCount: 100,
			lastSync: 900_000,
		});
		const manager = new FakeManager([healthy]);
		let fetchCalls = 0;
		const service = rechecker(manager, new FakeRefresher(), async () => {
			fetchCalls += 1;
			return { usedCount: 25, limitCount: 100, overageCount: 0 };
		});

		await service.syncDueAccounts(
			[healthy],
			new AbortController().signal,
		);

		expect(fetchCalls).toBe(1);
		expect(healthy).toMatchObject({
			usedCount: 25,
			limitCount: 100,
			lastSync: 1_000_000,
		});
	});

	test("skips a fresh non-exhausted usage snapshot", async () => {
		const healthy = account("fresh", {
			usedCount: 20,
			limitCount: 100,
			lastSync: 999_999,
		});
		const manager = new FakeManager([healthy]);
		let fetchCalls = 0;
		const service = rechecker(manager, new FakeRefresher(), async () => {
			fetchCalls += 1;
			return { usedCount: 25, limitCount: 100, overageCount: 0 };
		});

		await service.syncDueAccounts(
			[healthy],
			new AbortController().signal,
		);

		expect(fetchCalls).toBe(0);
	});

	test("moves an account out of selection when periodic usage detects exhaustion", async () => {
		const healthy = account("newly-exhausted", {
			usedCount: 20,
			limitCount: 100,
			lastSync: 0,
		});
		const manager = new FakeManager([healthy]);
		const service = rechecker(manager, new FakeRefresher(), async () => ({
			usedCount: 100,
			limitCount: 100,
			overageCount: 0,
		}));

		await service.syncDueAccounts(
			[healthy],
			new AbortController().signal,
		);

		expect(isQuotaExhausted(healthy)).toBe(true);
		expect(healthy.rateLimitResetTime).toBe(1_060_000);
	});

	test("backs off a failed periodic usage refresh in memory", async () => {
		const healthy = account("usage-failure", {
			usedCount: 20,
			limitCount: 100,
			lastSync: 0,
		});
		const manager = new FakeManager([healthy]);
		let fetchCalls = 0;
		const service = rechecker(manager, new FakeRefresher(), async () => {
			fetchCalls += 1;
			throw new Error("offline");
		});
		const signal = new AbortController().signal;

		await service.syncDueAccounts([healthy], signal);
		await service.syncDueAccounts([healthy], signal);

		expect(fetchCalls).toBe(1);
		expect(manager.scheduled).toEqual([]);
	});

	test("marks a dead refresh credential unhealthy during autonomous usage sync", async () => {
		const healthy = account("dead-refresh", {
			usedCount: 20,
			limitCount: 100,
			lastSync: 0,
		});
		const manager = new FakeManager([healthy]);
		const refresher = new FakeRefresher();
		refresher.refreshIfNeeded = async () => {
			throw Object.assign(new Error("Invalid grant provided"), {
				code: "invalid_grant",
			});
		};
		const service = rechecker(manager, refresher, async () => ({
			usedCount: 25,
			limitCount: 100,
			overageCount: 0,
		}));

		await service.syncDueAccounts(
			[healthy],
			new AbortController().signal,
		);

		expect(healthy.isHealthy).toBe(false);
		expect(healthy.failCount).toBe(10);
		expect(manager.unhealthy).toHaveLength(1);
	});
});
