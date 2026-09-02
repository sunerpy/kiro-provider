import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireServiceInstanceLock,
	bindServiceInstanceLease,
	defaultInstanceLockPath,
	INSTANCE_LOCK_RETRY_ATTEMPTS,
	INSTANCE_LOCK_RETRY_DELAY_MS,
	INSTANCE_LOCK_STALE_MS,
	INSTANCE_LOCK_UPDATE_MS,
	type ServiceInstanceLease,
	ServiceInstanceLockError,
} from "../src/server/single-instance.js";

const temporaryDirectories: string[] = [];
const leases: ServiceInstanceLease[] = [];

function temporaryLockPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "kiro-provider-instance-"));
	temporaryDirectories.push(directory);
	return join(directory, "service.instance");
}

afterEach(() => {
	for (const lease of leases.splice(0)) lease.release();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("service single-instance protection", () => {
	test("derives platform-specific default paths", () => {
		expect(
			defaultInstanceLockPath({
				env: { XDG_CONFIG_HOME: "/tmp/config" },
				platform: "linux",
				homeDirectory: "/home/test",
			}),
		).toBe("/tmp/config/kiro-provider/service.instance");
		expect(
			defaultInstanceLockPath({
				env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
				platform: "win32",
				homeDirectory: "C:\\Users\\test",
			}),
		).toContain("kiro-provider");
	});

	test("rejects a second service using the same lock and permits restart after release", () => {
		const path = temporaryLockPath();
		const first = acquireServiceInstanceLock({
			enforce_single_instance: true,
			instance_lock_path: path,
		});
		if (!first) throw new TypeError("Expected a service instance lease");
		leases.push(first);

		// A live holder in the same process cannot refresh its mtime while the
		// contender sleeps synchronously, so keep the contender's retry budget
		// far below the stale window instead of using the production defaults.
		expect(() =>
			acquireServiceInstanceLock(
				{ enforce_single_instance: true, instance_lock_path: path },
				{ retryAttempts: 1, retryDelayMs: 1 },
			),
		).toThrow(ServiceInstanceLockError);

		first.release();
		const restarted = acquireServiceInstanceLock({
			enforce_single_instance: true,
			instance_lock_path: path,
		});
		if (!restarted) throw new TypeError("Expected a restarted service lease");
		leases.push(restarted);
	});

	test("can be explicitly disabled", () => {
		expect(
			acquireServiceInstanceLock({
				enforce_single_instance: false,
				instance_lock_path: temporaryLockPath(),
			}),
		).toBeUndefined();
	});

	test("covers a crashed holder's stale window with the default retry budget", () => {
		expect(INSTANCE_LOCK_STALE_MS).toBe(15_000);
		expect(INSTANCE_LOCK_UPDATE_MS).toBe(5_000);
		expect(INSTANCE_LOCK_RETRY_ATTEMPTS * INSTANCE_LOCK_RETRY_DELAY_MS).toBeGreaterThanOrEqual(
			INSTANCE_LOCK_STALE_MS + INSTANCE_LOCK_UPDATE_MS,
		);
	});

	test("takes over a stale lock left behind by a dead process", () => {
		const path = temporaryLockPath();
		mkdirSync(`${path}.lock`);
		const staleMoment = new Date(Date.now() - 60_000);
		utimesSync(`${path}.lock`, staleMoment, staleMoment);
		const sleeps: number[] = [];

		const lease = acquireServiceInstanceLock(
			{ enforce_single_instance: true, instance_lock_path: path },
			{ staleMs: 2_000, updateMs: 1_000, sleep: (ms) => sleeps.push(ms) },
		);

		if (!lease) throw new TypeError("Expected the stale lock to be reclaimed");
		leases.push(lease);
		expect(lease.path).toBe(path);
		expect(lease.compromised).toBe(false);
		expect(sleeps).toEqual([]);
		expect(existsSync(`${path}.lock`)).toBe(true);
	});

	test("retries a live lock and names the path and stale window when giving up", () => {
		const path = temporaryLockPath();
		const holder = acquireServiceInstanceLock({
			enforce_single_instance: true,
			instance_lock_path: path,
		});
		if (!holder) throw new TypeError("Expected a service instance lease");
		leases.push(holder);
		const sleeps: number[] = [];

		let caught: unknown;
		try {
			acquireServiceInstanceLock(
				{ enforce_single_instance: true, instance_lock_path: path },
				{
					staleMs: 2_000,
					retryAttempts: 2,
					retryDelayMs: 7,
					sleep: (ms) => sleeps.push(ms),
				},
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ServiceInstanceLockError);
		if (!(caught instanceof ServiceInstanceLockError)) throw new TypeError("unreachable");
		expect(caught.message).toContain(path);
		expect(caught.message).toContain("3 attempt(s)");
		expect(caught.message).toContain("stale after 2000 ms");
		expect(sleeps).toEqual([7, 7]);
	});

	test("fails closed through the registered handler when the lock directory disappears", async () => {
		const path = temporaryLockPath();
		let exitCalls = 0;
		const lease = acquireServiceInstanceLock(
			{ enforce_single_instance: true, instance_lock_path: path },
			{
				staleMs: 2_000,
				updateMs: 1_000,
				exit: () => {
					exitCalls += 1;
				},
			},
		);
		if (!lease) throw new TypeError("Expected a service instance lease");
		leases.push(lease);
		const compromised = new Promise<Error>((resolve) => {
			lease.onCompromised(resolve);
		});

		rmSync(`${path}.lock`, { recursive: true, force: true });
		const error = await Promise.race([
			compromised,
			Bun.sleep(3_500).then(() => {
				throw new TypeError("lock compromise was not detected within the stale window");
			}),
		]);

		expect(error).toBeInstanceOf(Error);
		expect(lease.compromised).toBe(true);
		expect(exitCalls).toBe(0);
		expect(() => lease.release()).not.toThrow();
		let lateHandlerCalls = 0;
		lease.onCompromised(() => {
			lateHandlerCalls += 1;
		});
		expect(lateHandlerCalls).toBe(1);
	});

	test("exits non-zero when the lock is compromised and nobody registered a handler", async () => {
		const path = temporaryLockPath();
		let resolveExit: ((code: number) => void) | undefined;
		const exited = new Promise<number>((resolve) => {
			resolveExit = resolve;
		});
		const lease = acquireServiceInstanceLock(
			{ enforce_single_instance: true, instance_lock_path: path },
			{ staleMs: 2_000, updateMs: 1_000, exit: (code) => resolveExit?.(code) },
		);
		if (!lease) throw new TypeError("Expected a service instance lease");
		leases.push(lease);

		rmSync(`${path}.lock`, { recursive: true, force: true });
		const code = await Promise.race([
			exited,
			Bun.sleep(3_500).then(() => {
				throw new TypeError("lock compromise did not exit within the stale window");
			}),
		]);

		expect(code).toBe(1);
		expect(lease.compromised).toBe(true);
	});

	test("releases the lease when the bound server stops", () => {
		let releaseCalls = 0;
		const lease: ServiceInstanceLease = {
			path: temporaryLockPath(),
			compromised: false,
			release: () => {
				releaseCalls += 1;
			},
			onCompromised: () => {},
		};
		let stopCalls = 0;
		const server = bindServiceInstanceLease(
			{
				stop(closeActiveConnections?: boolean): void {
					expect(closeActiveConnections).toBe(true);
					stopCalls += 1;
				},
			},
			lease,
		);

		server.stop(true);

		expect(stopCalls).toBe(1);
		expect(releaseCalls).toBe(1);
	});
});
