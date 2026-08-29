import { describe, expect, test } from "bun:test";
import {
	AccountMaintenanceService,
	bindAccountMaintenanceLifecycle,
} from "../src/core/account-maintenance.js";
import type { PipelineQuotaRechecker } from "../src/core/quota-rechecker.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

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
		expiresAt: 0,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 0,
		limitCount: 100,
		lastSync: 0,
		...overrides,
	};
}

class FakeManager {
	readonly unhealthy: string[] = [];
	reconcileCalls = 0;

	constructor(readonly accounts: ManagedAccount[]) {}

	reconcileFromDb(): readonly ManagedAccount[] {
		this.reconcileCalls += 1;
		return this.accounts.map((candidate) => ({ ...candidate }));
	}

	toAuthDetails(selected: ManagedAccount): KiroAuthDetails {
		const current =
			this.accounts.find(({ id }) => id === selected.id) ?? selected;
		return {
			refresh: current.refreshToken,
			access: current.accessToken,
			expires: current.expiresAt,
			authMethod: current.authMethod,
			region: current.region,
		};
	}

	markUnhealthy(selected: ManagedAccount, reason: string): void {
		const current = this.accounts.find(({ id }) => id === selected.id);
		if (current) {
			current.isHealthy = false;
			current.unhealthyReason = reason;
			current.failCount = 10;
		}
		this.unhealthy.push(reason);
	}
}

class FakeRefresher {
	readonly calls: string[] = [];

	async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
		this.calls.push(selected.id);
		selected.accessToken = `${selected.id}-rotated`;
		selected.expiresAt = Date.now() + 3_600_000;
		return selected;
	}
}

class FakeUsageRefresher implements PipelineQuotaRechecker {
	readonly syncAccounts: string[][] = [];
	readonly recheckAccounts: string[][] = [];

	async recheckDueAccounts(accounts: readonly ManagedAccount[]): Promise<void> {
		this.recheckAccounts.push(accounts.map(({ id }) => id));
	}

	async syncDueAccounts(accounts: readonly ManagedAccount[]): Promise<void> {
		this.syncAccounts.push(accounts.map(({ id }) => id));
	}
}

function service(
	manager: FakeManager,
	refresher: FakeRefresher,
	usageRefresher: FakeUsageRefresher,
	overrides: Partial<ConstructorParameters<typeof AccountMaintenanceService>[0]> = {},
): AccountMaintenanceService {
	return new AccountMaintenanceService({
		enabled: true,
		intervalMs: 60_000,
		timeoutMs: 1_000,
		concurrency: 2,
		tokenExpiryBufferMs: 300_000,
		accountManager: manager,
		tokenRefresher: refresher,
		usageRefresher,
		initialDelayMs: 60_000,
		...overrides,
	});
}

function deferred(): {
	readonly promise: Promise<ManagedAccount>;
	readonly resolve: (value: ManagedAccount) => void;
} {
	let resolvePromise: ((value: ManagedAccount) => void) | undefined;
	const promise = new Promise<ManagedAccount>((resolve) => {
		resolvePromise = resolve;
	});
	if (!resolvePromise) throw new TypeError("Deferred resolver was not initialized");
	return { promise, resolve: resolvePromise };
}

describe("AccountMaintenanceService", () => {
	test("refreshes near-expiry local credentials before synchronizing usage", async () => {
		const stored = account();
		const manager = new FakeManager([stored]);
		const refresher = new FakeRefresher();
		const usage = new FakeUsageRefresher();

		await service(manager, refresher, usage).runOnce();

		expect(refresher.calls).toEqual(["account-a"]);
		expect(manager.reconcileCalls).toBe(3);
		expect(usage.recheckAccounts).toEqual([["account-a"]]);
		expect(usage.syncAccounts).toEqual([["account-a"]]);
	});

	test("skips permanently invalid credentials while still running the usage pass", async () => {
		const dead = account("dead", {
			isHealthy: false,
			unhealthyReason: "InvalidTokenException: re-login required",
		});
		const manager = new FakeManager([dead]);
		const refresher = new FakeRefresher();
		const usage = new FakeUsageRefresher();

		await service(manager, refresher, usage).runOnce();

		expect(refresher.calls).toEqual([]);
		expect(usage.recheckAccounts).toEqual([["dead"]]);
		expect(usage.syncAccounts).toEqual([["dead"]]);
	});

	test("leaves exhausted token refresh to the due quota probe", async () => {
		const exhausted = account("exhausted", {
			expiresAt: 0,
			usedCount: 100,
			limitCount: 100,
			rateLimitResetTime: 0,
		});
		const manager = new FakeManager([exhausted]);
		const refresher = new FakeRefresher();
		const usage = new FakeUsageRefresher();

		await service(manager, refresher, usage).runOnce();

		expect(refresher.calls).toEqual([]);
		expect(usage.recheckAccounts).toEqual([["exhausted"]]);
		expect(usage.syncAccounts).toEqual([["exhausted"]]);
	});

	test("joins concurrent maintenance requests into one pass", async () => {
		const stored = account();
		const manager = new FakeManager([stored]);
		const pending = deferred();
		const refresher = new FakeRefresher();
		refresher.refreshIfNeeded = async (selected) => {
			refresher.calls.push(selected.id);
			return pending.promise;
		};
		const usage = new FakeUsageRefresher();
		const maintenance = service(manager, refresher, usage);

		const first = maintenance.runOnce();
		const second = maintenance.runOnce();
		expect(first).toBe(second);
		await Promise.resolve();
		expect(refresher.calls).toEqual(["account-a"]);
		pending.resolve(stored);
		await Promise.all([first, second]);

		expect(usage.recheckAccounts).toHaveLength(1);
		expect(usage.syncAccounts).toHaveLength(1);
	});

	test("persists a dead refresh credential as permanently unhealthy", async () => {
		const stored = account();
		const manager = new FakeManager([stored]);
		const refresher = new FakeRefresher();
		refresher.refreshIfNeeded = async () => {
			throw Object.assign(new Error("Invalid grant provided"), {
				code: "invalid_grant",
			});
		};
		const usage = new FakeUsageRefresher();

		await service(manager, refresher, usage).runOnce();

		expect(manager.unhealthy).toHaveLength(1);
		expect(stored).toMatchObject({
			isHealthy: false,
			failCount: 10,
		});
	});

	test("does nothing when autonomous maintenance is disabled", async () => {
		const manager = new FakeManager([account()]);
		const refresher = new FakeRefresher();
		const usage = new FakeUsageRefresher();

		await service(manager, refresher, usage, { enabled: false }).runOnce();

		expect(manager.reconcileCalls).toBe(0);
		expect(refresher.calls).toEqual([]);
		expect(usage.recheckAccounts).toEqual([]);
		expect(usage.syncAccounts).toEqual([]);
	});

	test("binds maintenance start and stop to the server lifecycle", () => {
		let starts = 0;
		let stops = 0;
		let serverStops = 0;
		const server: { stop(closeActiveConnections?: boolean): void } = {
			stop(_closeActiveConnections?: boolean): void {
				serverStops += 1;
			},
		};

		const bound = bindAccountMaintenanceLifecycle(server, {
			start(): void {
				starts += 1;
			},
			stop(): void {
				stops += 1;
			},
			async runOnce(): Promise<void> {},
		});
		bound.stop(true);

		expect(starts).toBe(1);
		expect(stops).toBe(1);
		expect(serverStops).toBe(1);
	});
});
