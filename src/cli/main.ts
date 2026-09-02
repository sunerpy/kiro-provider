import { createInterface } from "node:readline/promises";
import { defaultOpenCodeAuthDbPath } from "../auth/opencode-auth-store.js";
import { loadConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { setAuditLogLevel } from "../core/audit-log.js";
import type { AccountRefreshSummary } from "../core/quota-rechecker.js";
import { startServer } from "../server/app.js";
import { ACCOUNTS_DB_PATH, AccountsDatabase, type StoredAccount } from "../storage/accounts-db.js";
import {
  formatAccountList,
  formatAccountRefreshSummary,
  resolveAccount,
} from "./account-output.js";
import { CLI_USAGE, type CliCommand, parseCliArgs } from "./arguments.js";
import {
  type ImportAccountsDependencies,
  type ImportAccountsOptions,
  runImportAccounts,
} from "./import-accounts.js";
import { type LoginOptions, type LoginResult, runLogin } from "./login.js";
import { runAccountRefresh } from "./refresh-accounts.js";

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
  readonly runLogin: (config: Config, options: LoginOptions) => Promise<LoginResult>;
  readonly runAccountRefresh: (
    config: Config,
    options: { readonly identifier?: string },
  ) => Promise<AccountRefreshSummary>;
  readonly runImportAccounts: (
    options: ImportAccountsOptions,
    dependencies: ImportAccountsDependencies,
  ) => unknown;
  readonly openDb: (path: string) => AccountsStore;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
};

async function confirmOnTerminal(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

function sharedAuthError(config: Config): string | undefined {
  if (config.auth_source !== "opencode-shared") return undefined;
  return `auth_source=opencode-shared uses ${config.opencode_auth_db_path ?? defaultOpenCodeAuthDbPath()} as the authentication authority. Run "opencode auth login" and select Kiro, or set auth_source to "local" before using provider-owned account commands.`;
}

const defaultDependencies: CliDependencies = {
  loadConfig,
  startServer,
  runLogin,
  runAccountRefresh,
  runImportAccounts,
  openDb: (path) => new AccountsDatabase(path),
  confirm: confirmOnTerminal,
  stdout: console.log,
  stderr: console.error,
};

async function dispatch(command: CliCommand, dependencies: CliDependencies): Promise<number> {
  switch (command.kind) {
    case "help":
      dependencies.stdout(CLI_USAGE);
      return 0;
    case "serve": {
      const overrides: Partial<Config> = {
        ...(command.host ? { host: command.host } : {}),
        ...(command.port !== undefined ? { port: command.port } : {}),
        ...(command.proxy !== undefined ? { proxy_url: command.proxy } : {}),
      };
      const config = dependencies.loadConfig({
        ...(command.configPath ? { configPath: command.configPath } : {}),
        overrides,
      });
      setAuditLogLevel(config.log_level);
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
      setAuditLogLevel(config.log_level);
      const authError = sharedAuthError(config);
      if (authError) {
        dependencies.stderr(authError);
        return 1;
      }
      await dependencies.runLogin(config, {
        ...(command.startUrl ? { startUrl: command.startUrl } : {}),
        ...(command.region ? { region: command.region } : {}),
      });
      return 0;
    }
    case "accounts-list": {
      const database = dependencies.openDb(ACCOUNTS_DB_PATH);
      try {
        for (const line of formatAccountList(database.getAccounts(), command.mode)) {
          dependencies.stdout(line);
        }
      } finally {
        database.close();
      }
      return 0;
    }
    case "accounts-refresh": {
      const config = dependencies.loadConfig({
        ...(command.configPath ? { configPath: command.configPath } : {}),
      });
      setAuditLogLevel(config.log_level);
      const authError = sharedAuthError(config);
      if (authError) {
        dependencies.stderr(authError);
        return 1;
      }
      const summary = await dependencies.runAccountRefresh(config, {
        ...(command.identifier ? { identifier: command.identifier } : {}),
      });
      for (const line of formatAccountRefreshSummary(summary, command.json)) {
        dependencies.stdout(line);
      }
      return summary.failed === 0 ? 0 : 1;
    }
    case "accounts-relogin": {
      const config = dependencies.loadConfig({
        ...(command.configPath ? { configPath: command.configPath } : {}),
      });
      setAuditLogLevel(config.log_level);
      const authError = sharedAuthError(config);
      if (authError) {
        dependencies.stderr(authError);
        return 1;
      }
      const database = dependencies.openDb(ACCOUNTS_DB_PATH);
      let selected: StoredAccount;
      try {
        selected = resolveAccount(database.getAccounts(), command.identifier);
      } finally {
        database.close();
      }
      await dependencies.runLogin(config, {
        replaceAccount: selected,
        ...(command.startUrl ? { startUrl: command.startUrl } : {}),
        ...(command.region ? { region: command.region } : {}),
      });
      return 0;
    }
    case "accounts-import": {
      const database = dependencies.openDb(ACCOUNTS_DB_PATH);
      try {
        dependencies.runImportAccounts(
          {
            ...(command.from ? { from: command.from } : {}),
            force: command.force,
          },
          { database, stdout: dependencies.stdout },
        );
        dependencies.stderr(
          "Accounts imported into the provider-owned local database. kiro-provider will now refresh access tokens, usage, and account health independently.",
        );
      } finally {
        database.close();
      }
      return 0;
    }
    case "accounts-remove": {
      const database = dependencies.openDb(ACCOUNTS_DB_PATH);
      try {
        const account = resolveAccount(database.getAccounts(), command.identifier);
        if (!command.yes) {
          const confirmed = await dependencies.confirm(
            `Remove ${account.email} [${account.id}]? This also deletes its session affinity, output lineage, and reasoning replay state.`,
          );
          if (!confirmed) {
            dependencies.stderr(
              "Account removal cancelled. Use --yes for non-interactive confirmation.",
            );
            return 1;
          }
        }
        database.removeAccount(account.id);
        dependencies.stdout(`Removed account ${account.email} [${account.id}]`);
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
