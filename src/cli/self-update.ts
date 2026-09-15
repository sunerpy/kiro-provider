/**
 * `-V --check` and `self-update`: look up the newest GitHub release, and
 * replace the running single-file binary with it after verifying the published
 * `SHA256SUMS` digest.
 *
 * Two deliberate properties:
 *
 * - Nothing is written until the downloaded bytes hash to the digest published
 *   in the release manifest, so a truncated or tampered download can never
 *   land on disk as an executable.
 * - The replacement is a same-directory temp file plus `rename`, which is
 *   atomic on POSIX and safe to perform on the running image: the kernel keeps
 *   the old inode alive for this process while new invocations pick up the new
 *   one. Windows cannot replace a mapped image, so the old file is parked
 *   aside first and the rename is rolled back if the swap fails.
 *
 * No gateway configuration is loaded here on purpose — updating must keep
 * working when `config.json` is broken, which is one of the reasons to update.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { fetchProxyOption } from "../core/proxy.js";
import {
  CHECKSUM_MANIFEST_NAME,
  compareVersionStrings,
  detectInstallKind,
  GITHUB_REPOSITORY,
  type InstallKind,
  normalizeReleaseTag,
  parseChecksumManifest,
  RELEASE_ASSET_NAMES,
  releaseAssetName,
  releaseAssetUrl,
  releasePageUrl,
  releaseVersionFromTag,
} from "./release-version.js";

/** Refuses absurd payloads before buffering them; the binaries are ~100 MB. */
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

const METADATA_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

export class SelfUpdateError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SelfUpdateError";
  }
}

export class UnsupportedInstallError extends SelfUpdateError {
  constructor(readonly installKind: InstallKind) {
    super(
      "self-update only replaces the standalone release binary. This copy was installed as an npm package, so upgrade it with your package manager instead: bun add -g @sunerpy/kiro-provider@latest (or npm install -g @sunerpy/kiro-provider@latest). Nothing was changed.",
    );
    this.name = "UnsupportedInstallError";
  }
}

export class UnsupportedPlatformError extends SelfUpdateError {
  constructor(
    readonly platform: string,
    readonly arch: string,
  ) {
    super(
      `No release binary is published for ${platform}-${arch}. Published assets: ${RELEASE_ASSET_NAMES.join(", ")}. Nothing was changed.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export class ChecksumMismatchError extends SelfUpdateError {
  constructor(
    readonly asset: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Checksum mismatch for ${asset}: expected ${expected}, downloaded ${actual}. The download was discarded and the installed binary was not changed.`,
    );
    this.name = "ChecksumMismatchError";
  }
}

type FetchInit = RequestInit & { readonly proxy?: string };

/** Narrowed `fetch` so tests can answer the release API without a network. */
export type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

/**
 * Ambient facts the updater reads. `entryPath` decides binary-vs-package and
 * defaults to this module's own location, which Bun rewrites to `/$bunfs/root`
 * inside a compiled executable; `executablePath` is the file to replace.
 */
export type SelfUpdateRuntime = {
  readonly entryPath?: string;
  readonly executablePath?: string;
  readonly platform?: string;
  readonly arch?: string;
};

export type UpdateCheckOptions = {
  readonly currentVersion: string;
  /** Pin a specific release instead of following `latest`. */
  readonly tag?: string;
  readonly proxyUrl?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type UpdateCheck = {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly latestTag: string;
  readonly releaseUrl: string;
  /** True only when the release is strictly newer than the running build. */
  readonly updateAvailable: boolean;
  /** True when the running build is ahead of the newest release. */
  readonly localIsNewer: boolean;
};

const ReleaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.string().url().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

function resolveSignal(options: {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

/**
 * Proxy precedence for update traffic: explicit flag, then the provider's own
 * variable, then the conventional shell variables. Deliberately independent of
 * `config.json` so a broken config cannot block an upgrade.
 */
export function resolveUpdateProxyUrl(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const candidate =
    explicit ||
    env.KIRO_PROVIDER_PROXY_URL ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy;
  if (!candidate) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new SelfUpdateError(`Invalid proxy URL for the update download: ${candidate}`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SelfUpdateError(
      `Unsupported proxy protocol for the update download: ${parsed.protocol}`,
    );
  }
  return candidate;
}

function userAgent(currentVersion: string): string {
  return `kiro-provider/${currentVersion} (+https://github.com/${GITHUB_REPOSITORY})`;
}

async function fetchText(
  url: string,
  options: {
    readonly currentVersion: string;
    readonly accept: string;
    readonly proxyUrl?: string;
    readonly signal: AbortSignal;
    readonly fetch: FetchLike;
    readonly what: string;
  },
): Promise<{ readonly body: string; readonly status: number }> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: {
        accept: options.accept,
        "user-agent": userAgent(options.currentVersion),
        "x-github-api-version": "2022-11-28",
      },
      signal: options.signal,
      ...fetchProxyOption(options.proxyUrl),
    });
  } catch (error) {
    throw new SelfUpdateError(`Unable to reach GitHub while fetching ${options.what}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new SelfUpdateError(describeHttpFailure(options.what, url, response.status));
  }
  return { body: await response.text(), status: response.status };
}

function describeHttpFailure(what: string, url: string, status: number): string {
  if (status === 404) {
    return `${what} was not found (HTTP 404): ${url}`;
  }
  if (status === 403 || status === 429) {
    return `GitHub rate-limited the request for ${what} (HTTP ${status}). Retry later, or download the release manually from https://github.com/${GITHUB_REPOSITORY}/releases.`;
  }
  return `GitHub returned HTTP ${status} for ${what}: ${url}`;
}

