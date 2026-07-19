import { parseArgs } from "node:util";

export const CLI_USAGE = `Usage: kiro-provider <command> [options]

Commands:
	serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]
      Start the OpenAI-compatible gateway (default bind: 127.0.0.1:8787).
  login [--config <path>] [--start-url <url>] [--region <region>]
      Sign in with AWS Builder ID or an IAM Identity Center start URL.
  accounts list
      List stored accounts.
  accounts import [--from <path>] [--config <path>]
      Import authenticated accounts from the OpenCode Kiro database.
  accounts remove <id|email>
      Remove an account and write a tombstone.

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
type AccountsListCommand = { readonly kind: "accounts-list" };
type AccountsImportCommand = {
	readonly kind: "accounts-import";
	readonly configPath?: string;
	readonly from?: string;
};
type AccountsRemoveCommand = {
	readonly kind: "accounts-remove";
	readonly identifier: string;
};

export type CliCommand =
	| HelpCommand
	| ServeCommand
	| LoginCommand
	| AccountsListCommand
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
	const port = parsed.values.port === undefined ? undefined : Number(parsed.values.port);
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

function parseLogin(args: readonly string[]): LoginCommand {
	const parsed = parseArgs({
		args: [...args],
		options: {
			config: { type: "string" },
			"start-url": { type: "string" },
			region: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
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
			config: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (parsed.values.help) return { kind: "help" };
	return {
		kind: "accounts-import",
		...(parsed.values.from ? { from: parsed.values.from } : {}),
		...(parsed.values.config ? { configPath: parsed.values.config } : {}),
	};
}

function parseAccounts(args: readonly string[]): CliCommand {
	const action = args[0];
	switch (action) {
		case "list":
			if (args.length !== 1) throw new CliUsageError("accounts list takes no arguments");
			return { kind: "accounts-list" };
		case "import":
			return parseImport(args.slice(1));
		case "remove": {
			const identifier = args[1];
			if (!identifier || args.length !== 2) {
				throw new CliUsageError("accounts remove requires exactly one <id|email>");
			}
			return { kind: "accounts-remove", identifier };
		}
		default:
			throw new CliUsageError(
				action === undefined
					? "accounts requires list, import, or remove"
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
