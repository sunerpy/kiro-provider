import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import type { PipelineAccountMaintenance } from "../src/core/account-maintenance.js";
import { type ServerHandle, startServer } from "../src/server/app.js";
import { createGracefulShutdown } from "../src/server/lifecycle.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const temporaryDirectories: string[] = [];
const databases: AccountsDatabase[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryLockPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "kiro-provider-lifecycle-"));
	temporaryDirectories.push(directory);
	return join(directory, "service.instance");
}

function lifecycleConfig(lockPath: string): Config {
	return ConfigSchema.parse({
		api_keys: ["sk-lifecycle"],
		port: 43_999,
		instance_lock_path: lockPath,
		reasoning_replay_keys: ["test:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
	});
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new TypeError(`Timed out waiting for ${label}`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

describe("createGracefulShutdown", () => {
	test("stops accepting, drains, then stops maintenance, releases the lock, and exits", async () => {
		const log: string[] = [];
		let pending = 2;
		const shutdown = createGracefulShutdown({
			server: {
				stop(close?: boolean) {
					log.push(`stop:${close === true}`);
				},
				get pendingRequests() {
					return pending;
				},
			},
			maintenance: { stop: () => log.push("maintenance.stop") },
			lease: { release: () => log.push("lease.release") },
			exit: (code) => log.push(`exit:${code}`),
			drainTimeoutMs: 1_000,
			drainPollMs: 5,
			sleep: async (ms) => {
				pending = Math.max(0, pending - 1);
				await Bun.sleep(ms);
			},
		});

		await shutdown("SIGTERM", 0);

		expect(log).toEqual(["stop:false", "maintenance.stop", "lease.release", "exit:0"]);
	});

	test("force-closes connections that outlive the drain window and joins repeated calls", async () => {
		const log: string[] = [];
		const shutdown = createGracefulShutdown({
			server: {
				stop(close?: boolean) {
					log.push(`stop:${close === true}`);
				},
				pendingRequests: 1,
			},
			maintenance: { stop: () => log.push("maintenance.stop") },
			lease: { release: () => log.push("lease.release") },
			exit: (code) => log.push(`exit:${code}`),
			drainTimeoutMs: 30,
			drainPollMs: 5,
		});

		await Promise.all([shutdown("lock_compromised", 1), shutdown("SIGINT", 0)]);

		expect(log).toEqual([
			"stop:false",
			"stop:true",
			"maintenance.stop",
			"lease.release",
			"exit:1",
		]);
	});

	test("still exits when a step throws", async () => {
		const log: string[] = [];
		const shutdown = createGracefulShutdown({
			server: {
				stop() {
					throw new Error("stop failed");
				},
				pendingRequests: 0,
			},
			maintenance: {
				stop: () => {
					throw new Error("maintenance failed");
				},
			},
			exit: (code) => log.push(`exit:${code}`),
			drainTimeoutMs: 10,
		});

		await shutdown("SIGTERM", 0);

		expect(log).toEqual(["exit:0"]);
	});
});

interface Harness {
	readonly log: string[];
	readonly listeners: Map<string, () => void>;
	readonly exited: Promise<number>;
	readonly server: ServerHandle;
	readonly lockPath: string;
}

function startHarness(): Harness {
	const log: string[] = [];
	const listeners = new Map<string, () => void>();
	let pending = 1;
	const fakeServer: ServerHandle = {
		hostname: "127.0.0.1",
		port: 43_999,
		get pendingRequests() {
			return pending;
		},
		stop(close?: boolean) {
			log.push(`server.stop(${close === true})`);
			pending = 0;
			return Promise.resolve();
		},
	};
	const maintenance: PipelineAccountMaintenance = {
		start: () => {
			log.push("maintenance.start");
		},
		stop: () => {
			log.push("maintenance.stop");
		},
		runOnce: async () => {},
	};
	const database = new AccountsDatabase(":memory:");
	databases.push(database);
	const lockPath = temporaryLockPath();
	let resolveExit: ((code: number) => void) | undefined;
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const server = startServer(lifecycleConfig(lockPath), {
		serve: (options) => {
			log.push(`serve:${options.port}:${String(options.development)}`);
			return fakeServer;
		},
		factories: {
			createDatabase: () => database,
			createAccountMaintenance: () => maintenance,
		},
		signalSource: {
			on(event, listener) {
				listeners.set(event, listener);
			},
		},
		exit: (code) => {
			log.push(`exit:${code}`);
			resolveExit?.(code);
		},
		drainTimeoutMs: 200,
		drainPollMs: 5,
		lockOptions: { staleMs: 2_000, updateMs: 1_000 },
	});
	return { log, listeners, exited, server, lockPath };
}

describe("startServer lifecycle", () => {
	test("registers SIGTERM/SIGINT handlers that drain, stop maintenance, release the lock, and exit 0", async () => {
		const harness = startHarness();
		expect(harness.log).toEqual(["serve:43999:false", "maintenance.start"]);
		expect(existsSync(`${harness.lockPath}.lock`)).toBe(true);
		expect([...harness.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

		harness.listeners.get("SIGTERM")?.();
		const code = await within(harness.exited, 2_000, "SIGTERM shutdown");

		expect(code).toBe(0);
		expect(harness.log).toEqual([
			"serve:43999:false",
			"maintenance.start",
			"server.stop(false)",
			"maintenance.stop",
			"exit:0",
		]);
		expect(existsSync(`${harness.lockPath}.lock`)).toBe(false);
	});

	test("fails closed when the lock is compromised: stops the server before exiting non-zero", async () => {
		const harness = startHarness();

		rmSync(`${harness.lockPath}.lock`, { recursive: true, force: true });
		const code = await within(harness.exited, 4_000, "lock compromise shutdown");

		expect(code).toBe(1);
		expect(harness.log.indexOf("server.stop(false)")).toBeGreaterThan(-1);
		expect(harness.log.indexOf("server.stop(false)")).toBeLessThan(harness.log.indexOf("exit:1"));
		expect(harness.log.indexOf("maintenance.stop")).toBeLessThan(harness.log.indexOf("exit:1"));
		expect(harness.log.filter((entry) => entry.startsWith("exit:"))).toEqual(["exit:1"]);
	});

	test("keeps the bound stop for callers that shut the server down directly", () => {
		const harness = startHarness();

		harness.server.stop(true);

		expect(harness.log).toEqual([
			"serve:43999:false",
			"maintenance.start",
			"maintenance.stop",
			"server.stop(true)",
		]);
		expect(existsSync(`${harness.lockPath}.lock`)).toBe(false);
	});
});
