/**
 * Pure release-metadata helpers shared by the version check and the updater:
 * semantic version comparison, release tag normalization, per-platform asset
 * naming, `SHA256SUMS` parsing, and detection of how the running CLI was
 * installed. Nothing here touches the filesystem or the network, so both the
 * update check and `self-update` can be reasoned about without I/O.
 */

/** Owner/name of the repository whose releases the updater follows. */
export const GITHUB_REPOSITORY = "sunerpy/kiro-provider";

/** Name of the checksum manifest attached to every release. */
export const CHECKSUM_MANIFEST_NAME = "SHA256SUMS";

export type SemanticVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  readonly prerelease: readonly string[];
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses `X.Y.Z`, `vX.Y.Z`, and prerelease/build variants. Returns `undefined`
 * for anything else so callers can fail with their own typed error instead of
 * silently comparing garbage.
 */
export function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim().replace(/^v/, ""));
  if (!match) return undefined;
  const [, major = "0", minor = "0", patch = "0", prerelease] = match;
  const parsed = [major, minor, patch].map(safeComponent);
  const [safeMajor, safeMinor, safePatch] = parsed;
  if (safeMajor === undefined || safeMinor === undefined || safePatch === undefined) {
    return undefined;
  }
  return {
    major: safeMajor,
    minor: safeMinor,
    patch: safePatch,
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

/**
 * Rejects a numeric component that a `number` cannot hold exactly. Beyond
 * `Number.MAX_SAFE_INTEGER` two distinct versions round to the same value (and
 * enough digits collapse to `Infinity`), which would report them as equal. This
 * project cannot have released such a version, so it is not a version.
 */
function safeComponent(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compares digit strings by value without going through `number`, so long
 * prerelease counters stay ordered instead of colliding at the float precision
 * limit.
 */
function compareDigitStrings(left: string, right: string): number {
  const trimmedLeft = left.replace(/^0+(?=\d)/, "");
  const trimmedRight = right.replace(/^0+(?=\d)/, "");
  if (trimmedLeft.length !== trimmedRight.length) {
    return trimmedLeft.length < trimmedRight.length ? -1 : 1;
  }
  return trimmedLeft < trimmedRight ? -1 : trimmedLeft > trimmedRight ? 1 : 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareDigitStrings(left, right);
  // Semver orders numeric identifiers below alphanumeric ones.
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    // A stable release outranks any prerelease of the same core version.
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = comparePrereleaseIdentifier(left[index] ?? "", right[index] ?? "");
    if (compared !== 0) return compared;
  }
  return compareNumbers(left.length, right.length);
}

/** Semver precedence: negative when `left` is older than `right`. */
export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  return (
    compareNumbers(left.major, right.major) ||
    compareNumbers(left.minor, right.minor) ||
    compareNumbers(left.patch, right.patch) ||
    comparePrerelease(left.prerelease, right.prerelease)
  );
}

/**
 * Compares two version strings, returning `undefined` when either side is not
 * a version this project could have released.
 */
export function compareVersionStrings(left: string, right: string): number | undefined {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return undefined;
  return compareSemanticVersions(parsedLeft, parsedRight);
}

/**
 * Normalizes a user-supplied version or tag to the release tag format
 * (`v3.4.0`). Returns `undefined` when the input is not a version.
 */
export function normalizeReleaseTag(value: string): string | undefined {
  const parsed = parseSemanticVersion(value);
  if (!parsed) return undefined;
  return `v${value.trim().replace(/^v/, "")}`;
}

/** Strips the leading `v` from a release tag. */
export function releaseVersionFromTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

/**
 * Release assets keyed by `${process.platform}-${process.arch}`. The release
 * workflow publishes exactly these five names; anything else has no binary to
 * install.
 */
const RELEASE_ASSETS: ReadonlyMap<string, string> = new Map([
  ["linux-x64", "kiro-provider-linux-x64"],
  ["linux-arm64", "kiro-provider-linux-arm64"],
  ["darwin-x64", "kiro-provider-darwin-x64"],
  ["darwin-arm64", "kiro-provider-darwin-arm64"],
  ["win32-x64", "kiro-provider-windows-x64.exe"],
]);

/** Every published asset name, sorted, for error messages and tests. */
export const RELEASE_ASSET_NAMES: readonly string[] = [...RELEASE_ASSETS.values()].sort();

/**
 * Release asset for the running platform, or `undefined` when this
 * platform/architecture pair has no published binary.
 */
export function releaseAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return RELEASE_ASSETS.get(`${platform}-${arch}`);
}

/** Download URL of one asset attached to a release tag. */
export function releaseAssetUrl(tag: string, asset: string): string {
  return `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${asset}`;
}

/** Human-facing release page for a tag. */
export function releasePageUrl(tag: string): string {
  return `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`;
}

const CHECKSUM_LINE = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/;

/**
 * Parses `sha256sum` manifest lines into asset -> lowercase digest. The
 * optional `*` binary marker is tolerated and the first entry for a name wins,
 * matching `scripts/install.sh`.
 */
export function parseChecksumManifest(manifest: string): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    const match = CHECKSUM_LINE.exec(line.trim());
    if (!match) continue;
    const [, digest = "", name = ""] = match;
    if (!digests.has(name)) digests.set(name, digest.toLowerCase());
  }
  return digests;
}

const BUNFS_POSIX_PREFIX = "/$bunfs/";
const BUNFS_WINDOWS_PATTERN = /^[a-z]:\/~bun\//;

/**
 * True when the running module was loaded from a Bun single-file executable.
 * Bun maps the embedded entry point to `/$bunfs/root/...` on POSIX and
 * `B:\~BUN\root\...` on Windows, so the module path — not `process.execPath` —
 * is what distinguishes a compiled binary from a script run through Bun.
 */
export function isCompiledEntryPath(entryPath: string): boolean {
  const normalized = entryPath.replaceAll("\\", "/");
  return (
    normalized.startsWith(BUNFS_POSIX_PREFIX) ||
    BUNFS_WINDOWS_PATTERN.test(normalized.toLowerCase())
  );
}

/**
 * `binary` is a self-contained release binary that `self-update` can replace
 * in place; `package` is the npm install, which the package manager owns.
 */
export type InstallKind = "binary" | "package";

export function detectInstallKind(entryPath: string): InstallKind {
  return isCompiledEntryPath(entryPath) ? "binary" : "package";
}
