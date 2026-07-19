import { describe, expect, test } from "bun:test";
import {
	CANONICAL_COVERAGE_EXCLUDE,
	COVERAGE_MIN,
	evaluateCoverage,
	matchesCoveragePattern,
} from "./coverage-gate.js";

function lcovRecord(path: string, linesFound: number, linesHit: number): string {
	return `SF:${path}\nLF:${linesFound}\nLH:${linesHit}\nend_of_record`;
}

describe("evaluateCoverage", () => {
	test("passes when aggregate line coverage meets the minimum", () => {
		// Given
		const lcov = [
			lcovRecord("src/covered.ts", 100, 95),
			lcovRecord("src/boundary.ts", 100, 91),
		].join("\n");

		// When
		const result = evaluateCoverage(lcov, [
			"src/covered.ts",
			"src/boundary.ts",
		]);

		// Then
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.total.percentage).toBe(COVERAGE_MIN);
	});

	test("fails when aggregate line coverage is below the minimum", () => {
		// Given
		const lcov = [
			lcovRecord("src/covered.ts", 100, 94),
			lcovRecord("src/under-covered.ts", 100, 90),
		].join("\n");

		// When
		const result = evaluateCoverage(lcov, [
			"src/covered.ts",
			"src/under-covered.ts",
		]);

		// Then
		expect(result).toMatchObject({
			ok: false,
			reason: "below-threshold",
			total: { linesFound: 200, linesHit: 184, percentage: 92 },
		});
	});

	test("fails and names every in-scope file absent from LCOV", () => {
		// Given
		const lcov = lcovRecord("src/covered.ts", 100, 100);

		// When
		const result = evaluateCoverage(lcov, [
			"src/covered.ts",
			"src/missing-one.ts",
			"src/missing-two.ts",
		]);

		// Then
		expect(result).toEqual({
			ok: false,
			reason: "missing-files",
			missingFiles: ["src/missing-one.ts", "src/missing-two.ts"],
		});
	});

	test("rejects malformed line counts", () => {
		// Given
		const malformedReports = [
			"SF:src/malformed.ts\nLF:not-a-number\nLH:0\nend_of_record",
			`SF:src/malformed.ts\nLF:${"9".repeat(400)}\nLH:0\nend_of_record`,
		];

		// When
		const results = malformedReports.map((lcov) =>
			evaluateCoverage(lcov, ["src/malformed.ts"]),
		);

		// Then
		for (const result of results) {
			expect(result).toMatchObject({ ok: false, reason: "invalid-lcov" });
		}
	});

	test("rejects line hits greater than lines found", () => {
		// Given
		const lcov = lcovRecord("src/impossible.ts", 1, 2);

		// When
		const result = evaluateCoverage(lcov, ["src/impossible.ts"]);

		// Then
		expect(result).toMatchObject({ ok: false, reason: "invalid-lcov" });
	});

	test("rejects duplicate source-file records", () => {
		// Given
		const lcov = [
			lcovRecord("src/duplicate.ts", 1, 1),
			lcovRecord("src/duplicate.ts", 1, 1),
		].join("\n");

		// When
		const result = evaluateCoverage(lcov, ["src/duplicate.ts"]);

		// Then
		expect(result).toMatchObject({ ok: false, reason: "invalid-lcov" });
	});

	test("rejects duplicate source-file records written with path aliases", () => {
		// Given
		const lcov = [
			lcovRecord("/tmp/project/src/a.ts", 1, 1),
			lcovRecord("src/a.ts", 1, 0),
		].join("\n");

		// When
		const result = evaluateCoverage(lcov, ["src/a.ts"]);

		// Then
		expect(result).toMatchObject({ ok: false, reason: "invalid-lcov" });
	});

	test("keeps files with the same basename in distinct directories separate", () => {
		// Given
		const lcov = [
			lcovRecord("src/a.ts", 1, 1),
			lcovRecord("/tmp/project/src/sub/a.ts", 1, 1),
		].join("\n");

		// When
		const result = evaluateCoverage(lcov, ["src/a.ts", "src/sub/a.ts"]);

		// Then
		expect(result).toMatchObject({
			ok: true,
			files: [{ path: "src/a.ts" }, { path: "src/sub/a.ts" }],
			total: { linesFound: 2, linesHit: 2, percentage: 100 },
		});
	});
});

describe("canonical coverage scope", () => {
	test("explicitly excludes type-only modules instead of detecting source syntax", () => {
		// Given
		const typeOnlyModules = ["src/core/pipeline-types.ts", "src/kiro/types.ts"];

		// When
		const excluded = typeOnlyModules.map((path) =>
			matchesCoveragePattern(path, CANONICAL_COVERAGE_EXCLUDE),
		);

		// Then
		expect(excluded).toEqual([true, true]);
	});
});
