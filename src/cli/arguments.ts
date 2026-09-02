import { parseArgs } from "node:util";

export const CLI_USAGE = `Usage: kiro-provider <command> [options]

Commands:
  serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]
      Start the Responses, Messages, and optional legacy Chat gateway.
  login [--config <path>] [--start-url <url>] [--region <region>]
      Sign in directly to the provider-owned local auth store.
  accounts list [--details | --json]
      List accounts without exposing credentials.
  accounts refresh (--all | <id|email>) [--config <path>] [--json]
      Refresh authoritative usage now and renew access tokens when needed.
  accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>]
      Re-authenticate one account while preserving its internal account ID.
  accounts import [--from <path>] [--force]
      Copy OpenCode Kiro accounts once into the provider-owned local store.
      Rows whose local copy is newer are skipped unless --force is given.
  accounts remove <id|email> [--yes]
      Remove an account from the provider-owned local store and write a tombstone.

Options:
  -h, --help  Show this help.`;

type HelpCommand = { readonly kind: "help" };
type ServeCommand = {
	readonly kind: "serve";
	readonly configPath?: string;
	readonly host?: string;
	readonly port?: number;
	readonly proxy?: string;
};
type LoginCommand = {
	readonly kind: "login";
	readonly configPath?: string;
	readonly startUrl?: string;
	readonly region?: string;
};
type AccountsListCommand = {
	readonly kind: "accounts-list";
	readonly mode: "table" | "details" | "json";
};
type AccountsRefreshCommand = {
	readonly kind: "accounts-refresh";
	readonly identifier?: string;
	readonly configPath?: string;
	readonly json: boolean;
};
type AccountsReloginCommand = {
	readonly kind: "accounts-relogin";
	readonly identifier: string;
	readonly configPath?: string;
	readonly startUrl?: string;
	readonly region?: string;
};
type AccountsImportCommand = {
	readonly kind: "accounts-import";
	readonly from?: string;
	readonly force: boolean;
};
type AccountsRemoveCommand = {
	readonly kind: "accounts-remove";
	readonly identifier: string;
	readonly yes: boolean;
};

export type CliCommand =
	| HelpCommand
	| ServeCommand
	| LoginCommand
	| AccountsListCommand
	| AccountsRefreshCommand
	| AccountsReloginCommand
	| AccountsImportCommand
	| AccountsRemoveCommand;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

function parseServe(args: readonly string[]): ServeCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			config: { type: "string" },
			host: { type: "string" },
			port: { type: "string" },
			proxy: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (parsed.values.help) return { kind: "help" };
	const port =
		parsed.values.port === undefined
			? undefined
			: /^\d+$/.test(parsed.values.port.trim())
				? Number(parsed.values.port)
				: Number.NaN;
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new CliUsageError(`Invalid port: ${parsed.values.port}`);
	}
	return {
		kind: "serve",
		...(parsed.values.config ? { configPath: parsed.values.config } : {}),
		...(parsed.values.host ? { host: parsed.values.host } : {}),
		...(port !== undefined ? { port } : {}),
		...(parsed.values.proxy !== undefined ? { proxy: parsed.values.proxy } : {}),
	};
}

function parseLogin(args: readonly string[]): LoginCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			config: { type: "string" },
			"start-url": { type: "string" },
			region: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (parsed.values.help) return { kind: "help" };
	return {
		kind: "login",
		...(parsed.values.config ? { configPath: parsed.values.config } : {}),
		...(parsed.values["start-url"]
			? { startUrl: parsed.values["start-url"] }
			: {}),
		...(parsed.values.region ? { region: parsed.values.region } : {}),
	};
}

function parseImport(args: readonly string[]): AccountsImportCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			from: { type: "string" },
			force: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (parsed.values.help) return { kind: "help" };
	return {
		kind: "accounts-import",
		...(parsed.values.from ? { from: parsed.values.from } : {}),
		force: parsed.values.force ?? false,
	};
}

function parseAccountList(
	args: readonly string[],
): AccountsListCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			details: { type: "boolean" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (parsed.values.help) return { kind: "help" };
	if (parsed.values.details && parsed.values.json) {
		throw new CliUsageError("accounts list accepts only one of --details or --json");
	}
	return {
		kind: "accounts-list",
		mode: parsed.values.json
			? "json"
			: parsed.values.details
				? "details"
				: "table",
	};
}

function parseAccountRefresh(
	args: readonly string[],
): AccountsRefreshCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			all: { type: "boolean" },
			config: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: true,
	});
	if (parsed.values.help) return { kind: "help" };
	if (parsed.positionals.length > 1) {
		throw new CliUsageError(
			"accounts refresh accepts exactly one <id|email> or --all",
		);
	}
	const identifier = parsed.positionals[0];
	if ((parsed.values.all ?? false) === (identifier !== undefined)) {
		throw new CliUsageError(
			"accounts refresh requires exactly one <id|email> or --all",
		);
	}
	return {
		kind: "accounts-refresh",
		...(identifier ? { identifier } : {}),
		...(parsed.values.config ? { configPath: parsed.values.config } : {}),
		json: parsed.values.json ?? false,
	};
}

function parseAccountRelogin(
	args: readonly string[],
): AccountsReloginCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			config: { type: "string" },
			"start-url": { type: "string" },
			region: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: true,
	});
	if (parsed.values.help) return { kind: "help" };
	const identifier = parsed.positionals[0];
	if (!identifier || parsed.positionals.length !== 1) {
		throw new CliUsageError(
			"accounts relogin requires exactly one <id|email>",
		);
	}
	return {
		kind: "accounts-relogin",
		identifier,
		...(parsed.values.config ? { configPath: parsed.values.config } : {}),
		...(parsed.values["start-url"]
			? { startUrl: parsed.values["start-url"] }
			: {}),
		...(parsed.values.region ? { region: parsed.values.region } : {}),
	};
}

function parseAccountRemove(
	args: readonly string[],
): AccountsRemoveCommand | HelpCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			yes: { type: "boolean", short: "y" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: true,
	});
	if (parsed.values.help) return { kind: "help" };
	const identifier = parsed.positionals[0];
	if (!identifier || parsed.positionals.length !== 1) {
		throw new CliUsageError("accounts remove requires exactly one <id|email>");
	}
	return {
		kind: "accounts-remove",
		identifier,
		yes: parsed.values.yes ?? false,
	};
}

function parseAccounts(args: readonly string[]): CliCommand {
	const action = args[0];
	switch (action) {
		case "list":
			return parseAccountList(args.slice(1));
		case "refresh":
			return parseAccountRefresh(args.slice(1));
		case "relogin":
			return parseAccountRelogin(args.slice(1));
		case "import":
			return parseImport(args.slice(1));
		case "remove":
			return parseAccountRemove(args.slice(1));
		default:
			throw new CliUsageError(
				action === undefined
					? "accounts requires list, refresh, relogin, import, or remove"
					: `Unknown accounts command: ${action}`,
			);
	}
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
	const command = argv[0];
	switch (command) {
		case undefined:
		case "--help":
		case "-h":
			return { kind: "help" };
		case "serve":
			return parseServe(argv.slice(1));
		case "login":
			return parseLogin(argv.slice(1));
		case "accounts":
			return parseAccounts(argv.slice(1));
		default:
			throw new CliUsageError(`Unknown command: ${command}`);
	}
}
