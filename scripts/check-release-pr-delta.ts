import { spawnSync } from "bun";

export const RELEASE_FILES = [
  ".github/scaffold.json",
  ".release-please-manifest.json",
  "changelog/CHANGELOG-v3.x.md",
  "package.json",
] as const;

type ReleaseFile = (typeof RELEASE_FILES)[number];

type ReleaseSnapshot = Readonly<Record<ReleaseFile, string>>;

export type ReleaseDeltaInput = {
  readonly title: string;
  readonly changes: readonly { readonly status: string; readonly path: string }[];
  readonly base: ReleaseSnapshot;
  readonly head: ReleaseSnapshot;
};

export type ReleaseDeltaValidation =
  | { readonly ok: true; readonly oldVersion: string; readonly newVersion: string }
  | { readonly ok: false; readonly errors: readonly string[] };

const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>[0-9A-Za-z.-]+))?$/;
const RELEASE_TITLE = /^chore: release (?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function parseJson(
  text: string,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path} must contain a JSON object`);
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch (error) {
    errors.push(
      `${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getNestedString(
  object: Record<string, unknown> | undefined,
  path: readonly string[],
): string | undefined {
  let value: unknown = object;
  for (const segment of path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : undefined;
}

function setNestedString(
  object: Record<string, unknown>,
  path: readonly string[],
  value: string,
): void {
  let cursor = object;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`missing JSON object at ${path.join(".")}`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (!leaf) throw new Error("empty JSON path");
  cursor[leaf] = value;
}

function compareSemver(left: string, right: string): number | undefined {
  const a = SEMVER.exec(left)?.groups;
  const b = SEMVER.exec(right)?.groups;
  if (!a || !b) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = Number(a[key]) - Number(b[key]);
    if (difference !== 0) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre.localeCompare(b.pre);
}

function validateVersionOnlyJsonChange(
  path: ReleaseFile,
  baseText: string,
  headText: string,
  jsonPath: readonly string[],
  expectedOld: string | undefined,
  expectedNew: string,
  errors: string[],
): string | undefined {
  const base = parseJson(baseText, `base:${path}`, errors);
  const head = parseJson(headText, `head:${path}`, errors);
  if (!base || !head) return expectedOld;

  const oldVersion = getNestedString(base, jsonPath);
  const newVersion = getNestedString(head, jsonPath);
  if (!oldVersion) errors.push(`base:${path} is missing ${jsonPath.join(".")}`);
  if (newVersion !== expectedNew) {
    errors.push(
      `head:${path} ${jsonPath.join(".")} must equal ${expectedNew} (got ${newVersion ?? "missing"})`,
    );
  }
  if (expectedOld !== undefined && oldVersion !== expectedOld) {
    errors.push(`base:${path} version must equal ${expectedOld} (got ${oldVersion ?? "missing"})`);
  }

  if (oldVersion) {
    try {
      setNestedString(head, jsonPath, oldVersion);
      if (canonicalJson(base) !== canonicalJson(head)) {
        errors.push(`${path} may change only ${jsonPath.join(".")}`);
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return oldVersion ?? expectedOld;
}

function validateChangelog(
  base: string,
  head: string,
  oldVersion: string,
  newVersion: string,
  errors: string[],
): void {
  const header = "# Changelog\n";
  if (!base.startsWith(header) || !head.startsWith(header)) {
    errors.push("changelog must retain the canonical '# Changelog' header");
    return;
  }
  const baseHistory = base.slice(header.length);
  if (!head.endsWith(baseHistory)) {
    errors.push("release PR may only prepend one new changelog section; existing history changed");
    return;
  }

  const inserted = head.slice(header.length, head.length - baseHistory.length);
  const headings = inserted.match(/^## \[/gm) ?? [];
  if (headings.length !== 1)
    errors.push("release PR must prepend exactly one changelog version section");
  if (!inserted.includes(`## [${newVersion}](`)) {
    errors.push(`changelog is missing the ${newVersion} heading`);
  }
  if (!inserted.includes(`/compare/v${oldVersion}...v${newVersion})`)) {
    errors.push(`changelog compare link must be v${oldVersion}...v${newVersion}`);
  }
}

export function validateReleasePrDelta(input: ReleaseDeltaInput): ReleaseDeltaValidation {
  const errors: string[] = [];
  const titleVersion = RELEASE_TITLE.exec(input.title)?.groups?.version;
  if (!titleVersion) {
    return { ok: false, errors: ["release PR title must be 'chore: release X.Y.Z'"] };
  }

  const expectedFiles = [...RELEASE_FILES].sort();
  const actualFiles = input.changes.map((change) => change.path).sort();
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
    errors.push(`release PR changed files must be exactly: ${expectedFiles.join(", ")}`);
  }
  for (const change of input.changes) {
    if (change.status !== "M")
      errors.push(`${change.path} must be modified in place (got ${change.status})`);
  }

  const packageBase = parseJson(input.base["package.json"], "base:package.json", errors);
  const oldVersion = getNestedString(packageBase, ["version"]);
  if (!oldVersion || !SEMVER.test(oldVersion)) {
    errors.push(`base package version must be SemVer (got ${oldVersion ?? "missing"})`);
  }
  if (!SEMVER.test(titleVersion))
    errors.push(`release title version is not SemVer: ${titleVersion}`);
  const comparison = oldVersion ? compareSemver(titleVersion, oldVersion) : undefined;
  if (comparison === undefined || comparison <= 0) {
    errors.push(
      `release version ${titleVersion} must be greater than ${oldVersion ?? "the base version"}`,
    );
  }

  const packageOld = validateVersionOnlyJsonChange(
    "package.json",
    input.base["package.json"],
    input.head["package.json"],
    ["version"],
    oldVersion,
    titleVersion,
    errors,
  );
  validateVersionOnlyJsonChange(
    ".release-please-manifest.json",
    input.base[".release-please-manifest.json"],
    input.head[".release-please-manifest.json"],
    ["."],
    packageOld,
    titleVersion,
    errors,
  );
  validateVersionOnlyJsonChange(
    ".github/scaffold.json",
    input.base[".github/scaffold.json"],
    input.head[".github/scaffold.json"],
    ["placeholders", "CURRENT_VERSION"],
    packageOld,
    titleVersion,
    errors,
  );
  if (packageOld) {
    validateChangelog(
      input.base["changelog/CHANGELOG-v3.x.md"],
      input.head["changelog/CHANGELOG-v3.x.md"],
      packageOld,
      titleVersion,
      errors,
    );
  }

  return errors.length === 0
    ? { ok: true, oldVersion: packageOld ?? oldVersion ?? "", newVersion: titleVersion }
    : { ok: false, errors };
}

function runGit(arguments_: readonly string[]): string {
  const result = spawnSync(["git", ...arguments_], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    throw new Error(
      new TextDecoder().decode(result.stderr).trim() || `git ${arguments_.join(" ")} failed`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

function requireSha(name: string): string {
  const value = process.env[name] ?? "";
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full lowercase commit SHA`);
  return value;
}

function readSnapshot(sha: string): ReleaseSnapshot {
  return Object.fromEntries(
    RELEASE_FILES.map((path) => [path, runGit(["show", `${sha}:${path}`])]),
  ) as Record<ReleaseFile, string>;
}

async function main(): Promise<number> {
  try {
    const baseSha = requireSha("BASE_SHA");
    const headSha = requireSha("HEAD_SHA");
    const title = process.env.PR_TITLE ?? "";
    const changes = runGit(["diff", "--name-status", "--find-renames=0", `${baseSha}...${headSha}`])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status = "", path = ""] = line.split("\t");
        return { status, path };
      });
    const result = validateReleasePrDelta({
      title,
      changes,
      base: readSnapshot(baseSha),
      head: readSnapshot(headSha),
    });
    if (!result.ok) {
      console.error("check-release-pr-delta: FAIL");
      for (const error of result.errors) console.error(`  ${error}`);
      return 1;
    }
    console.log(`check-release-pr-delta: PASS (${result.oldVersion} -> ${result.newVersion})`);
    return 0;
  } catch (error) {
    console.error(
      `check-release-pr-delta: ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main();
