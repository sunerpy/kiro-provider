import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const binaryPath =
  process.env.KIRO_PROVIDER_E2E_BINARY ?? join(process.cwd(), "dist", "kiro-provider");
const sourceDbPath =
  process.env.KIRO_PROVIDER_E2E_SOURCE_DB ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
    "opencode",
    "kiro.db",
  );
const sdkRoot = requireEnvironment(
  "KIRO_PROVIDER_E2E_OPENAI_SDK_DIR",
  "the directory whose node_modules/openai holds the OpenAI JavaScript SDK (7.x) used for the Responses turns",
);
const keepArtifacts = process.env.KIRO_PROVIDER_E2E_KEEP === "1";
const staleAccessToken = "kiro-provider-local-auth-e2e-stale-access";

type ImportedAccount = {
  readonly id: string;
  readonly generation: number;
};

type LocalAccountState = {
  readonly accountCount: number;
  readonly generation: number;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly lastSync: number;
};

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function requireEnvironment(name: string, purpose: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required (no default): set it to ${purpose}`);
  }
  return value;
}

function childEnvironment(configRoot: string, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
  };
}

async function runCommand(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let exitCode = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => undefined)]);
  if (exitCode === undefined) {
    child.kill(9);
    exitCode = await child.exited;
    throw new Error(`Command timed out after ${timeoutMs}ms: ${command[0] ?? "unknown"}`);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command[0] ?? "unknown"}\n${stderr}`);
  }
  return { stdout, stderr };
}

function selectImportedAccount(databasePath: string): ImportedAccount {
  const database = new Database(databasePath, { strict: true });
  try {
    const selected = database
      .query<ImportedAccount, []>(`
				SELECT id, generation
				FROM accounts
				WHERE refresh_token <> ''
				  AND is_healthy = 1
				  AND COALESCE(overage_count, 0) <= 0
				  AND (
				    COALESCE(limit_count, 0) <= 0
				    OR COALESCE(used_count, 0) < COALESCE(limit_count, 0)
				  )
				ORDER BY expires_at DESC, id ASC
				LIMIT 1
			`)
      .get();
    if (!selected) {
      throw new Error("No healthy, non-exhausted imported Kiro account is available");
    }
    database.run("DELETE FROM accounts WHERE id <> ?", [selected.id]);
    database.run("DELETE FROM removed_accounts");
    database.run(
      `UPDATE accounts
			 SET access_token = ?,
			     expires_at = 0,
			     rate_limit_reset = 0,
			     is_healthy = 1,
			     unhealthy_reason = NULL,
			     recovery_time = NULL,
			     fail_count = 0,
			     used_count = 0,
			     limit_count = 1000000,
			     overage_count = 0,
			     last_sync = 0
			 WHERE id = ?`,
      [staleAccessToken, selected.id],
    );
    return selected;
  } finally {
    database.close();
  }
}

function readLocalAccountState(databasePath: string): LocalAccountState {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const count = database
      .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM accounts")
      .get();
    const row = database
      .query<
        {
          readonly generation: number;
          readonly access_token: string;
          readonly expires_at: number;
          readonly last_sync: number;
        },
        []
      >("SELECT generation, access_token, expires_at, last_sync FROM accounts LIMIT 1")
      .get();
    if (!count || !row) throw new Error("Local authentication database is empty");
    return {
      accountCount: count.count,
      generation: row.generation,
      accessToken: row.access_token,
      expiresAt: row.expires_at,
      lastSync: row.last_sync,
    };
  } finally {
    database.close();
  }
}

async function allocatePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = server.port;
  server.stop(true);
  if (port === undefined) {
    throw new Error("Failed to allocate an ephemeral port");
  }
  return port;
}

async function waitFor(
  label: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.name}: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function runOpenAiResponses(baseURL: string, apiKey: string): Promise<void> {
  const modulePath = join(sdkRoot, "node_modules", "openai", "index.mjs");
  requireFile(modulePath, "OpenAI JavaScript SDK");
  const imported = await import(pathToFileURL(modulePath).href);
  const OpenAI = imported.default;
  if (typeof OpenAI !== "function") {
    throw new TypeError("OpenAI JavaScript SDK default export is unavailable");
  }
  const client = new OpenAI({
    baseURL,
    apiKey,
    maxRetries: 0,
    timeout: 120_000,
  });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const firstMarker = `LOCAL_AUTH_FIRST_${suffix}`;
  const secondMarker = `LOCAL_AUTH_SECOND_${suffix}`;
  const sessionId = `local-auth-e2e-${suffix.toLowerCase()}`;

  const first = await client.responses.create({
    model: "claude-opus-5-low",
    input: `Reply with exactly ${firstMarker}`,
    max_output_tokens: 1_024,
    metadata: { kiro_provider_session_id: sessionId },
  });
  if (typeof first.output_text !== "string" || !first.output_text.includes(firstMarker)) {
    throw new Error("Official SDK first Responses turn did not return its marker");
  }

  const second = await client.responses.create({
    model: "claude-opus-5-low",
    input: `Reply with exactly ${secondMarker}`,
    max_output_tokens: 1_024,
    metadata: { kiro_provider_session_id: sessionId },
  });
  if (typeof second.output_text !== "string" || !second.output_text.includes(secondMarker)) {
    throw new Error("Official SDK continuation did not return its marker");
  }
}

