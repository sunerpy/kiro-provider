import { describe, expect, spyOn, test } from "bun:test";
import { QuotaRechecker } from "../src/core/quota-rechecker.js";
import { isQuotaExhausted } from "../src/kiro/health.js";
import type {
	KiroAuthDetails,
	KiroUsageSnapshot,
	ManagedAccount,
} from "../src/kiro/types.js";

const NOW = 1_000_000;
const INTERVAL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		id: "account-a",
		email: "account-a@example.com",
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: "refresh",
		accessToken: "access",
		expiresAt: NOW + 60_000,
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

/** Mirrors AccountManager.updateQuotaUsage's rateLimitResetTime rule. */
class FakeManager {
	constructor(readonly accounts: ManagedAccount[]) {}

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

	markUnhealthy(): ManagedAccount | undefined {
		throw new Error("markUnhealthy should not be called in these tests");
	}

	scheduleQuotaRecheck(): ManagedAccount | undefined {
		throw new Error("scheduleQuotaRecheck should not be called in these tests");
	}

	updateQuotaUsage(
		selected: ManagedAccount,
		usage: KiroUsageSnapshot & { readonly lastSync: number },
		nextRecheckAt: number,
	): ManagedAccount | undefined {
		const current = this.accounts.find(({ id }) => id === selected.id);
		if (!current) return undefined;
		const wasExhausted = isQuotaExhausted(current);
		const snapshotExhausted = isQuotaExhausted(usage);
		current.usedCount = usage.usedCount;
		current.limitCount = usage.limitCount;
		current.overageCount = usage.overageCount;
		current.lastSync = usage.lastSync;
		current.rateLimitResetTime = snapshotExhausted
			? Math.max(current.rateLimitResetTime, nextRecheckAt)
			: wasExhausted
				? 0
				: current.rateLimitResetTime;
		return current;
	}
}

const refresher = {
	async refreshIfNeeded(selected: ManagedAccount): Promise<ManagedAccount> {
		return selected;
	},
	async forceRefresh(selected: ManagedAccount): Promise<ManagedAccount> {
		return selected;
	},
};

function exhaustedSnapshot(resetAt?: number): KiroUsageSnapshot {
	return {
		usedCount: 100,
		limitCount: 100,
		overageCount: 0,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function rechecker(
	manager: FakeManager,
	snapshot: KiroUsageSnapshot,
	intervalMs = INTERVAL_MS,
): QuotaRechecker {
	return new QuotaRechecker({
		accountManager: manager,
		tokenRefresher: refresher,
		intervalMs,
		usageRefreshIntervalMs: INTERVAL_MS,
		timeoutMs: 1_000,
		concurrency: 1,
		now: () => NOW,
		fetchUsage: async () => snapshot,
	});
}

async function captureAudit(
	run: () => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
	const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await run();
		return errorSpy.mock.calls.map(
			([line]) => JSON.parse(String(line)) as Record<string, unknown>,
		);
	} finally {
		errorSpy.mockRestore();
	}
}

async function recheck(
	target: ManagedAccount,
	snapshot: KiroUsageSnapshot,
	intervalMs = INTERVAL_MS,
): Promise<Array<Record<string, unknown>>> {
	const service = rechecker(new FakeManager([target]), snapshot, intervalMs);
	return captureAudit(() =>
		service.recheckDueAccounts([target], new AbortController().signal),
	);
}

describe("QuotaRechecker upstream reset scheduling", () => {
	test("waits for the upstream reset when it is later than the fixed interval", async () => {
		const exhausted = account();
		const resetAt = NOW + 5 * HOUR_MS;

		const lines = await recheck(exhausted, exhaustedSnapshot(resetAt));

		expect(exhausted.rateLimitResetTime).toBe(resetAt);
		expect(isQuotaExhausted(exhausted)).toBe(true);
		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "quota_recheck_still_exhausted",
				next_recheck_at: resetAt,
				reset_at: resetAt,
			}),
		);
	});

	test("caps the wait at one day so a distant or wrong reset cannot park the account", async () => {
		const exhausted = account();

		await recheck(exhausted, exhaustedSnapshot(NOW + 20 * DAY_MS));

		expect(exhausted.rateLimitResetTime).toBe(NOW + DAY_MS);
	});

	test("caps at the configured interval when it is longer than a day", async () => {
		const exhausted = account();
		const twoDays = 2 * DAY_MS;

		await recheck(exhausted, exhaustedSnapshot(NOW + 20 * DAY_MS), twoDays);

		expect(exhausted.rateLimitResetTime).toBe(NOW + twoDays);
	});

	test("never schedules sooner than the fixed interval", async () => {
		const soon = account({ id: "soon", email: "soon@example.com" });
		const past = account({ id: "past", email: "past@example.com" });

		await recheck(soon, exhaustedSnapshot(NOW + INTERVAL_MS / 2));
		await recheck(past, exhaustedSnapshot(NOW - 1_000));

		expect(soon.rateLimitResetTime).toBe(NOW + INTERVAL_MS);
		expect(past.rateLimitResetTime).toBe(NOW + INTERVAL_MS);
	});

	test("keeps the fixed interval when the snapshot carries no reset time", async () => {
		const exhausted = account();

		const lines = await recheck(exhausted, exhaustedSnapshot());

		expect(exhausted.rateLimitResetTime).toBe(NOW + INTERVAL_MS);
		const event = lines.find(
			(line) => line.event === "quota_recheck_still_exhausted",
		);
		expect(event).toMatchObject({ next_recheck_at: NOW + INTERVAL_MS });
		expect(event).not.toHaveProperty("reset_at");
	});

	test("keeps the fixed interval when an injected snapshot carries a non-finite reset", async () => {
		const exhausted = account();

		await recheck(exhausted, exhaustedSnapshot(Number.NaN));

		expect(exhausted.rateLimitResetTime).toBe(NOW + INTERVAL_MS);
	});

	test("applies the reset schedule when a usage refresh first detects exhaustion", async () => {
		const healthy = account({ usedCount: 10, rateLimitResetTime: 0 });
		const resetAt = NOW + 5 * HOUR_MS;
		const service = rechecker(
			new FakeManager([healthy]),
			exhaustedSnapshot(resetAt),
		);

		const lines = await captureAudit(() =>
			service.syncDueAccounts([healthy], new AbortController().signal),
		);

		expect(healthy.rateLimitResetTime).toBe(resetAt);
		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "usage_refresh_detected_exhaustion",
				next_recheck_at: resetAt,
				reset_at: resetAt,
			}),
		);
	});
});
