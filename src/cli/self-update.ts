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
 *   one. The temp file is created with an unpredictable name and `O_EXCL`, so
 *   a planted symlink in the install directory cannot redirect the write.
 *   Windows alone cannot replace a mapped image, so there the old file is
 *   parked aside first and the rename is rolled back if the swap fails.
 *
 * No gateway configuration is loaded here on purpose — updating must keep
 * working when `config.json` is broken, which is one of the reasons to update.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
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

/** Refuses absurd payloads while buffering them; the binaries are ~100 MB. */
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

/**
 * Release JSON and `SHA256SUMS` are kilobytes. Capping them keeps a proxy that
 * answers with an endless body from exhausting memory before parsing.
 */
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

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
 * Replaces `user:password@` in a proxy value with `***@`. Proxy URLs routinely
 * carry credentials and the rejected value is reported on stderr, which CI logs
 * and terminal recorders keep, so the userinfo never reaches a message.
 */
export function redactProxyUrl(value: string): string {
  const schemeEnd = value.indexOf("//");
  const authorityStart = schemeEnd < 0 ? 0 : schemeEnd + 2;
  const rest = value.slice(authorityStart);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at < 0) return value;
  return `${value.slice(0, authorityStart)}***@${value.slice(authorityStart + at + 1)}`;
}

/**
 * Proxy precedence for update traffic: explicit flag, then the provider's own
 * variable, then the conventional shell variables. Deliberately independent of
 * `config.json` so a broken config cannot block an upgrade. An explicitly empty
 * `--proxy ""` selects no proxy, matching `serve`, so it does not fall through to
 * the environment. Bun's `fetch` reads `HTTPS_PROXY`/`HTTP_PROXY` itself and no
 * `proxy` value disables that, so `--proxy ""` suppresses this resolution rather
 * than guaranteeing a direct socket; the documentation says so.
 */
export function resolveUpdateProxyUrl(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const candidate =
    explicit === undefined
      ? env.KIRO_PROVIDER_PROXY_URL ||
        env.HTTPS_PROXY ||
        env.https_proxy ||
        env.HTTP_PROXY ||
        env.http_proxy
      : explicit;
  if (!candidate) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new SelfUpdateError(
      `Invalid proxy URL for the update download: ${redactProxyUrl(candidate)}`,
      { cause: error },
    );
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
  const bytes = await readBounded(response, {
    limit: MAX_METADATA_BYTES,
    url,
    what: options.what,
  });
  return { body: new TextDecoder().decode(bytes), status: response.status };
}

/**
 * Buffers a response body while enforcing a byte ceiling. `content-length` is
 * only a hint — a hostile or misconfigured proxy can omit it and stream
 * endlessly — so the running total is what actually stops the read.
 */
