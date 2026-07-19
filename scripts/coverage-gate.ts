import { posix } from "node:path";

export const COVERAGE_MIN = 93;

export const CANONICAL_COVERAGE_EXCLUDE = [
	"__tests__/**",
	"**/*.test.ts",
	"scripts/**",
	"src/index.ts",
	"src/cli/bin.ts",
	"src/core/pipeline-types.ts",
	"src/kiro/types.ts",
] as const;

type CoverageFile = {
	readonly path: string;
	readonly linesFound: number;
	readonly linesHit: number;
	readonly percentage: number;
};

type CoverageTotal = {
	readonly linesFound: number;
	readonly linesHit: number;
	readonly percentage: number;
};

export type CoverageEvaluation =
	| {
			readonly ok: true;
			readonly files: readonly CoverageFile[];
			readonly total: CoverageTotal;
	  }
	| {
			readonly ok: false;
			readonly reason: "below-threshold";
			readonly files: readonly CoverageFile[];
			readonly total: CoverageTotal;
			readonly minimum: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "missing-files";
			readonly missingFiles: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly reason: "invalid-lcov";
			readonly errors: readonly string[];
	  };

type LcovRecord = {
	readonly source: string;
	readonly linesFound: number;
	readonly linesHit: number;
};

function normalizePath(path: string): string {
	const slashPath = path.replaceAll("\\", "/");
	return slashPath.length === 0
		? ""
		: posix.normalize(slashPath).replace(/^\.\//, "");
}

function canonicalCoveragePath(path: string): string {
	const normalizedPath = normalizePath(path);
	if (normalizedPath.startsWith("src/")) return normalizedPath;

	const repositoryRoot = normalizePath(process.cwd()).replace(/\/$/, "");
	if (normalizedPath.startsWith(`${repositoryRoot}/`)) {
		return normalizedPath.slice(repositoryRoot.length + 1);
	}

	const sourceRootIndex = normalizedPath.lastIndexOf("/src/");
	return sourceRootIndex === -1
		? normalizedPath
		: normalizedPath.slice(sourceRootIndex + 1);
}

function percentage(linesHit: number, linesFound: number): number {
	return linesFound === 0 ? 100 : (linesHit / linesFound) * 100;
}

type LcovParseResult =
	| { readonly ok: true; readonly records: readonly LcovRecord[] }
	| { readonly ok: false; readonly errors: readonly string[] };

function parseCount(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const count = Number(value);
	return Number.isSafeInteger(count) ? count : undefined;
}

function parseLcov(lcovText: string): LcovParseResult {
	const records: LcovRecord[] = [];
	const errors: string[] = [];
	const seenSources = new Set<string>();
	let source: string | undefined;
	let linesFound: number | undefined;
	let linesHit: number | undefined;

	for (const [index, line] of lcovText.split(/\r?\n/).entries()) {
		const lineNumber = index + 1;
		if (line.startsWith("SF:")) {
			if (source !== undefined) {
				errors.push(`line ${lineNumber}: SF before end_of_record`);
			}
			const nextSource = canonicalCoveragePath(line.slice(3));
			if (nextSource.length === 0) {
				errors.push(`line ${lineNumber}: empty SF`);
			}
			source = nextSource;
			linesFound = undefined;
			linesHit = undefined;
		} else if (line.startsWith("LF:")) {
			if (source === undefined) {
				errors.push(`line ${lineNumber}: LF outside record`);
			} else if (linesFound !== undefined) {
				errors.push(`line ${lineNumber}: duplicate LF`);
			}
			linesFound = parseCount(line.slice(3));
			if (linesFound === undefined) {
				errors.push(`line ${lineNumber}: LF must be a non-negative integer`);
			}
		} else if (line.startsWith("LH:")) {
			if (source === undefined) {
				errors.push(`line ${lineNumber}: LH outside record`);
			} else if (linesHit !== undefined) {
				errors.push(`line ${lineNumber}: duplicate LH`);
			}
			linesHit = parseCount(line.slice(3));
			if (linesHit === undefined) {
				errors.push(`line ${lineNumber}: LH must be a non-negative integer`);
			}
		} else if (line === "end_of_record") {
			if (
				source === undefined ||
				linesFound === undefined ||
				linesHit === undefined
			) {
				errors.push(`line ${lineNumber}: incomplete LCOV record`);
			} else {
				if (linesHit > linesFound) {
					errors.push(`line ${lineNumber}: LH exceeds LF for ${source}`);
				}
				if (seenSources.has(source)) {
					errors.push(`line ${lineNumber}: duplicate SF ${source}`);
				} else {
					seenSources.add(source);
					records.push({ source, linesFound, linesHit });
				}
			}
			source = undefined;
			linesFound = undefined;
			linesHit = undefined;
		}
	}

	if (source !== undefined) errors.push("end of file: unterminated LCOV record");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, records };
}

