import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { platformConfigRoot } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";

/**
 * A holder that dies without cleanup (SIGKILL, OOM) leaves its lock directory
 * behind; it becomes reclaimable once its mtime is older than the stale
 * window. The holder refreshes that mtime every update interval, so a restart
 * can be blocked for at most `stale + update`, which the default retry budget
 * (`attempts * delay`) covers.
 */
export const INSTANCE_LOCK_STALE_MS = 15_000;
export const INSTANCE_LOCK_UPDATE_MS = 5_000;
export const INSTANCE_LOCK_RETRY_DELAY_MS = 1_000;
export const INSTANCE_LOCK_RETRY_ATTEMPTS = 20;

export class ServiceInstanceLockError extends Error {
	readonly name = "ServiceInstanceLockError";
	readonly code = "service_instance_already_running";
}

export interface ServiceInstanceLease {
	readonly path: string;
	/** True once proper-lockfile reported the lock as compromised. */
	readonly compromised: boolean;
	release(): void;
	/**
	 * Registers a fail-closed handler for lock compromise (the lock directory
	 * was removed, or the mtime refresh missed the stale window). Fires
	 * immediately when the lease is already compromised. Without any handler
	 * the process exits with a non-zero code instead of serving with a lock it
	 * no longer owns.
	 */
	onCompromised(handler: (error: Error) => void): void;
}

export interface InstanceLockPathOptions {
	readonly env?: Record<string, string | undefined>;
	readonly platform?: NodeJS.Platform;
	readonly homeDirectory?: string;
}

export interface InstanceLockAcquireOptions extends InstanceLockPathOptions {
	readonly staleMs?: number;
	readonly updateMs?: number;
	/** Additional attempts after the first ELOCKED; 0 disables retrying. */
	readonly retryAttempts?: number;
	readonly retryDelayMs?: number;
	readonly sleep?: (ms: number) => void;
	/** Fallback when the lock is compromised and no handler is registered. */
	readonly exit?: (code: number) => void;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code : undefined;
}

export function defaultInstanceLockPath(
	options: InstanceLockPathOptions = {},
): string {
	return join(platformConfigRoot(options), "kiro-provider", "service.instance");
}

function ensureLockTarget(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		const descriptor = openSync(path, "a", 0o600);
		closeSync(descriptor);
	}
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

function invokeCompromiseHandler(
	handler: (error: Error) => void,
	error: Error,
): void {
	try {
		handler(error);
	} catch (handlerError) {
		auditLog("error", "single_instance_compromise_handler_failed", {
			error_type:
				handlerError instanceof Error ? handlerError.name : typeof handlerError,
		});
	}
}

export function acquireServiceInstanceLock(
	config: Pick<Config, "enforce_single_instance" | "instance_lock_path">,
	options: InstanceLockAcquireOptions = {},
): ServiceInstanceLease | undefined {
	if (!config.enforce_single_instance) {
		auditLog("warn", "single_instance_protection_disabled", {});
		return undefined;
	}

	const path = config.instance_lock_path ?? defaultInstanceLockPath(options);
	ensureLockTarget(path);
	const staleMs = options.staleMs ?? INSTANCE_LOCK_STALE_MS;
	const updateMs = options.updateMs ?? INSTANCE_LOCK_UPDATE_MS;
	const retryAttempts = options.retryAttempts ?? INSTANCE_LOCK_RETRY_ATTEMPTS;
	const retryDelayMs = options.retryDelayMs ?? INSTANCE_LOCK_RETRY_DELAY_MS;
	const sleep = options.sleep ?? ((ms: number): void => Bun.sleepSync(ms));
	const exit = options.exit ?? ((code: number): void => process.exit(code));
	const lockPathHash = auditHash(path);

	const state: { released: boolean; compromised: Error | undefined } = {
		released: false,
		compromised: undefined,
	};
	const handlers: Array<(error: Error) => void> = [];
	const onCompromised = (error: Error): void => {
		// proper-lockfile has already dropped its ownership record; the release
		// callback would only report ERELEASED from here on.
		state.released = true;
		state.compromised = error;
		auditLog("error", "single_instance_lock_compromised", {
			lock_path_hash: lockPathHash,
			error_code: errorCode(error) ?? error.name,
			stale_ms: staleMs,
			update_ms: updateMs,
			handler_count: handlers.length,
		});
		if (handlers.length === 0) {
			// Fail closed: nothing can stop the server on our behalf, and serving
			// without the lock risks two instances owning the same accounts.
			exit(1);
			return;
		}
		for (const handler of handlers.splice(0)) {
			invokeCompromiseHandler(handler, error);
		}
	};
	const lockOptions = {
		stale: staleMs,
		update: updateMs,
		retries: 0,
		realpath: false,
		onCompromised,
	};

	const startedAt = Date.now();
	let attempts = 0;
	let releaseLock: (() => void) | undefined;
	while (releaseLock === undefined) {
		attempts += 1;
		try {
			releaseLock = lockfile.lockSync(path, lockOptions);
		} catch (error) {
			if (errorCode(error) !== "ELOCKED") {
				throw new ServiceInstanceLockError(
					`Unable to acquire the kiro-provider service lock at ${path}`,
					{ cause: error },
				);
			}
			if (attempts > retryAttempts) {
				throw new ServiceInstanceLockError(
					`Another kiro-provider instance already holds the service lock at ${path} ` +
						`(gave up after ${attempts} attempt(s) over ${Date.now() - startedAt} ms; ` +
						`a lock left behind by a dead process becomes stale after ${staleMs} ms)`,
					{ cause: error },
				);
			}
			if (attempts === 1) {
				auditLog("warn", "single_instance_lock_busy", {
					lock_path_hash: lockPathHash,
					retry_attempts: retryAttempts,
					retry_delay_ms: retryDelayMs,
					stale_ms: staleMs,
				});
			}
			sleep(retryDelayMs);
		}
	}

	auditLog("info", "single_instance_lock_acquired", {
		lock_path_hash: lockPathHash,
		attempts,
		stale_ms: staleMs,
		update_ms: updateMs,
	});
	return {
		path,
		get compromised(): boolean {
			return state.compromised !== undefined;
		},
		release(): void {
			if (state.released) return;
			state.released = true;
			try {
				releaseLock?.();
			} catch (error) {
				if (errorCode(error) !== "ERELEASED") throw error;
			}
		},
		onCompromised(handler: (error: Error) => void): void {
			if (state.compromised !== undefined) {
				invokeCompromiseHandler(handler, state.compromised);
				return;
			}
			handlers.push(handler);
		},
	};
}

type StoppableServer = {
	stop(closeActiveConnections?: boolean): void;
};

export function bindServiceInstanceLease<T extends StoppableServer>(
	server: T,
	lease: Pick<ServiceInstanceLease, "release"> | undefined,
): T {
	if (!lease) return server;
	const originalStop = server.stop.bind(server);
	const stop = (closeActiveConnections?: boolean): void => {
		try {
			originalStop(closeActiveConnections);
		} finally {
			lease.release();
		}
	};
	try {
		Object.defineProperty(server, "stop", {
			configurable: true,
			value: stop,
		});
	} catch (error) {
		try {
			originalStop(true);
		} finally {
			lease.release();
		}
		throw new ServiceInstanceLockError(
			"Unable to bind the service lock lifecycle to the server",
			{ cause: error },
		);
	}
	return server;
}
