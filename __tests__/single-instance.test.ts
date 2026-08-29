import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireServiceInstanceLock,
	bindServiceInstanceLease,
	defaultInstanceLockPath,
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

		expect(() =>
			acquireServiceInstanceLock({
				enforce_single_instance: true,
				instance_lock_path: path,
			}),
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

	test("releases the lease when the bound server stops", () => {
		let releaseCalls = 0;
		const lease: ServiceInstanceLease = {
			path: temporaryLockPath(),
			release: () => {
				releaseCalls += 1;
			},
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