/**
 * Resolves the release to compare against: an explicit tag when pinned,
 * otherwise whatever GitHub reports as `latest` (which never includes drafts).
 */
async function resolveRelease(
  options: UpdateCheckOptions,
): Promise<{ readonly tag: string; readonly version: string; readonly releaseUrl: string }> {
  const fetchImpl = options.fetch ?? (fetch as FetchLike);
  const signal = resolveSignal({
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs ?? METADATA_TIMEOUT_MS,
  });
  const pinned = options.tag === undefined ? undefined : normalizeReleaseTag(options.tag);
  if (options.tag !== undefined && pinned === undefined) {
    throw new SelfUpdateError(
      `Not a release version: ${options.tag}. Expected a value like 3.4.0.`,
    );
  }
  const url =
    pinned === undefined
      ? `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`
      : `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${pinned}`;
  const { body } = await fetchText(url, {
    currentVersion: options.currentVersion,
    accept: "application/vnd.github+json",
    ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
    signal,
    fetch: fetchImpl,
    what: pinned === undefined ? "the latest release" : `release ${pinned}`,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new SelfUpdateError("GitHub returned invalid JSON for the release metadata", {
      cause: error,
    });
  }
  const parsed = ReleaseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SelfUpdateError("GitHub returned unexpected release metadata");
  }
  const tag = parsed.data.tag_name.trim();
  const version = releaseVersionFromTag(tag);
  if (normalizeReleaseTag(version) === undefined) {
    throw new SelfUpdateError(`GitHub reported an unrecognized release tag: ${tag}`);
  }
  return { tag, version, releaseUrl: parsed.data.html_url ?? releasePageUrl(tag) };
}

/** Compares the running build against the newest (or pinned) release. */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheck> {
  const release = await resolveRelease(options);
  const compared = compareVersionStrings(options.currentVersion, release.version);
  if (compared === undefined) {
    throw new SelfUpdateError(
      `Cannot compare the installed version (${options.currentVersion}) with release ${release.version}.`,
    );
  }
  return {
    currentVersion: options.currentVersion,
    latestVersion: release.version,
    latestTag: release.tag,
    releaseUrl: release.releaseUrl,
    updateAvailable: compared < 0,
    localIsNewer: compared > 0,
  };
}

export function formatVersion(version: string, json: boolean): string[] {
  if (!json) return [`kiro-provider ${version}`];
  return [
    JSON.stringify(
      {
        version,
        asset: releaseAssetName() ?? null,
        install_kind: detectInstallKind(import.meta.dir),
      },
      null,
      2,
    ),
  ];
}

export function formatUpdateCheck(check: UpdateCheck, json: boolean): string[] {
  if (json) {
    return [
      JSON.stringify(
        {
          version: check.currentVersion,
          latest_version: check.latestVersion,
          latest_tag: check.latestTag,
          update_available: check.updateAvailable,
          local_is_newer: check.localIsNewer,
          release_url: check.releaseUrl,
        },
        null,
        2,
      ),
    ];
  }
  const lines = [
    `kiro-provider ${check.currentVersion}`,
    `Latest release: ${check.latestVersion} (${check.releaseUrl})`,
  ];
  if (check.updateAvailable) {
    lines.push("Update available. Install it with: kiro-provider self-update");
  } else if (check.localIsNewer) {
    lines.push("This build is newer than the latest published release.");
  } else {
    lines.push("Already on the latest release.");
  }
  return lines;
}

