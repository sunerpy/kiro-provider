import { describe, expect, test } from "bun:test";
import type {
	PipelineAccountManager,
	PipelineModelCapabilities,
	PipelineReasoningReplayStore,
} from "../src/core/pipeline.js";
import { handleReadiness } from "../src/server/routes/readiness.js";

function accountManager(
	count: number,
	throwOnReconcile = false,
): PipelineAccountManager {
	return {
		reconcileFromDb(): never[] {
			if (throwOnReconcile) throw new TypeError("database unavailable");
			return [];
		},
		getAccountCount(): number {
			return count;
		},
	} as unknown as PipelineAccountManager;
}

function replayStore(
	writable: boolean,
	keyringAvailable: boolean,
	missingKeyIds: readonly string[] = [],
): PipelineReasoningReplayStore {
	return {
		readiness: () => ({ writable, keyringAvailable, missingKeyIds }),
	} as unknown as PipelineReasoningReplayStore;
}

async function body(response: Response): Promise<unknown> {
	return response.json();
}

describe("readiness route", () => {
	test("reports every fail-closed dependency state", async () => {
		const noAccounts = handleReadiness(accountManager(0));
		expect(noAccounts.status).toBe(503);
		expect(await body(noAccounts)).toEqual({
			status: "not_ready",
			reason: "no_active_accounts",
		});

		const notWritable = handleReadiness(
			accountManager(1),
			replayStore(false, true),
		);
		expect(notWritable.status).toBe(503);
		expect(await body(notWritable)).toEqual({
			status: "not_ready",
			reason: "reasoning_replay_database_not_writable",
		});

		const noKeyring = handleReadiness(
			accountManager(1),
			replayStore(true, false),
		);
		expect(noKeyring.status).toBe(503);
		expect(await body(noKeyring)).toEqual({
			status: "not_ready",
			reason: "reasoning_replay_keyring_unavailable",
		});

		const missingKey = handleReadiness(
			accountManager(1),
			replayStore(true, true, ["rk_missing"]),
		);
		expect(missingKey.status).toBe(503);
		expect(await body(missingKey)).toEqual({
			status: "not_ready",
			reason: "reasoning_replay_key_coverage_incomplete",
			missing_key_ids: ["rk_missing"],
		});

		const unavailable = handleReadiness(accountManager(1, true));
		expect(unavailable.status).toBe(503);
		expect(await body(unavailable)).toEqual({
			status: "not_ready",
			reason: "authentication_store_unavailable",
		});
	});

	test("labels replay-store and model-catalog failures distinctly from the auth store", async () => {
		const replayFailure = handleReadiness(accountManager(1), {
			readiness: () => {
				throw new TypeError("replay database locked");
			},
		} as unknown as PipelineReasoningReplayStore);
		expect(replayFailure.status).toBe(503);
		expect(await body(replayFailure)).toEqual({
			status: "not_ready",
			reason: "reasoning_replay_store_unavailable",
		});

		const catalogFailure = handleReadiness(accountManager(1), replayStore(true, true), {
			readiness: () => {
				throw new TypeError("catalog snapshot corrupt");
			},
		} as unknown as PipelineModelCapabilities);
		expect(catalogFailure.status).toBe(503);
		expect(await body(catalogFailure)).toEqual({
			status: "not_ready",
			reason: "model_catalog_unavailable",
		});
	});

	test("returns ready only when accounts, database, and keyring are usable", async () => {
		const withoutReplay = handleReadiness(accountManager(1));
		expect(withoutReplay.status).toBe(200);
		expect(await body(withoutReplay)).toEqual({ status: "ready" });

		const withReplay = handleReadiness(
			accountManager(1),
			replayStore(true, true),
		);
		expect(withReplay.status).toBe(200);
		expect(await body(withReplay)).toEqual({ status: "ready" });
	});
});
