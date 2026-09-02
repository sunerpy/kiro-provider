import { describe, expect, test } from "bun:test";
import {
	AccountSelector,
	countSelectable,
	isSelectableAccount,
	selectableCandidates,
} from "../src/core/account-selection.js";
import type { AccountSelectionStrategy, ManagedAccount } from "../src/kiro/types.js";

const NOW = 1_700_000_000_000;

function account(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		id,
		email: `${id.toLowerCase()}@example.invalid`,
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: NOW + 3_600_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
		usedCount: 0,
		limitCount: 100,
		overageCount: 0,
		lastUsed: 0,
		...overrides,
	};
}

describe("isSelectableAccount", () => {
	test("admits healthy accounts and refuses dead, exhausted, or cooling-down ones", () => {
		expect(isSelectableAccount(account("A"), NOW)).toBe(true);
		expect(isSelectableAccount(account("A", { rateLimitResetTime: NOW }), NOW)).toBe(true);
		expect(isSelectableAccount(account("A", { rateLimitResetTime: NOW + 1 }), NOW)).toBe(false);
		expect(isSelectableAccount(account("A", { usedCount: 100, limitCount: 100 }), NOW)).toBe(false);
		expect(isSelectableAccount(account("A", { overageCount: 1 }), NOW)).toBe(false);
		expect(
			isSelectableAccount(
				account("A", { isHealthy: true, unhealthyReason: "InvalidGrantException: dead" }),
				NOW,
			),
		).toBe(false);
	});

	test("lets an unhealthy account back in only for access-token errors or an elapsed recovery time", () => {
		const unhealthy = { isHealthy: false, failCount: 10 };
		expect(isSelectableAccount(account("A", unhealthy), NOW)).toBe(false);
		expect(
			isSelectableAccount(
				account("A", {
					...unhealthy,
					unhealthyReason: "The bearer token included in the request is invalid",
				}),
				NOW,
			),
		).toBe(true);
		expect(
			isSelectableAccount(
				account("A", { ...unhealthy, unhealthyReason: "temporary", recoveryTime: NOW }),
				NOW,
			),
		).toBe(true);
		expect(
			isSelectableAccount(
				account("A", { ...unhealthy, unhealthyReason: "temporary", recoveryTime: NOW + 1 }),
				NOW,
			),
		).toBe(false);
	});
});

describe("selectableCandidates and countSelectable", () => {
	const accounts = [
		account("C"),
		account("A"),
		account("B", { rateLimitResetTime: NOW + 60_000 }),
		account("D", { usedCount: 100, limitCount: 100 }),
	];

	test("filter to selectable accounts in id order and honor the eligible set", () => {
		expect(selectableCandidates(accounts, NOW).map(({ id }) => id)).toEqual(["A", "C"]);
		expect(
			selectableCandidates(accounts, NOW, new Set(["C", "D"])).map(({ id }) => id),
		).toEqual(["C"]);
		expect(selectableCandidates(accounts, NOW, new Set())).toEqual([]);
	});

	test("count agrees with the candidate list", () => {
		expect(countSelectable(accounts, NOW)).toBe(2);
		expect(countSelectable(accounts, NOW, new Set(["A", "B"]))).toBe(1);
		expect(countSelectable(accounts, NOW, new Set(["B", "D"]))).toBe(0);
		expect(countSelectable(accounts, NOW + 60_000)).toBe(3);
	});
});

describe("AccountSelector", () => {
	const candidates = [account("A"), account("B"), account("C")];

	test("sticky keeps returning the first pick until it disappears or is forgotten", () => {
		const selector = new AccountSelector("sticky");
		expect(selector.pick(candidates).id).toBe("A");
		expect(selector.pick([candidates[2] as ManagedAccount, candidates[0] as ManagedAccount]).id).toBe("A");
		selector.retainSticky(candidates);
		expect(selector.pick(candidates).id).toBe("A");
		selector.retainSticky(candidates.slice(1));
		expect(selector.pick(candidates).id).toBe("A");
		selector.forget("A");
		expect(selector.pick(candidates.slice(1)).id).toBe("B");
	});

	test("a preferred hit is returned without moving the sticky pointer or the cursor", () => {
		const sticky = new AccountSelector("sticky");
		expect(sticky.pick(candidates, "B").id).toBe("B");
		expect(sticky.pick(candidates).id).toBe("A");
		expect(sticky.pick(candidates, "C").id).toBe("C");
		expect(sticky.pick(candidates).id).toBe("A");

		const roundRobin = new AccountSelector("round-robin");
		expect(roundRobin.pick(candidates).id).toBe("A");
		expect(roundRobin.pick(candidates, "C").id).toBe("C");
		expect(roundRobin.pick(candidates).id).toBe("B");
		expect(roundRobin.pick(candidates, "missing").id).toBe("C");
		expect(roundRobin.pick(candidates).id).toBe("A");
	});

	test("lowest-usage breaks ties on last use and then on id", () => {
		const selector = new AccountSelector("lowest-usage");
		expect(
			selector.pick([
				account("B", { usedCount: 1, lastUsed: 5 }),
				account("A", { usedCount: 1, lastUsed: 9 }),
				account("C", { usedCount: 0, lastUsed: 99 }),
			]).id,
		).toBe("C");
		expect(
			selector.pick([
				account("B", { usedCount: 1, lastUsed: 5 }),
				account("A", { usedCount: 1, lastUsed: 9 }),
			]).id,
		).toBe("B");
		expect(
			selector.pick([account("B", { usedCount: 1 }), account("A", { usedCount: 1 })]).id,
		).toBe("A");
	});

	test("rejects an empty candidate list and an unknown strategy", () => {
		for (const strategy of ["sticky", "round-robin", "lowest-usage"] as const) {
			expect(() => new AccountSelector(strategy).pick([])).toThrow(RangeError);
		}
		const unknown = new AccountSelector("weighted" as unknown as AccountSelectionStrategy);
		expect(() => unknown.pick(candidates)).toThrow(TypeError);
	});
});