async function readBounded(
  response: Response,
  options: { readonly limit: number; readonly url: string; readonly what: string },
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > options.limit) {
    throw new SelfUpdateError(
      `Refusing to read ${declared} bytes of ${options.what} from ${options.url}; the limit is ${options.limit} bytes.`,
    );
  }
  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > options.limit) {
        throw new SelfUpdateError(
          `${options.what} from ${options.url} exceeded ${options.limit} bytes; the download was discarded.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

/**
 * Compares the running build against the newest (or pinned) release. Proxy
 * resolution happens here rather than at the call site so `--version --check`
 * and `self-update` honour the same documented precedence.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheck> {
  const proxyUrl = resolveUpdateProxyUrl(options.proxyUrl, options.env ?? process.env);
  const release = await resolveRelease({
    ...options,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
  });
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
      /** True when this build is ahead of the newest release, not equal to it. */
      readonly localIsNewer: boolean;
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

/**
 * Replacing a file through a same-directory rename needs write and search
 * access on the parent directory, not write access to the old file, so this
 * checks the directory only: a deliberately hardened `0555` binary in a
 * directory the user owns updates fine, and the atomic replacement itself
 * reports anything more specific.
 */
function assertWritable(targetPath: string): void {
  const directory = dirname(targetPath);
  try {
    accessSync(directory, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw new SelfUpdateError(
      `No write permission for the install directory ${directory} holding ${basename(targetPath)}. Re-run with an account that owns that directory, or reinstall with scripts/install.sh. Nothing was changed.`,
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
  const bytes = await readBounded(response, {
    limit: MAX_ASSET_BYTES,
    url,
    what: "the release asset",
  });
  if (bytes.byteLength === 0) {
    throw new SelfUpdateError(`The release asset download was empty: ${url}`);
  }
  return bytes;
}

/**
 * Rename failures that mean the destination file itself is held open rather
 * than that the path is wrong. Only Windows needs the park-aside dance: POSIX
 * renames over a running executable, so treating a POSIX failure as "locked"
 * would move an unrelated path (a directory that appeared at the target, say)
 * out of the way instead of reporting the real error.
 */
const LOCKED_TARGET_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EPERM",
  "ETXTBSY",
  "UNKNOWN",
]);

export function shouldParkOldImage(error: unknown, platform: string): boolean {
  if (platform !== "win32") return false;
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && LOCKED_TARGET_CODES.has(code);
}

/**
 * Writes the verified bytes next to the target and renames them over it. The
 * staged file inherits the current binary's permission bits (plus owner
 * execute) so a deliberately tightened install is not loosened by an upgrade.
 *
 * The staging path is unpredictable and opened with `O_CREAT | O_EXCL`, so an
 * existing file or symlink at that path fails the open instead of being
 * followed, and the mode is applied to the descriptor rather than to the name.
 */
function replaceExecutable(targetPath: string, bytes: Uint8Array, platform: string): void {
  const mode = (statSync(targetPath).mode & 0o777) | 0o100;
  const staged = join(
    dirname(targetPath),
    `.${basename(targetPath)}.self-update-${randomBytes(12).toString("hex")}`,
  );
  try {
    writeStagedFile(staged, bytes, mode);
    try {
      renameSync(staged, targetPath);
    } catch (error) {
      if (!shouldParkOldImage(error, platform)) throw error;
      // Windows refuses to replace a mapped image; park the old file aside.
      const parked = `${targetPath}.old-${process.pid}`;
      renameSync(targetPath, parked);
      try {
        renameSync(staged, targetPath);
      } catch (nested) {
        let restored = true;
        try {
          renameSync(parked, targetPath);
        } catch {
          restored = false;
        }
        throw new SelfUpdateError(
          restored
            ? `Failed to install the new binary at ${targetPath}. The previous binary was restored.`
            : `Failed to install the new binary at ${targetPath}, and the previous binary could not be restored automatically. It is intact at ${parked}; move it back to ${targetPath} to recover.`,
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

function writeStagedFile(staged: string, bytes: Uint8Array, mode: number): void {
  const handle = openSync(staged, "wx", mode);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(handle, bytes, offset, bytes.byteLength - offset);
    }
    // Force the exact mode: `open` honours the process umask, and applying it to
    // the descriptor cannot be redirected to another path.
    fchmodSync(handle, mode);
  } finally {
    closeSync(handle);
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
  // Resolved once, before any request, so an unusable proxy fails fast and the
  // metadata request and the download cannot disagree about routing. `env: {}`
  // stops `checkForUpdate` from consulting the environment a second time.
  const proxyUrl = resolveUpdateProxyUrl(options.proxyUrl, dependencies.env ?? process.env);
  const fetchImpl = dependencies.fetch ?? (fetch as FetchLike);
  const check = await checkForUpdate({
    currentVersion: options.currentVersion,
    ...(options.tag ? { tag: options.tag } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    fetch: fetchImpl,
    env: {},
  });

  // An explicit --tag is an instruction, so it may reinstall or roll back.
  const pinned = options.tag !== undefined;
  if (!check.updateAvailable && !options.force && !pinned) {
    return {
      status: "up-to-date",
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
      localIsNewer: check.localIsNewer,
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

  replaceExecutable(executablePath, bytes, platform);
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
      return result.localIsNewer
        ? [
            `kiro-provider ${result.currentVersion} is newer than the latest release ${result.latestVersion}. Use --force to reinstall it, or --tag to pin a release.`,
          ]
        : [`kiro-provider ${result.currentVersion} is already the latest release.`];
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
    ...("localIsNewer" in result ? { local_is_newer: result.localIsNewer } : {}),
    ...("asset" in result ? { asset: result.asset } : {}),
    ...("executablePath" in result ? { binary: result.executablePath } : {}),
    ...("sha256" in result ? { sha256: result.sha256 } : {}),
    ...("releaseUrl" in result ? { release_url: result.releaseUrl } : {}),
  };
}
