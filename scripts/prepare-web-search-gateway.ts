/**
 * Prepares an isolated gateway state for live hosted web search validation.
 *
 *   bun run scripts/prepare-web-search-gateway.ts --state /tmp/kws-live --port 18879 \
 *     [--accounts-db <production accounts.db>] [--proxy http://127.0.0.1:1080] \
 *     [--min-token-minutes 45]
 *
 * The production account store is opened read-only. Healthy us-east-1
 * accounts whose access token stays valid long enough are copied into a fresh
 * Accounts DB under `<state>/xdg/kiro-provider/`, with every refresh token
 * replaced by a placeholder: the isolated gateway can use the current access
 * tokens but can never rotate production credentials. A new reasoning replay
 * keyring, a random probe API key and a config with `web_search_enabled` on and
 * account maintenance off are written next to it. Nothing secret is printed.
 *
 * Start the gateway with `XDG_CONFIG_HOME=<state>/xdg` and
 * `serve --config <state>/xdg/kiro-provider/config.json`.
 *
 * `--refresh-existing` copies only the current access tokens of the same
 * accounts into an already prepared state (stop its gateway first), so a long
 * session keeps its isolated search snapshots across token lifetimes.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const REFRESH_PLACEHOLDER = "isolated-snapshot-refresh-disabled";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fail(code: string): never {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exit(1);
}

interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly auth_method: string;
  readonly region: string;
  readonly oidc_region: string | null;
  readonly client_id: string | null;
  readonly client_secret: string | null;
  readonly profile_arn: string;
  readonly start_url: string | null;
  readonly access_token: string;
  readonly expires_at: number;
}

function main(): void {
  const repository = resolve(import.meta.dir, "..");
  const productionRoot = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "kiro-provider",
  );
  const state = option("--state");
  if (!state) fail("state_required");
  const stateRoot = resolve(state);
  if (stateRoot.startsWith(`${repository}/`) || stateRoot === repository) {
    fail("state_must_be_outside_repository");
  }
  const target = join(stateRoot, "xdg", "kiro-provider");
  if (resolve(target) === resolve(productionRoot)) fail("state_must_not_be_production");
  const refreshExisting = process.argv.includes("--refresh-existing");
  if (refreshExisting !== existsSync(join(target, "accounts.db"))) {
    fail(refreshExisting ? "state_not_prepared" : "state_already_prepared");
  }
  const port = Number(option("--port") ?? "18879");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787) {
    fail("isolated_port_required");
  }
  const minimumMs = Number(option("--min-token-minutes") ?? "45") * 60_000;
  const source = new Database(option("--accounts-db") ?? join(productionRoot, "accounts.db"), {
    readonly: true,
  });
  const now = Date.now();
  const rows = source
    .query<AccountRow, [number, number]>(
      `SELECT id, email, auth_method, region, oidc_region, client_id, client_secret,
              profile_arn, start_url, access_token, expires_at
         FROM accounts
        WHERE is_healthy = 1 AND expires_at > ? AND COALESCE(rate_limit_reset, 0) < ?
          AND profile_arn LIKE 'arn:aws:codewhisperer:us-east-1:%'
        ORDER BY used_count ASC`,
    )
    .all(now + minimumMs, now);
  source.close();
  if (rows.length === 0) fail("no_account_with_enough_token_lifetime");
  if (refreshExisting) {
    const sqlite = new Database(join(target, "accounts.db"));
    const update = sqlite.query(
      `UPDATE accounts SET access_token = ?, expires_at = ?, is_healthy = 1,
         unhealthy_reason = NULL, fail_count = 0, generation = generation + 1
       WHERE id = ? AND refresh_token = ?`,
    );
    let refreshed = 0;
    for (const row of rows) {
      refreshed += update.run(
        row.access_token,
        row.expires_at,
        row.id,
        REFRESH_PLACEHOLDER,
      ).changes;
    }
    sqlite.close();
    process.stdout.write(
      `${JSON.stringify({
        ok: refreshed > 0,
        refreshed_accounts: refreshed,
        min_token_remaining_minutes: Math.floor(
          (Math.min(...rows.map((row) => row.expires_at)) - now) / 60_000,
        ),
      })}\n`,
    );
    return;
  }

  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  const database = new AccountsDatabase(join(target, "accounts.db"));
  const sqlite = new Database(join(target, "accounts.db"));
  const insert = sqlite.query(
    `INSERT INTO accounts (id, email, auth_method, region, oidc_region, client_id, client_secret,
       profile_arn, start_url, refresh_token, access_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.email,
      row.auth_method,
      row.region,
      row.oidc_region,
      row.client_id,
      row.client_secret,
      row.profile_arn,
      row.start_url,
      REFRESH_PLACEHOLDER,
      row.access_token,
      row.expires_at,
    );
  }
  sqlite.close();
  database.close();

  const apiKey = `sk-kws-probe-${randomBytes(16).toString("hex")}`;
  const proxy = option("--proxy");
  const config = {
    host: "127.0.0.1",
    port,
    api_keys: [apiKey],
    protocol_projection_mode: "v3-auto",
    session_affinity_mode: "explicit-only",
    request_timeout_ms: 900_000,
    stream_idle_timeout_ms: 300_000,
    // The snapshot's access tokens are used until shortly before expiry; a
    // refresh attempt fails on the placeholder instead of rotating production.
    token_expiry_buffer_ms: 60_000,
    account_maintenance_enabled: false,
    reasoning_replay_key_path: join(target, "reasoning-replay-keys.json"),
    instance_lock_path: join(target, "service.instance"),
    web_search_enabled: true,
    ...(proxy ? { proxy_url: proxy } : {}),
  };
  writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      config: join(target, "config.json"),
      xdg_config_home: join(stateRoot, "xdg"),
      port,
      account_count: rows.length,
      min_token_remaining_minutes: Math.floor(
        (Math.min(...rows.map((row) => row.expires_at)) - now) / 60_000,
      ),
    })}\n`,
  );
}

main();
