import { z } from "zod";
import {
	CANONICAL_COVERAGE_EXCLUDE,
	matchesCoveragePattern,
} from "./coverage-gate.js";

const CodecovConfigSchema = z.object({
	ignore: z.array(z.string()),
});

export type CoverageParityResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly onlyCanonical: readonly string[];
			readonly onlyCodecov: readonly string[];
	  };

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function codecovGlobToRegExp(pattern: string): RegExp {
	let expression = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				if (pattern[index + 1] === "/") {
					index += 1;
					expression += "(?:.*/)?";
				} else {
					expression += ".*";
				}
			} else {
				expression += "[^/]*";
			}
		} else if (character === "?") {
			expression += "[^/]";
		} else {
			expression += character?.replace(/[\\^$.[\]{}()+|]/g, "\\$&") ?? "";
		}
	}
	return new RegExp(`${expression}$`);
}

export function matchesCodecovPattern(path: string, pattern: string): boolean {
	return codecovGlobToRegExp(normalizePath(pattern)).test(normalizePath(path));
}

export function compareCoverageExclusions(
	files: readonly string[],
	canonicalPatterns: readonly string[],
	codecovPatterns: readonly string[],
): CoverageParityResult {
	const onlyCanonical: string[] = [];
	const onlyCodecov: string[] = [];
	for (const file of [...new Set(files.map(normalizePath))].sort()) {
		const canonicalIgnored = matchesCoveragePattern(file, canonicalPatterns);
		const codecovIgnored = codecovPatterns.some((pattern) =>
			matchesCodecovPattern(file, pattern),
		);
		if (canonicalIgnored && !codecovIgnored) onlyCanonical.push(file);
		if (codecovIgnored && !canonicalIgnored) onlyCodecov.push(file);
	}

	return onlyCanonical.length === 0 && onlyCodecov.length === 0
		? { ok: true }
		: { ok: false, onlyCanonical, onlyCodecov };
}

async function listCoverageTreeFiles(): Promise<readonly string[]> {
	const roots = ["src/**/*.ts", "scripts/**/*.ts", "__tests__/**/*.ts"];
	const files = await Promise.all(
		roots.map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan("."))),
	);
	return [...new Set(files.flat().map(normalizePath))].sort();
}

async function runCoverageParity(): Promise<number> {
	const parsedYaml = Bun.YAML.parse(await Bun.file("codecov.yml").text());
	const codecovExclude = CodecovConfigSchema.parse(parsedYaml).ignore;
	const result = compareCoverageExclusions(
		await listCoverageTreeFiles(),
		CANONICAL_COVERAGE_EXCLUDE,
		codecovExclude,
	);

	if (result.ok) {
		console.log(
			"coverage-parity: PASS (canonical and Codecov effective ignore sets match)",
		);
		return 0;
	}

	console.error("coverage-parity: FAIL — effective ignore sets differ");
	for (const file of result.onlyCanonical) {
		console.error(`  ignored only by canonical gate: ${file}`);
	}
	for (const file of result.onlyCodecov) {
		console.error(`  ignored only by Codecov: ${file}`);
	}
	return 1;
}

if (import.meta.main) process.exitCode = await runCoverageParity();
