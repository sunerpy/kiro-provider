import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultOpenCodeDatabasePath,
	runImportAccounts,
} from "../src/cli/import-accounts.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const temporaryDirectories: string[] = [];
const openDatabases: AccountsDatabase[] = [];

const LEGACY_ACCOUNTS_SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
    region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
    profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
    access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
    rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
    unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
    last_used INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0,
    limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0,
    overage_count INTEGER DEFAULT 0
  )
`;

type LegacyFixture = {
	readonly id: string;
	readonly email: string;
	readonly authMethod: string;
	readonly region?: string;
	readonly oidcRegion?: string | null;
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly refreshToken?: string;
	readonly accessToken?: string;
};

function temporaryPath(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), "kiro-provider-import-"));
	temporaryDirectories.push(directory);
	return join(directory, name);
}

function insertLegacyAccount(database: Database, fixture: LegacyFixture): void {
	database
		.query(`
      INSERT INTO accounts (
        id, email, auth_method, region, oidc_region, client_id, client_secret,
        profile_arn, start_url, refresh_token, access_token, expires_at,
        rate_limit_reset, is_healthy, fail_count, last_used, used_count,
        limit_count, last_sync, overage_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
		.run(
			fixture.id,
			fixture.email,
			fixture.authMethod,
			fixture.region ?? "us-east-1",
			fixture.oidcRegion ?? (fixture.authMethod === "idc" ? "us-west-2" : null),
			fixture.clientId ?? null,
			fixture.clientSecret ?? null,
			"arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
			fixture.authMethod === "idc"
				? "https://example.awsapps.com/start"
				: null,
			fixture.refreshToken ?? "refresh-token",
			fixture.accessToken ?? "access-token",
			2_000_000_000_000,
			0,
			1,
			0,
			1_700_000_000_000,
			4,
			100,
			1_700_000_000_001,
			0,
		);
}