export function matchesCoveragePattern(
	path: string,
	patterns: readonly string[],
): boolean {
	const normalizedPath = normalizePath(path);
	return patterns.some((pattern) => new Bun.Glob(pattern).match(normalizedPath));
}

export function evaluateCoverage(
	lcovText: string,
	inScopeFiles: readonly string[],
): CoverageEvaluation {
	const parsed = parseLcov(lcovText);
	if (!parsed.ok) {
		return { ok: false, reason: "invalid-lcov", errors: parsed.errors };
	}
	const recordsByFile = new Map(
		parsed.records.map((record) => [record.source, record] as const),
	);
	const files = [...new Set(inScopeFiles.map(canonicalCoveragePath))].sort();
	const missingFiles = files.filter((file) => !recordsByFile.has(file));

	if (missingFiles.length > 0) {
		return { ok: false, reason: "missing-files", missingFiles };
	}

	const coverageFiles: CoverageFile[] = [];
	for (const file of files) {
		const record = recordsByFile.get(file);
		if (record === undefined) continue;
		coverageFiles.push({
			path: file,
			linesFound: record.linesFound,
			linesHit: record.linesHit,
			percentage: percentage(record.linesHit, record.linesFound),
		});
	}

	const total = coverageFiles.reduce<CoverageTotal>(
		(accumulator, file) => {
			const linesFound = accumulator.linesFound + file.linesFound;
			const linesHit = accumulator.linesHit + file.linesHit;
			return {
				linesFound,
				linesHit,
				percentage: percentage(linesHit, linesFound),
			};
		},
		{ linesFound: 0, linesHit: 0, percentage: 100 },
	);

	if (total.percentage < COVERAGE_MIN) {
		return {
			ok: false,
			reason: "below-threshold",
			files: coverageFiles,
			total,
			minimum: COVERAGE_MIN,
		};
	}

	return { ok: true, files: coverageFiles, total };
}

async function listInScopeFiles(): Promise<readonly string[]> {
	return (await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan(".")))
		.map(normalizePath)
		.filter(
			(file) => !matchesCoveragePattern(file, CANONICAL_COVERAGE_EXCLUDE),
		)
		.sort();
}

function formatTotal(total: CoverageTotal): string {
	return `${total.linesHit}/${total.linesFound} lines (${total.percentage.toFixed(2)}%)`;
}

async function runCoverageGate(): Promise<number> {
	const lcovText = await Bun.file("coverage/lcov.info").text();
	const result = evaluateCoverage(lcovText, await listInScopeFiles());

	if (!result.ok && result.reason === "invalid-lcov") {
		console.error("coverage-gate: FAIL — malformed LCOV:");
		for (const error of result.errors) console.error(`  ${error}`);
		return 1;
	}

	if (!result.ok && result.reason === "missing-files") {
		console.error("coverage-gate: FAIL — LCOV is missing in-scope files:");
		for (const file of result.missingFiles) console.error(`  ${file}`);
		return 1;
	}

	if (!result.ok) {
		for (const file of result.files) {
			console.error(
				`${file.path}: ${file.linesHit}/${file.linesFound} (${file.percentage.toFixed(2)}%)`,
			);
		}
		console.error(`Coverage total: ${formatTotal(result.total)}`);
		console.error(
			`coverage-gate: FAIL (${result.total.percentage.toFixed(2)}% < ${COVERAGE_MIN.toFixed(2)}%)`,
		);
		return 1;
	}

	console.log(`Coverage total: ${formatTotal(result.total)}`);
	console.log(
		`coverage-gate: PASS (${result.total.percentage.toFixed(2)}% >= ${COVERAGE_MIN.toFixed(2)}%)`,
	);
	return 0;
}

if (import.meta.main) process.exitCode = await runCoverageGate();
