import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const REFRESH_LOCK_OPTIONS = {
	stale: 15_000,
	retries: 0,
	realpath: false,
} as const;
const REFRESH_LOCK_DEADLINE_MS = 15_000;
const REFRESH_LOCK_MIN_BACKOFF_MS = 25;
const REFRESH_LOCK_MAX_BACKOFF_MS = 250;

type LockRelease = () => Promise<void>;

function isRetryableLockError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return error.code === "ELOCKED" || error.code === "ENOENT";
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal as AbortSignal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function lockPathForAccount(lockDirectory: string, accountId: string): string {
	const safeAccountId = accountId.replace(/[^A-Za-z0-9_-]/g, "");
	return join(lockDirectory, `.kiro-refresh-${safeAccountId}.lock`);
}

async function acquireRefreshLock(
	lockPath: string,
	signal?: AbortSignal,
): Promise<LockRelease> {
	const deadline = Date.now() + REFRESH_LOCK_DEADLINE_MS;
	let attempt = 0;

	for (;;) {
		if (signal?.aborted) throw abortReason(signal);
		try {
			return await lockfile.lock(lockPath, REFRESH_LOCK_OPTIONS);
		} catch (error) {
			const remainingMs = deadline - Date.now();
			if (!isRetryableLockError(error) || remainingMs <= 0) throw error;
			const ceiling = Math.min(
				REFRESH_LOCK_MIN_BACKOFF_MS * 2 ** Math.min(attempt, 4),
				REFRESH_LOCK_MAX_BACKOFF_MS,
				remainingMs,
			);
			const floor = Math.max(1, Math.floor(ceiling / 2));
			const delay = floor + Math.floor(Math.random() * (ceiling - floor + 1));
			attempt += 1;
			await sleep(delay, signal);
		}
	}
}

export async function withOpenCodeRefreshLock<T>(
	lockDirectory: string,
	accountId: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const lockPath = lockPathForAccount(lockDirectory, accountId);
	await fs.mkdir(lockDirectory, { recursive: true });
	if (!existsSync(lockPath)) {
		const handle = await fs.open(lockPath, "a");
		await handle.close();
	}

	const release = await acquireRefreshLock(lockPath, signal);
	try {
		return await operation();
	} finally {
		try {
			await release();
		} catch {
			// A stale-lock takeover or process shutdown can make release idempotently
			// fail. The next bounded acquisition still validates lock ownership.
		}
	}
}
