const ALLOWED_TYPES = new Set([
  "feat",
  "fix",
  "docs",
  "chore",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "style",
  "revert",
]);

const CONVENTIONAL_TITLE =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9]+(?:-[a-z0-9]+)*)\))?(?<breaking>!)?: (?<subject>\S(?:.*\S)?)$/;
const RELEASE_TITLE = /^chore: release (?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export type PullRequestTitleValidation =
  | { readonly ok: true; readonly releaseVersion?: string }
  | { readonly ok: false; readonly errors: readonly string[] };

export function validatePullRequestTitle(title: string): PullRequestTitleValidation {
  const errors: string[] = [];
  if (title !== title.trim()) errors.push("title must not have leading or trailing whitespace");
  if (/[。.!?]$/.test(title)) errors.push("title must not end with punctuation");

  const releaseMatch = RELEASE_TITLE.exec(title);
  if (releaseMatch?.groups?.version) {
    return errors.length === 0
      ? { ok: true, releaseVersion: releaseMatch.groups.version }
      : { ok: false, errors };
  }

  const match = CONVENTIONAL_TITLE.exec(title);
  if (!match?.groups) {
    errors.push("title must use Conventional Commits: type(scope): subject");
    return { ok: false, errors };
  }

  const type = match.groups.type ?? "";
  if (!ALLOWED_TYPES.has(type)) {
    errors.push(`unsupported type '${type}'`);
  }
  if (!match.groups.scope) {
    errors.push("normal project PR titles require a lowercase scope");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function main(): Promise<number> {
  const title = process.env.PR_TITLE;
  if (!title) {
    console.error("check-pr-title: PR_TITLE is required");
    return 2;
  }

  const result = validatePullRequestTitle(title);
  if (!result.ok) {
    console.error("check-pr-title: FAIL");
    for (const error of result.errors) console.error(`  ${error}`);
    return 1;
  }

  console.log(
    result.releaseVersion
      ? `check-pr-title: PASS (release ${result.releaseVersion})`
      : "check-pr-title: PASS",
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
