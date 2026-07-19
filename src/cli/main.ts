import { loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { startServer } from "../server/app.js";
import {
	ACCOUNTS_DB_PATH,
	AccountsDatabase,
	type StoredAccount,
} from "../storage/accounts-db.js";
import { CLI_USAGE, type CliCommand, parseCliArgs } from "./arguments.js";
import {
	type ImportAccountsDependencies,
	type ImportAccountsOptions,
	runImportAccounts,
} from "./import-accounts.js";
import { type LoginOptions, runLogin } from "./login.js";

export type { CliCommand } from "./arguments.js";
export { CLI_USAGE, parseCliArgs } from "./arguments.js";

type LoadOptions = NonNullable<Parameters<typeof loadConfig>[0]>;
type AccountsStore = Pick<
	AccountsDatabase,
	"getAccounts" | "insertAccount" | "removeAccount" | "close"
>;
type ServerAddress = {
	readonly hostname?: string;
	readonly port?: number;
};

export type CliDependencies = {
	readonly loadConfig: (options: LoadOptions) => Config;
	readonly startServer: (config: Config) => ServerAddress;
	readonly runLogin: (config: Config, options: LoginOptions) => Promise<void>;
	readonly runImportAccounts: (
		options: ImportAccountsOptions,
		dependencies: ImportAccountsDependencies,
	) => unknown;
	readonly openDb: (path: string) => AccountsStore;
	readonly stdout: (message: string) => void;
	readonly stderr: (message: string) => void;
};

function formatAccount(account: StoredAccount): string {
	const health = account.isHealthy ? "healthy" : "unhealthy";
	return `${account.email}\t${account.region}\t${health}\tgeneration=${account.generation}\tused=${account.usedCount ?? 0}/${account.limitCount ?? 0}`;
}

const defaultDependencies: CliDependencies = {
	loadConfig,
	startServer,
	runLogin,
	runImportAccounts,
	openDb: (path) => new AccountsDatabase(path),
	stdout: console.log,
	stderr: console.error,
};

async function dispatch(
	command: CliCommand,
	dependencies: CliDependencies,
): Promise<number> {
	switch (command.kind) {
		case "help":
			dependencies.stdout(CLI_USAGE);
			return 0;
		case "serve": {
				const overrides: Partial<Config> = {
					...(command.host ? { host: command.host } : {}),
					...(command.port !== undefined ? { port: command.port } : {}),
					...(command.proxy !== undefined
						? { proxy_url: command.proxy }
						: {}),
				};
			const config = dependencies.loadConfig({
				...(command.configPath ? { configPath: command.configPath } : {}),
				overrides,
			});
			if (config.test_upstream_endpoint) {
				dependencies.stderr(
					`WARNING: test_upstream_endpoint is set (${config.test_upstream_endpoint}); routing upstream to a NON-production endpoint. Unset it for normal use.`,
				);
			}
			const server = dependencies.startServer(config);
			dependencies.stdout(
				`Listening on http://${server.hostname ?? config.host}:${server.port ?? config.port}`,
			);
			return 0;
		}
		case "login": {
			const config = dependencies.loadConfig({
				...(command.configPath ? { configPath: command.configPath } : {}),
			});
			await dependencies.runLogin(config, {
				...(command.startUrl ? { startUrl: command.startUrl } : {}),
				...(command.region ? { region: command.region } : {}),
			});
			return 0;
		}
		case "accounts-list": {
			const database = dependencies.openDb(ACCOUNTS_DB_PATH);
			try {
				for (const account of database.getAccounts()) {
					dependencies.stdout(formatAccount(account));
				}
			} finally {
				database.close();
			}
			return 0;
		}
		case "accounts-import": {
			const database = dependencies.openDb(ACCOUNTS_DB_PATH);
			try {
				dependencies.runImportAccounts(
					{ ...(command.from ? { from: command.from } : {}) },
					{ database, stdout: dependencies.stdout },
				);
			} finally {
				database.close();
			}
			return 0;
		}
		case "accounts-remove": {
			const database = dependencies.openDb(ACCOUNTS_DB_PATH);
			try {
				const account = database
					.getAccounts()
					.find(
						(candidate) =>
							candidate.id === command.identifier ||
							candidate.email === command.identifier,
					);
				if (!account) {
					dependencies.stderr(`Account not found: ${command.identifier}`);
					return 1;
				}
				database.removeAccount(account.id);
				dependencies.stdout(`Removed account ${account.email}`);
			} finally {
				database.close();
			}
			return 0;
		}
	}
}

export async function main(
	argv: readonly string[] = process.argv.slice(2),
	dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
	let command: CliCommand;
	try {
		command = parseCliArgs(argv);
	} catch (error) {
		dependencies.stderr(error instanceof Error ? error.message : String(error));
		dependencies.stderr(CLI_USAGE);
		return 1;
	}
	try {
		return await dispatch(command, dependencies);
	} catch (error) {
		dependencies.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
