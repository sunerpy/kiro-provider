import { describe, expect, test } from "bun:test";
import {
	compareCoverageExclusions,
	matchesCodecovPattern,
} from "./coverage-parity.js";

describe("compareCoverageExclusions", () => {
	test("accepts different patterns that ignore the same effective files", () => {
		const result = compareCoverageExclusions(
			["src/root.test.ts", "src/nested/child.test.ts", "src/main.ts"],
			["**/*.test.ts"],
			["src/**/*.test.ts"],
		);

		expect(result).toEqual({ ok: true });
	});

	test("reports files ignored by only one coverage system", () => {
		const result = compareCoverageExclusions(
			["scripts/nested/tool.ts", "src/main.test.ts", "src/main.ts"],
			["**/*.test.ts"],
			["scripts/**"],
		);

		expect(result).toEqual({
			ok: false,
			onlyCanonical: ["src/main.test.ts"],
			onlyCodecov: ["scripts/nested/tool.ts"],
		});
	});
});

describe("matchesCodecovPattern", () => {
	test("supports recursive and zero-directory globstar matches", () => {
		expect(matchesCodecovPattern("src/root.test.ts", "src/**/*.test.ts")).toBe(
			true,
		);
		expect(
			matchesCodecovPattern("src/nested/child.test.ts", "src/**/*.test.ts"),
		).toBe(true);
		expect(matchesCodecovPattern("src/main.ts", "src/**/*.test.ts")).toBe(
			false,
		);
	});
});