export type SelfUpdateOptions = {
  readonly currentVersion: string;
  /** Report what would happen without downloading or writing anything. */
  readonly check: boolean;
  /** Reinstall even when the resolved release equals the running version. */
  readonly force: boolean;
  readonly assumeYes: boolean;
  readonly tag?: string;
  readonly proxyUrl?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly downloadTimeoutMs?: number;
};

export type SelfUpdateDependencies = {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly fetch?: FetchLike;
  readonly runtime?: SelfUpdateRuntime;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type SelfUpdateResult =
  | {
      readonly status: "up-to-date";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
    }
  | {
      readonly status: "available";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
      readonly asset: string;
      readonly executablePath: string;
    }
  | {
      readonly status: "cancelled";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly executablePath: string;
    }
  | {
      readonly status: "updated";
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
      readonly asset: string;
      readonly executablePath: string;
      readonly sha256: string;
    };

function resolveExecutablePath(runtime: SelfUpdateRuntime): string {
  const candidate = runtime.executablePath ?? process.execPath;
  if (!existsSync(candidate)) {
    throw new SelfUpdateError(
      `Cannot locate the installed binary to replace: ${candidate}. Nothing was changed.`,
    );
  }
  // Follow symlinks so a linked launcher is not replaced by a regular file.
  return realpathSync(candidate);
}

function assertWritable(targetPath: string): void {
  try {
    accessSync(dirname(targetPath), fsConstants.W_OK);
    accessSync(targetPath, fsConstants.W_OK);
  } catch (error) {
    throw new SelfUpdateError(
      `No write permission for ${targetPath}. Re-run with an account that owns the install directory, or reinstall with scripts/install.sh. Nothing was changed.`,
      { cause: error },
    );
  }
}

async function downloadAsset(
  url: string,
  options: {
    readonly currentVersion: string;
    readonly proxyUrl?: string;
    readonly signal: AbortSignal;
    readonly fetch: FetchLike;
  },
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: {
        accept: "application/octet-stream",
        "user-agent": userAgent(options.currentVersion),
      },
      signal: options.signal,
      ...fetchProxyOption(options.proxyUrl),
    });
  } catch (error) {
    throw new SelfUpdateError(`Unable to download the release asset: ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new SelfUpdateError(describeHttpFailure("the release asset", url, response.status));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    throw new SelfUpdateError(
      `Refusing to download ${declared} bytes from ${url}; the release binaries are far smaller.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new SelfUpdateError(`The release asset download was empty: ${url}`);
  }
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new SelfUpdateError(`The release asset download exceeded ${MAX_ASSET_BYTES} bytes`);
  }
  return bytes;
}

/**
 * Writes the verified bytes next to the target and renames them over it. The
 * staged file inherits the current binary's permission bits (plus owner
 * execute) so a deliberately tightened install is not loosened by an upgrade.
 */
function replaceExecutable(targetPath: string, bytes: Uint8Array): void {
  const mode = (statSync(targetPath).mode & 0o777) | 0o100;
  const staged = join(dirname(targetPath), `.${basename(targetPath)}.self-update-${process.pid}`);
  try {
    writeFileSync(staged, bytes, { mode });
    chmodSync(staged, mode);
    try {
      renameSync(staged, targetPath);
    } catch (error) {
      // Windows refuses to replace a mapped image; park the old file aside.
      const parked = `${targetPath}.old-${process.pid}`;
      renameSync(targetPath, parked);
      try {
        renameSync(staged, targetPath);
      } catch (nested) {
        renameSync(parked, targetPath);
        throw new SelfUpdateError(
          `Failed to install the new binary at ${targetPath}. The previous binary was restored.`,
          { cause: nested instanceof Error ? nested : error },
        );
      }
      try {
        unlinkSync(parked);
      } catch {
        // The running image stays locked on Windows; the stale copy is harmless.
      }
    }
  } finally {
    if (existsSync(staged)) unlinkSync(staged);
  }
}