afterEach(() => {
	for (const database of openDatabases.splice(0)) database.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("runImportAccounts", () => {
	test("resolves the default OpenCode database from XDG_CONFIG_HOME or the home directory", () => {
		expect(defaultOpenCodeDatabasePath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
			"/tmp/xdg/opencode/kiro.db",
		);
		expect(defaultOpenCodeDatabasePath({})).toBe(
			join(homedir(), ".config", "opencode", "kiro.db"),
		);
	});

	test("imports usable rows, skips unusable rows, and remains idempotent", () => {
		const sourcePath = temporaryPath("opencode-kiro.db");
		const targetPath = temporaryPath("provider-accounts.db");
		const source = new Database(sourcePath, { create: true });
		source.exec(LEGACY_ACCOUNTS_SCHEMA);
		insertLegacyAccount(source, {
			id: "idc-1",
			email: "idc@example.com",
			authMethod: "idc",
			clientId: "client-id",
			clientSecret: "client-secret",
		});
		insertLegacyAccount(source, {
			id: "desktop-1",
			email: "desktop@example.com",
			authMethod: "desktop",
		});
		insertLegacyAccount(source, {
			id: "invalid-1",
			email: "invalid@example.com",
			authMethod: "idc",
			clientId: "client-id",
			clientSecret: "client-secret",
			refreshToken: "",
		});
		source.close();
		const target = new AccountsDatabase(targetPath);
		openDatabases.push(target);
		const output: string[] = [];

		const first = runImportAccounts(
			{ from: sourcePath },
			{ database: target, stdout: (line) => output.push(line) },
		);
		const firstRows = target.getAccounts();
		const second = runImportAccounts(
			{ from: sourcePath },
			{ database: target, stdout: () => undefined },
		);
		const secondRows = target.getAccounts();

		expect(first).toEqual({ imported: 2, skipped: 1, total: 2 });
		expect(second).toEqual({ imported: 2, skipped: 1, total: 2 });
		expect(firstRows.map(({ id }) => id).sort()).toEqual([
			"desktop-1",
			"idc-1",
		]);
		expect(firstRows.find(({ id }) => id === "idc-1")).toMatchObject({
			refreshToken: "refresh-token",
			accessToken: "access-token",
			clientId: "client-id",
			clientSecret: "client-secret",
			generation: 1,
		});
		expect(secondRows).toHaveLength(2);
		expect(secondRows.every(({ generation }) => generation === 2)).toBe(true);
		expect(output.join("\n")).not.toContain("refresh-token");
		expect(output.join("\n")).not.toContain("access-token");
		expect(output.join("\n")).not.toContain("client-secret");
		expect(output.at(-1)).toBe("Imported 2, skipped 1, total in DB now 2");
	});

	test("reports every unusable source-account reason and malformed rows", () => {
		const sourcePath = temporaryPath("opencode-skip-reasons.db");
		const targetPath = temporaryPath("provider-skip-reasons.db");
		const source = new Database(sourcePath, { create: true });
		source.exec(LEGACY_ACCOUNTS_SCHEMA);
		insertLegacyAccount(source, {
			id: "usable",
			email: "usable@example.com",
			authMethod: "desktop",
		});
		insertLegacyAccount(source, {
			id: "missing-refresh",
			email: "missing-refresh@example.com",
			authMethod: "desktop",
			refreshToken: "",
		});
		insertLegacyAccount(source, {
			id: "missing-access",
			email: "missing-access@example.com",
			authMethod: "desktop",
			accessToken: "",
		});
		insertLegacyAccount(source, {
			id: "unsupported-region",
			email: "unsupported-region@example.com",
			authMethod: "desktop",
			region: "moon-1",
		});
		insertLegacyAccount(source, {
			id: "unsupported-auth",
			email: "unsupported-auth@example.com",
			authMethod: "browser",
		});
		insertLegacyAccount(source, {
			id: "missing-idc-client",
			email: "missing-idc-client@example.com",
			authMethod: "idc",
		});
		insertLegacyAccount(source, {
			id: "unsupported-oidc-region",
			email: "unsupported-oidc-region@example.com",
			authMethod: "idc",
			clientId: "client-id",
			clientSecret: "client-secret",
			oidcRegion: "moon-1",
		});
		insertLegacyAccount(source, {
			id: "",
			email: "malformed@example.com",
			authMethod: "desktop",
		});
		source.close();
		const target = new AccountsDatabase(targetPath);
		openDatabases.push(target);
		const output: string[] = [];

		const result = runImportAccounts(
			{ from: sourcePath },
			{ database: target, stdout: (line) => output.push(line) },
		);

		expect(result).toEqual({ imported: 1, skipped: 7, total: 1 });
		expect(target.getAccounts().map(({ id }) => id)).toEqual(["usable"]);
		expect(output).toEqual([
			"Imported usable@example.com\tdesktop\tus-east-1",
			"Skipped missing-refresh@example.com: missing refresh token",
			"Skipped missing-access@example.com: missing access token",
			"Skipped unsupported-region@example.com: missing or unsupported region",
			"Skipped unsupported-auth@example.com: unsupported auth method",
			"Skipped missing-idc-client@example.com: IDC client credentials missing",
			"Skipped unsupported-oidc-region@example.com: unsupported OIDC region",
			"Skipped malformed source account row",
			"Imported 1, skipped 7, total in DB now 1",
		]);
	});

	test("leaves the target unchanged when the source database is empty", () => {
		const sourcePath = temporaryPath("opencode-empty.db");
		const targetPath = temporaryPath("provider-empty.db");
		const source = new Database(sourcePath, { create: true });
		source.exec(LEGACY_ACCOUNTS_SCHEMA);
		source.close();
		const target = new AccountsDatabase(targetPath);
		openDatabases.push(target);
		const output: string[] = [];

		const result = runImportAccounts(
			{ from: sourcePath },
			{ database: target, stdout: (line) => output.push(line) },
		);

		expect(result).toEqual({ imported: 0, skipped: 0, total: 0 });
		expect(target.getAccounts()).toEqual([]);
		expect(output).toEqual(["Imported 0, skipped 0, total in DB now 0"]);
	});
});
