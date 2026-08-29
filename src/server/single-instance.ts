import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config } from "../config/schema.js";
import { auditHash, auditLog } from "../core/audit-log.js";

const INSTANCE_LOCK_OPTIONS = {
	stale: 30_000,
	update: 10_000,
	retries: 0,
	realpath: false,
} as const;

export class ServiceInstanceLockError extends Error {
	readonly name = "ServiceInstanceLockError";
	readonly code = "service_instance_already_running";
}

export interface ServiceInstanceLease {
	readonly path: string;
	release(): void;
}

export interface InstanceLockPathOptions {
	readonly env?: Record<string, string | undefined>;
	readonly platform?: NodeJS.Platform;
	readonly homeDirectory?: string;
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
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDirectory = options.homeDirectory ?? homedir();
	const configRoot =
		platform === "win32"
			? (env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"))
			: (env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"));
	return join(configRoot, "kiro-provider", "service.instance");
}

function ensureLockTarget(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		const descriptor = openSync(path, "a", 0o600);
		closeSync(descriptor);
	}
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function acquireServiceInstanceLock(
	config: Pick<Config, "enforce_single_instance" | "instance_lock_path">,
	options: InstanceLockPathOptions = {},
): ServiceInstanceLease | undefined {
	if (!config.enforce_single_instance) {
		auditLog("warn", "single_instance_protection_disabled", {});
		return undefined;
	}

	const path = config.instance_lock_path ?? defaultInstanceLockPath(options);
	ensureLockTarget(path);
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = lockfile.lockSync(path, INSTANCE_LOCK_OPTIONS);
	} catch (error) {
		if (errorCode(error) === "ELOCKED") {
			throw new ServiceInstanceLockError(
				`Another kiro-provider instance already holds the service lock at ${path}`,
				{ cause: error },
			);
		}
		throw new ServiceInstanceLockError(
			`Unable to acquire the kiro-provider service lock at ${path}`,
			{ cause: error },
		);
	}

	auditLog("info", "single_instance_lock_acquired", {
		lock_path_hash: auditHash(path),
	});
	let released = false;
	return {
		path,
		release(): void {
			if (released) return;
			released = true;
			try {
				releaseLock?.();
			} catch (error) {
				if (errorCode(error) !== "ERELEASED") throw error;
			}
		},
	};
}

type StoppableServer = {
	stop(closeActiveConnections?: boolean): void;
};

export function bindServiceInstanceLease<T extends StoppableServer>(
	server: T,
	lease: ServiceInstanceLease | undefined,
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