export async function runSelfUpdate(
  options: SelfUpdateOptions,
  dependencies: SelfUpdateDependencies,
): Promise<SelfUpdateResult> {
  const runtime = dependencies.runtime ?? {};
  const installKind = detectInstallKind(runtime.entryPath ?? import.meta.dir);
  if (installKind !== "binary") throw new UnsupportedInstallError(installKind);

  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  const asset = releaseAssetName(platform, arch);
  if (asset === undefined) throw new UnsupportedPlatformError(platform, arch);

  const executablePath = resolveExecutablePath(runtime);
  const proxyUrl = resolveUpdateProxyUrl(options.proxyUrl, dependencies.env ?? process.env);
  const fetchImpl = dependencies.fetch ?? (fetch as FetchLike);
  const check = await checkForUpdate({
    currentVersion: options.currentVersion,
    ...(options.tag ? { tag: options.tag } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    fetch: fetchImpl,
  });

  // An explicit --tag is an instruction, so it may reinstall or roll back.
  const pinned = options.tag !== undefined;
  if (!check.updateAvailable && !options.force && !pinned) {
    return {
      status: "up-to-date",
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
    };
  }
  if (options.check) {
    return {
      status: "available",
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
      asset,
      executablePath,
    };
  }

  assertWritable(executablePath);

  if (!options.assumeYes) {
    const transition =
      check.currentVersion === check.latestVersion
        ? `Reinstall kiro-provider ${check.latestVersion}`
        : check.localIsNewer
          ? `Replace kiro-provider ${check.currentVersion} with the OLDER release ${check.latestVersion}`
          : `Update kiro-provider ${check.currentVersion} to ${check.latestVersion}`;
    const confirmed = await dependencies.confirm(`${transition} at ${executablePath}?`);
    if (!confirmed) {
      return {
        status: "cancelled",
        currentVersion: check.currentVersion,
        latestVersion: check.latestVersion,
        executablePath,
      };
    }
  }

  const downloadSignal = resolveSignal({
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  });
  // Manifest first: an asset is never buffered without a digest to check it.
  const manifest = await fetchText(releaseAssetUrl(check.latestTag, CHECKSUM_MANIFEST_NAME), {
    currentVersion: options.currentVersion,
    accept: "text/plain",
    ...(proxyUrl ? { proxyUrl } : {}),
    signal: downloadSignal,
    fetch: fetchImpl,
    what: `${CHECKSUM_MANIFEST_NAME} for ${check.latestTag}`,
  });
  const expected = parseChecksumManifest(manifest.body).get(asset);
  if (expected === undefined) {
    throw new SelfUpdateError(
      `${CHECKSUM_MANIFEST_NAME} for ${check.latestTag} has no entry for ${asset}. Nothing was changed.`,
    );
  }

  const bytes = await downloadAsset(releaseAssetUrl(check.latestTag, asset), {
    currentVersion: options.currentVersion,
    ...(proxyUrl ? { proxyUrl } : {}),
    signal: downloadSignal,
    fetch: fetchImpl,
  });
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new ChecksumMismatchError(asset, expected, actual);

  replaceExecutable(executablePath, bytes);
  return {
    status: "updated",
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    releaseUrl: check.releaseUrl,
    asset,
    executablePath,
    sha256: actual,
  };
}

export function formatSelfUpdateResult(result: SelfUpdateResult, json: boolean): string[] {
  if (json) return [JSON.stringify(selfUpdateJson(result), null, 2)];
  switch (result.status) {
    case "up-to-date":
      return [`kiro-provider ${result.currentVersion} is already the latest release.`];
    case "available":
      return [
        `Update available: ${result.currentVersion} → ${result.latestVersion}`,
        `Target: ${result.executablePath} (${result.asset})`,
        "Install it with: kiro-provider self-update",
      ];
    case "cancelled":
      return [`Update cancelled. ${result.executablePath} was not changed.`];
    case "updated":
      return [
        `Updated kiro-provider ${result.currentVersion} → ${result.latestVersion}`,
        `Binary: ${result.executablePath}`,
        `Verified sha256: ${result.sha256}`,
        `Release notes: ${result.releaseUrl}`,
        "Restart any long-running service that runs this binary, for example: systemctl --user restart kiro-provider.service",
      ];
  }
}

function selfUpdateJson(result: SelfUpdateResult): Readonly<Record<string, unknown>> {
  return {
    status: result.status,
    version: result.currentVersion,
    latest_version: result.latestVersion,
    ...("asset" in result ? { asset: result.asset } : {}),
    ...("executablePath" in result ? { binary: result.executablePath } : {}),
    ...("sha256" in result ? { sha256: result.sha256 } : {}),
    ...("releaseUrl" in result ? { release_url: result.releaseUrl } : {}),
  };
}
