import { parseArgs } from "node:util";
import {
  ACCOUNT_SORT_FIELDS,
  ACCOUNT_SORT_ORDERS,
  type AccountListSort,
  DEFAULT_ACCOUNT_SORT,
  isAccountSortField,
  isAccountSortOrder,
} from "./account-output.js";
import { normalizeReleaseTag } from "./release-version.js";

export const CLI_USAGE = `Usage: kiro-provider <command> [options]

Commands:
  serve [--config <path>] [--host <host>] [--port <port>] [--proxy <url>]
      Start the Responses, Messages, and optional legacy Chat gateway.
  login [--config <path>] [--start-url <url>] [--region <region>]
      Sign in directly to the provider-owned local auth store.
  accounts list [--details | --json] [--sort <field>] [--order asc|desc]
      List accounts without exposing credentials.
      Sort fields: email (default), id, auth, region, health, availability,
      usage, overage, last-sync, last-used, token-expires, generation.
  accounts refresh (--all | <id|email>) [--config <path>] [--json]
      Refresh authoritative usage now and renew access tokens when needed.
  accounts relogin <id|email> [--config <path>] [--start-url <url>] [--region <region>]
      Re-authenticate one account while preserving its internal account ID.
  accounts import [--from <path>] [--force]
      Copy OpenCode Kiro accounts once into the provider-owned local store.
      Rows whose local copy is newer are skipped unless --force is given.
  accounts remove <id|email> [--yes]
      Remove an account from the provider-owned local store and write a tombstone.
  self-update [--check] [--tag <version>] [--yes] [--json] [--proxy <url>] [--force]
      Replace this standalone binary with a GitHub release build, after
      verifying its published SHA256SUMS digest. npm installs must be upgraded
      with the package manager instead.

Options:
  -h, --help     Show this help.
  -V, --version  Show the installed version. Add --check to look up the latest
                 release, and --json for machine-readable output.`;

type HelpCommand = { readonly kind: "help" };
type VersionCommand = {
  readonly kind: "version";
  /** Query GitHub for the newest release instead of printing the version only. */
  readonly check: boolean;
  readonly json: boolean;
  readonly proxy?: string;
};
type SelfUpdateCommand = {
  readonly kind: "self-update";
  /** Report what would be installed without downloading or writing anything. */
  readonly check: boolean;
  readonly json: boolean;
  readonly yes: boolean;
  /** Reinstall even when the resolved release matches the running version. */
  readonly force: boolean;
  /** Release tag to install instead of the newest one, normalized to `vX.Y.Z`. */
  readonly tag?: string;
  readonly proxy?: string;
};
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
  readonly sort: AccountListSort;
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
  | VersionCommand
  | SelfUpdateCommand
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
    ...(parsed.values["start-url"] ? { startUrl: parsed.values["start-url"] } : {}),
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

/** Accepts `LAST_USED` and `last_used` as aliases of the documented spelling. */
function sortToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function parseAccountSort(field: string | undefined, order: string | undefined): AccountListSort {
  let resolvedField = DEFAULT_ACCOUNT_SORT.field;
  if (field !== undefined) {
    const token = sortToken(field);
    if (!isAccountSortField(token)) {
      throw new CliUsageError(
        `Unknown accounts list sort field: ${field}. Supported fields: ${ACCOUNT_SORT_FIELDS.join(", ")}`,
      );
    }
    resolvedField = token;
  }
  let resolvedOrder = DEFAULT_ACCOUNT_SORT.order;
  if (order !== undefined) {
    const token = sortToken(order);
    if (!isAccountSortOrder(token)) {
      throw new CliUsageError(
        `Unknown accounts list sort order: ${order}. Supported orders: ${ACCOUNT_SORT_ORDERS.join(", ")}`,
      );
    }
    resolvedOrder = token;
  }
  return { field: resolvedField, order: resolvedOrder };
}

function parseAccountList(args: readonly string[]): AccountsListCommand | HelpCommand {
  const parsed = parseArgs({
    args: [...args],
    options: {
      details: { type: "boolean" },
      json: { type: "boolean" },
      sort: { type: "string" },
      order: { type: "string" },
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
    mode: parsed.values.json ? "json" : parsed.values.details ? "details" : "table",
    sort: parseAccountSort(parsed.values.sort, parsed.values.order),
  };
}

function parseAccountRefresh(args: readonly string[]): AccountsRefreshCommand | HelpCommand {
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
    throw new CliUsageError("accounts refresh accepts exactly one <id|email> or --all");
  }
  const identifier = parsed.positionals[0];
  if ((parsed.values.all ?? false) === (identifier !== undefined)) {
    throw new CliUsageError("accounts refresh requires exactly one <id|email> or --all");
  }
  return {
    kind: "accounts-refresh",
    ...(identifier ? { identifier } : {}),
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    json: parsed.values.json ?? false,
  };
}

function parseAccountRelogin(args: readonly string[]): AccountsReloginCommand | HelpCommand {
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
    throw new CliUsageError("accounts relogin requires exactly one <id|email>");
  }
  return {
    kind: "accounts-relogin",
    identifier,
    ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
    ...(parsed.values["start-url"] ? { startUrl: parsed.values["start-url"] } : {}),
    ...(parsed.values.region ? { region: parsed.values.region } : {}),
  };
}

function parseAccountRemove(args: readonly string[]): AccountsRemoveCommand | HelpCommand {
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

function parseVersion(args: readonly string[]): VersionCommand | HelpCommand {
  const parsed = parseArgs({
    args: [...args],
    options: {
      check: { type: "boolean" },
      json: { type: "boolean" },
      proxy: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) return { kind: "help" };
  return {
    kind: "version",
    check: parsed.values.check ?? false,
    json: parsed.values.json ?? false,
    ...(parsed.values.proxy ? { proxy: parsed.values.proxy } : {}),
  };
}

function parseSelfUpdate(args: readonly string[]): SelfUpdateCommand | HelpCommand {
  const parsed = parseArgs({
    args: [...args],
    options: {
      check: { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      tag: { type: "string" },
      proxy: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) return { kind: "help" };
  let tag: string | undefined;
  if (parsed.values.tag !== undefined) {
    tag = normalizeReleaseTag(parsed.values.tag);
    if (tag === undefined) {
      throw new CliUsageError(
        `Invalid self-update tag: ${parsed.values.tag}. Expected a release version such as 3.4.0.`,
      );
    }
  }
  return {
    kind: "self-update",
    check: parsed.values.check ?? false,
    json: parsed.values.json ?? false,
    yes: parsed.values.yes ?? false,
    force: parsed.values.force ?? false,
    ...(tag ? { tag } : {}),
    ...(parsed.values.proxy ? { proxy: parsed.values.proxy } : {}),
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
    case "--version":
    case "-V":
    case "version":
      return parseVersion(argv.slice(1));
    case "self-update":
      return parseSelfUpdate(argv.slice(1));
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
