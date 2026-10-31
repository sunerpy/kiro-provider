import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export const IMPORT_LOCK_STALE_MS = 30_000;
export const IMPORT_LOCK_UPDATE_MS = 5_000;

export class ImportLeaseError extends Error {
  constructor(
    readonly code:
      | "import_in_progress"
      | "unsafe_import_lock_path"
      | "import_lock_unavailable"
      | "import_lock_compromised"
      | "import_lock_release_failed",
  ) {
    super(`Kiro-client import rejected: ${code}`);
    this.name = "ImportLeaseError";
  }
}

export interface ImportLease {
  readonly signal: AbortSignal;
  assertHeld(): void;
  release(): Promise<void>;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function owned(stat: fs.Stats): boolean {
  return (
    process.platform === "win32" || (stat.uid === process.geteuid?.() && (stat.mode & 0o022) === 0)
  );
}

function safeLockTarget(path: string): string {
  const parent = dirname(resolve(path));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.realpathSync(parent);
  const parentStat = fs.lstatSync(directory);
  if (!parentStat.isDirectory() || !owned(parentStat))
    throw new ImportLeaseError("unsafe_import_lock_path");
  const target = join(directory, basename(path));
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat))
      throw new ImportLeaseError("unsafe_import_lock_path");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat))
      throw new ImportLeaseError("unsafe_import_lock_path");
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    const stat = fs.lstatSync(`${target}.lock`);
    if (!stat.isDirectory() || !owned(stat)) throw new ImportLeaseError("unsafe_import_lock_path");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return target;
}

/** One import lease per provider database; it does not serialize service refreshes. */
export async function acquireImportLease(options: {
  readonly path: string;
  readonly staleMs?: number;
  readonly updateMs?: number;
}): Promise<ImportLease> {
  let target: string;
  try {
    target = safeLockTarget(options.path);
  } catch (error) {
    if (error instanceof ImportLeaseError) throw error;
    throw new ImportLeaseError("import_lock_unavailable");
  }
  const directory = `${target}.lock`;
  const controller = new AbortController();
  const staleMs = options.staleMs ?? IMPORT_LOCK_STALE_MS;
  let identity: fs.Stats | undefined;
  let released = false;
  const matches = (path: fs.PathLike = directory): boolean => {
    if (identity === undefined) return true;
    try {
      const stat = fs.lstatSync(path);
      return (
        stat.isDirectory() &&
        owned(stat) &&
        stat.dev === identity.dev &&
        stat.ino === identity.ino &&
        stat.birthtimeMs === identity.birthtimeMs
      );
    } catch {
      return false;
    }
  };
  const missing = (): NodeJS.ErrnoException =>
    Object.assign(new Error("Import lock ownership changed"), { code: "ENOENT" });
  const compromise = (): void => {
    if (!controller.signal.aborted)
      controller.abort(new ImportLeaseError("import_lock_compromised"));
  };
  // proper-lockfile releases its process registry on compromise or normal exit.
  // Guard filesystem callbacks so cleanup/heartbeat cannot remove or renew a
  // replacement owner's directory after this lease loses its original inode.
  const guardedFs = {
    ...fs,
    mkdir: (path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) =>
      fs.mkdir(path, { mode: 0o700 }, (error) => {
        if (error === null) {
          try {
            identity = fs.lstatSync(path);
          } catch {
            callback(missing());
            return;
          }
        }
        callback(error);
      }),
    stat: (
      path: fs.PathLike,
      callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void,
    ) => {
      if (!matches(path)) return callback(missing());
      fs.stat(path, callback);
    },
    utimes: (
      path: fs.PathLike,
      atime: fs.TimeLike,
      mtime: fs.TimeLike,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      if (!matches(path)) return callback(missing());
      fs.utimes(path, atime, mtime, callback);
    },
    rmdir: (path: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (!matches(path)) return callback(null);
      fs.rmdir(path, callback);
    },
    rmdirSync: (path: fs.PathLike) => {
      if (matches(path)) fs.rmdirSync(path);
    },
  };
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await lockfile.lock(target, {
      stale: staleMs,
      update: options.updateMs ?? IMPORT_LOCK_UPDATE_MS,
      retries: 0,
      realpath: false,
      fs: guardedFs,
      onCompromised: compromise,
    });
  } catch (error) {
    throw new ImportLeaseError(
      errorCode(error) === "ELOCKED" ? "import_in_progress" : "import_lock_unavailable",
    );
  }
  // Bun does not consistently run signal-exit's implicit normal-exit cleanup.
  // Use the same ownership guard for an explicit synchronous exit hook.
  const cleanupOnExit = (): void => {
    if (released || controller.signal.aborted) return;
    try {
      guardedFs.rmdirSync(directory);
    } catch {
      // A dead process's lock remains bounded by the stale window.
    }
  };
  process.once("exit", cleanupOnExit);
  return {
    signal: controller.signal,
    assertHeld(): void {
      try {
        if (released || !matches() || fs.lstatSync(directory).mtimeMs < Date.now() - staleMs)
          compromise();
      } catch {
        compromise();
      }
      if (controller.signal.aborted) throw new ImportLeaseError("import_lock_compromised");
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      process.removeListener("exit", cleanupOnExit);
      if (!controller.signal.aborted)
        controller.abort(new DOMException("Import lease released", "AbortError"));
      try {
        await releaseLock();
      } catch (error) {
        if (errorCode(error) !== "ERELEASED" && errorCode(error) !== "ENOTACQUIRED")
          throw new ImportLeaseError("import_lock_release_failed");
      }
    },
  };
}