async function runOpenCodeToolLoop(
  rootURL: string,
  apiKey: string,
  temporaryRoot: string,
): Promise<void> {
  const opencode = process.env.KIRO_PROVIDER_E2E_OPENCODE ?? "opencode";
  const configRoot = join(temporaryRoot, "opencode-config");
  const dataRoot = join(temporaryRoot, "opencode-data");
  const cacheRoot = join(temporaryRoot, "opencode-cache");
  const home = join(temporaryRoot, "opencode-home");
  const project = join(temporaryRoot, "opencode-project");
  const configDirectory = join(configRoot, "opencode");
  const marker = "OPENCODE_LOCAL_AUTH_TOOL_OK";
  const artifact = join(project, "local-auth-tool.txt");
  for (const directory of [configDirectory, dataRoot, cacheRoot, home, project]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(configDirectory, "opencode.json"),
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          "kiro-local-e2e": {
            name: "Kiro Provider Local Auth E2E",
            npm: "@ai-sdk/openai",
            options: {
              apiKey,
              baseURL: `${rootURL}/v1`,
              timeout: 180_000,
            },
            models: {
              "claude-opus-5-max": {
                name: "Claude Opus 5 Max",
                limit: { context: 1_000_000, output: 128_000 },
                reasoning: true,
                tool_call: true,
                options: { reasoningEffort: "max" },
              },
            },
          },
        },
        permission: {
          bash: "allow",
          read: "allow",
          write: "allow",
          edit: "allow",
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const result = await runCommand(
    [
      opencode,
      "run",
      "--pure",
      "--format",
      "json",
      "--model",
      "kiro-local-e2e/claude-opus-5-max",
      "--variant",
      "max",
      "--dir",
      project,
      `Use the bash tool to write exactly ${marker} with no trailing newline to local-auth-tool.txt, use the read tool to verify it, then reply with exactly ${marker}.`,
    ],
    {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      XDG_CACHE_HOME: cacheRoot,
    },
    240_000,
  );
  if (!result.stdout.includes(marker)) {
    throw new Error("OpenCode output did not contain the expected tool-loop marker");
  }
  if (!existsSync(artifact) || readFileSync(artifact, "utf8") !== marker) {
    throw new Error("OpenCode tool loop did not create the exact expected artifact");
  }
}

async function main(): Promise<void> {
  requireFile(binaryPath, "Compiled kiro-provider binary");
  requireFile(sourceDbPath, "OpenCode Kiro source database");

  const temporaryRoot = mkdtempSync(join(tmpdir(), "kiro-provider-local-auth-e2e-"));
  const home = join(temporaryRoot, "home");
  const configRoot = join(temporaryRoot, "xdg");
  const providerConfigDirectory = join(configRoot, "kiro-provider");
  const configPath = join(providerConfigDirectory, "config.json");
  const localDatabasePath = join(providerConfigDirectory, "accounts.db");
  const logPath = join(temporaryRoot, "provider.stderr.log");
  const tracePath = join(temporaryRoot, "provider.open.trace");
  const apiKey = `sk-e2e-${randomBytes(24).toString("hex")}`;
  let provider: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let providerStderr: Promise<string> | undefined;
  let providerStdout: Promise<string> | undefined;

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(providerConfigDirectory, { recursive: true });
    const port = await allocatePort();
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          host: "127.0.0.1",
          port,
          api_keys: [apiKey],
          auth_source: "local",
          opencode_auth_db_path: join(temporaryRoot, "missing-opencode-database.db"),
          protocol_projection_mode: "legacy-user-prefix",
          session_affinity_mode: "explicit-only",
          enable_legacy_chat_completions: false,
          enforce_single_instance: true,
          dynamic_model_catalog: true,
          account_selection_strategy: "lowest-usage",
          account_maintenance_enabled: true,
          account_maintenance_interval_ms: 1_000,
          account_maintenance_timeout_ms: 30_000,
          account_maintenance_concurrency: 1,
          usage_refresh_interval_ms: 1_000,
          quota_recheck_interval_ms: 1_000,
          quota_recheck_timeout_ms: 10_000,
          quota_recheck_concurrency: 1,
          request_timeout_ms: 120_000,
          stream_idle_timeout_ms: 60_000,
          log_level: "info",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const environment = childEnvironment(configRoot, home);
    await runCommand([binaryPath, "accounts", "import", "--from", sourceDbPath], environment);
    const imported = selectImportedAccount(localDatabasePath);
    const initialState = readLocalAccountState(localDatabasePath);
    if (initialState.accountCount !== 1 || initialState.accessToken !== staleAccessToken) {
      throw new Error("Isolated local authentication fixture was not prepared");
    }

    const useStrace =
      process.env.KIRO_PROVIDER_E2E_STRACE === "1" &&
      process.platform === "linux" &&
      existsSync("/usr/bin/strace");
    const command = useStrace
      ? [
          "/usr/bin/strace",
          "-f",
          "-e",
          "trace=openat,openat2",
          "-o",
          tracePath,
          binaryPath,
          "serve",
          "--config",
          configPath,
        ]
      : [binaryPath, "serve", "--config", configPath];
    provider = Bun.spawn(command, {
      cwd: process.cwd(),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    providerStdout = new Response(provider.stdout).text();
    providerStderr = new Response(provider.stderr).text();

    const rootURL = `http://127.0.0.1:${port}`;
    await waitFor("provider health", async () => {
      const response = await fetch(`${rootURL}/health`);
      return response.ok;
    });
    await waitFor("provider readiness", async () => {
      const response = await fetch(`${rootURL}/ready`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok;
    });
    await waitFor("autonomous token and usage refresh", () => {
      const state = readLocalAccountState(localDatabasePath);
      return (
        state.accountCount === 1 &&
        state.generation > imported.generation &&
        state.accessToken !== staleAccessToken &&
        state.expiresAt > Date.now() + 60_000 &&
        state.lastSync > 0
      );
    });

    await runOpenAiResponses(`${rootURL}/v1`, apiKey);
    await runOpenCodeToolLoop(rootURL, apiKey, temporaryRoot);

    provider.kill(15);
    let exitCode = await Promise.race([provider.exited, Bun.sleep(5_000).then(() => undefined)]);
    if (exitCode === undefined) {
      provider.kill(9);
      exitCode = await provider.exited;
    }
    if (exitCode !== 0 && exitCode !== 143) {
      throw new Error(`Provider exited with unexpected code ${exitCode}`);
    }
    const [stdout, stderr] = await Promise.all([providerStdout, providerStderr]);
    writeFileSync(logPath, stderr, { encoding: "utf8", mode: 0o600 });
    if (!stdout.includes("Listening on http://127.0.0.1:")) {
      throw new Error("Compiled service did not report its listening address");
    }
    for (const event of [
      "account_maintenance_started",
      "account_maintenance_pass_completed",
      "usage_refresh_batch_completed",
      "sdk_connection_pool_selected",
    ]) {
      if (!stderr.includes(`"event":"${event}"`)) {
        throw new Error(`Provider log omitted ${event}`);
      }
    }
    if (!stderr.includes('"token_due_count":1') || !stderr.includes('"token_refreshed_count":1')) {
      throw new Error("Background maintenance did not report one refreshed token");
    }
    if (stderr.includes(staleAccessToken) || stderr.includes(apiKey)) {
      throw new Error("Provider log exposed a credential marker");
    }
    if (useStrace) {
      const trace = readFileSync(tracePath, "utf8");
      if (!trace.includes(localDatabasePath)) {
        throw new Error("Open trace did not contain the provider-owned database");
      }
      if (
        trace.includes(sourceDbPath) ||
        trace.includes("/opencode/kiro.db") ||
        trace.includes("missing-opencode-database.db")
      ) {
        throw new Error("Local-mode service opened an OpenCode authentication database");
      }
    }

    const finalState = readLocalAccountState(localDatabasePath);
    console.log(
      JSON.stringify({
        result: "LOCAL_AUTH_MAINTENANCE_E2E_OK",
        compiled_binary: binaryPath,
        imported_account_count: 1,
        token_refreshed: finalState.accessToken !== staleAccessToken,
        usage_refreshed: finalState.lastSync > 0,
        official_openai_sdk: "7.5.0",
        responses_turns: 2,
        opencode_tool_loop: true,
        protocol_projection_mode: "legacy-user-prefix",
        missing_shared_db_runtime_succeeded: true,
        runtime_opened_opencode_db: useStrace ? false : "not_traced",
        strace_verified: useStrace,
      }),
    );
  } finally {
    if (provider && provider.exitCode === null) {
      provider.kill(9);
      await provider.exited.catch(() => undefined);
    }
    if (!keepArtifacts) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      console.error(`E2E artifacts retained at ${temporaryRoot}`);
    }
  }
}

await main();
process.exit(0);
