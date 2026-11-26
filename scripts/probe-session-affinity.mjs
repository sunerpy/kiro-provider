// Real kiroclaude/kirocodex sessions against an isolated, synthetic HTTP gateway.
// Run: timeout 240s bun scripts/probe-session-affinity.mjs
// Use --family kiroclaude|kirocodex to inspect either launcher independently.
// Managed Claude endpoint/auth overrides fail before spawning the client.
// No production config, accounts, credentials, sessions, or upstreams are used.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/config/schema.ts";
import { AccountManager } from "../src/core/account-manager.ts";
import { setAuditLogLevel } from "../src/core/audit-log.ts";
import { acquireAccountQueue } from "../src/core/pipeline-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const claudeBinary = option("--claude-bin", "claude");
const codexBinary = option("--codex-bin", "codex");
const claudeLauncher = option(
  "--claude-launcher",
  fileURLToPath(new URL("./kiroclaude", import.meta.url)),
);
const codexLauncher = option("--codex-launcher", "kirocodex");
const familyFilter = option("--family", "");
if (familyFilter && !["kiroclaude", "kirocodex"].includes(familyFilter)) {
  console.log(JSON.stringify({ status: "fail", error_code: "invalid_family" }));
  process.exit(1);
}
const marker = "FIXTURE_AFFINITY_OK";
const root = await mkdtemp(join(tmpdir(), "kiro-session-affinity-"));
await chmod(root, 0o700);
const children = new Set();
const leases = new Set();
const servers = new Set();
const databases = new Set();
const tokenHelper = join(root, "fixture-token");
await writeFile(tokenHelper, "#!/bin/sh\nprintf '%s\\n' 'fixture-only'\n", { mode: 0o700 });
const fixtureConfig = join(root, "provider.json");
await writeFile(fixtureConfig, JSON.stringify({ api_keys: ["fixture-only"] }), { mode: 0o600 });
setAuditLogLevel("error");

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const requireCondition = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
const killGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

async function runProcess(binary, args, env, cwd) {
  // The child also owns a deadline if this probe itself is interrupted.
  const child = spawn("timeout", ["--signal=TERM", "--kill-after=3s", "40s", binary, ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  children.add(child);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGTERM");
  }, 40000);
  const hardDeadline = setTimeout(() => killGroup(child, "SIGKILL"), 44000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 8 * 1024 * 1024) killGroup(child, "SIGKILL");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8 * 1024 * 1024) killGroup(child, "SIGKILL");
  });
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...exit, stdout, stderr, timedOut };
  } finally {
    clearTimeout(deadline);
    clearTimeout(hardDeadline);
    killGroup(child, "SIGTERM");
    children.delete(child);
  }
}

function parseLines(text) {
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function checkClaudeManagedSettings() {
  // A system-managed transport/auth override outranks both --settings and the
  // private client environment. Never let this offline probe contact its target
  // or borrow the managed credentials; leave the policy untouched.
  const managedPath =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json";
  let managed;
  try {
    managed = JSON.parse(await readFile(managedPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw Object.assign(new Error("managed_settings_unreadable"), {
      code: "managed_settings_unreadable",
    });
  }
  const environment = managed?.env ?? {};
  requireCondition(!environment.ANTHROPIC_BASE_URL, "managed_endpoint_override");
  requireCondition(
    !managed.apiKeyHelper &&
      ![
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "BEDROCK_API_KEY",
      ].some((key) => environment[key]),
    "managed_auth_override",
  );
  requireCondition(
    ![
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_MANTLE",
    ].some((key) => environment[key] && environment[key] !== "0"),
    "managed_provider_override",
  );
}

function nativeEvents(model) {
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const item = {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }],
  };
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [item],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: marker,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: marker,
    },
    {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

async function runFamily(family) {
  const directory = join(root, family);
  const project = join(directory, "project");
  await mkdir(project, { recursive: true, mode: 0o700 });
  const databasePath = join(directory, "accounts.db");
  const prefix = randomUUID();
  const accounts = ["a", "b"].map((suffix, index) => ({
    id: `${prefix}-${suffix}`,
    email: `${suffix}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: `fixture-access-${suffix}`,
    refreshToken: `fixture-refresh-${suffix}`,
    expiresAt: Date.now() + 3600000,
    isHealthy: true,
    failCount: 0,
    rateLimitResetTime: 0,
    usedCount: index * 1000,
    limitCount: 100000,
  }));
  const config = ConfigSchema.parse({
    api_keys: ["fixture-only"],
    session_affinity_mode: "explicit-only",
    session_affinity_policy: "session-first",
    account_selection_strategy: "lowest-usage",
    account_inference_concurrency: 2,
    account_maintenance_enabled: false,
    request_timeout_ms: 15000,
    stream_idle_timeout_ms: 5000,
    rate_limit_max_retries: 0,
    retry_empty_completion: false,
    log_level: "error",
  });
  let database;
  let handler;
  let activeCase;
  let restarts = 0;
  let blockedExternalRequests = 0;
  const selected = [];
  const ingress = [];
  const failures = [];
  const restart = (initial = false) => {
    if (database) {
      database.close();
      databases.delete(database);
    }
    database = new AccountsDatabase(databasePath);
    databases.add(database);
    if (initial) for (const account of accounts) database.insertAccount(account);
    else restarts++;
    const accountManager = new AccountManager(database.getAccounts(), "lowest-usage", database);
    handler = createApp(config, {
      accountManager,
      affinityStore: database,
      tokenRefresher: {
        refreshIfNeeded: async (account) => account,
        forceRefresh: async (account) => account,
      },
      makeClient: (_auth, _region, _effort, _endpoint, _proxy, accountId) => ({
        async send() {
          selected.push({ stage: activeCase, accountId, lane: "canonical" });
          return {
            generateAssistantResponseResponse: {
              async *[Symbol.asyncIterator]() {
                yield { assistantResponseEvent: { content: marker } };
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
                  },
                };
              },
            },
          };
        },
      }),
      nativeResponsesFetch: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        const accountId = accounts.find(
          (account) => authorization === `Bearer ${account.accessToken}`,
        )?.id;
        requireCondition(accountId, "native_fixture_account_unknown");
        selected.push({ stage: activeCase, accountId, lane: "native" });
        const body = JSON.parse(String(init?.body));
        return new Response(
          nativeEvents(body.model)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
  };
  restart(true);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        blockedExternalRequests++;
        return new Response("Offline fixture", { status: 403 });
      }
      if (request.method === "POST" && ["/v1/messages", "/v1/responses"].includes(url.pathname)) {
        const body = await request.clone().json();
        const explicit =
          request.headers.get("x-claude-code-session-id") ||
          body.metadata?.zuno_session_id ||
          body.metadata?.kiro_provider_session_id ||
          body.client_metadata?.thread_id ||
          body.client_metadata?.session_id ||
          body.client_metadata?.conversation_id ||
          body.prompt_cache_key;
        ingress.push({
          stage: activeCase,
          identityHash: explicit ? digest(String(explicit)) : null,
        });
      }
      const response = await handler(request, server);
      if (response.status >= 400) {
        const body = await response
          .clone()
          .json()
          .catch(() => ({}));
        failures.push({
          status: response.status,
          code: body.error?.code ?? body.error?.type ?? null,
          param: body.error?.param ?? null,
        });
      }
      return response;
    },
  });
  servers.add(server);
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: "C.UTF-8",
    TERM: "dumb",
    XDG_CONFIG_HOME: join(directory, "xdg-config"),
    XDG_CACHE_HOME: join(directory, "xdg-cache"),
    XDG_DATA_HOME: join(directory, "xdg-data"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
    KIROCLAUDE_CLAUDE_BIN: claudeBinary,
    KIROCLAUDE_CONFIG_DIR: join(directory, "claude"),
    KIROCLAUDE_BASE_URL: baseUrl,
    KIROCLAUDE_TOKEN_HELPER: tokenHelper,
    KIROCLAUDE_PROVIDER_CONFIG: fixtureConfig,
    KIROCLAUDE_EFFORT: "high",
    CODEX_HOME: join(directory, "codex"),
    CODEX_ULTRA_MAX: "0",
    KIROCODEX_CODEX_BIN: codexBinary,
  };
  await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.KIROCLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const codexConfig = [
    "-c",
    `model_providers.kiro-local={name="Offline fixture",base_url="${baseUrl}/v1",wire_api="responses",auth={command="${tokenHelper}",timeout_ms=5000,refresh_interval_ms=300000},supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    'mcp_servers.google_search={command="/bin/true",enabled=false}',
  ];
  const invoke = async (stage, sessionId) => {
    activeCase = stage;
    const freshSessionId = randomUUID();
    const args =
      family === "kiroclaude"
        ? [
            "--bare",
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--system-prompt",
            "Synthetic offline affinity fixture.",
            "--model",
            "claude-opus-5-5",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            ...(sessionId ? ["--resume", sessionId] : ["--session-id", freshSessionId]),
            `Return ${marker} exactly.`,
          ]
        : [
            ...codexConfig,
            "exec",
            ...(sessionId ? ["resume", sessionId] : []),
            "--json",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            `Return ${marker} exactly.`,
          ];
    const result = await runProcess(
      family === "kiroclaude" ? claudeLauncher : codexLauncher,
      args,
      env,
      project,
    );
    const events = parseLines(result.stdout);
    const resolvedSessionId =
      family === "kiroclaude"
        ? events.find((event) => event.type === "system" && event.subtype === "init")?.session_id
        : events.find((event) => event.type === "thread.started")?.thread_id;
    const success =
      family === "kiroclaude"
        ? events.some(
            (event) =>
              event.type === "result" &&
              event.is_error === false &&
              event.result?.trim() === marker,
          )
        : events.some((event) => event.type === "turn.completed") &&
          events.some(
            (event) =>
              event.type === "item.completed" &&
              event.item?.type === "agent_message" &&
              event.item.text?.trim() === marker,
          );
    const stageSelections = selected.filter((entry) => entry.stage === stage);
    const stageIngress = ingress.filter((entry) => entry.stage === stage);
    const evidence = {
      family,
      stage,
      exit_code: result.code,
      timed_out: result.timedOut,
      success,
      stdout_bytes: Buffer.byteLength(result.stdout),
      stderr_bytes: Buffer.byteLength(result.stderr),
      stderr_argument: result.stderr.match(/unexpected argument '(--[a-z-]+)'/)?.[1] ?? null,
      stderr_missing_field: result.stderr.match(/missing field [`']([a-z_]+)[`']/)?.[1] ?? null,
      stderr_missing_path: /No such file|does not exist|not found|canonicalize/.test(result.stderr),
      generation_requests: stageIngress.length,
      explicit_session_requests: stageIngress.filter((entry) => entry.identityHash !== null).length,
      sdk_dispatches: stageSelections.length,
      client_event_types: [...new Set(events.map((event) => event.type))],
      client_init_model:
        events.find((event) => event.type === "system" && event.subtype === "init")?.model ?? null,
      client_init_auth_source:
        events.find((event) => event.type === "system" && event.subtype === "init")?.apiKeySource ??
        null,
      lanes: [...new Set(stageSelections.map((entry) => entry.lane))],
      error_statuses: failures.map((entry) => entry.status),
      error_codes: failures.map((entry) => entry.code),
      error_params: failures.map((entry) => entry.param),
    };
    console.log(JSON.stringify(evidence));
    requireCondition(result.code === 0 && !result.timedOut && success, "client_turn_failed");
    requireCondition(
      resolvedSessionId && (!sessionId || resolvedSessionId === sessionId),
      "client_session_identity_changed",
    );
    requireCondition(stageSelections.length > 0, "client_dispatch_missing");
    requireCondition(
      stageIngress.length > 0 && stageIngress.every((entry) => entry.identityHash !== null),
      "explicit_client_session_missing",
    );
    return {
      sessionId: resolvedSessionId,
      selections: stageSelections,
      identityHash: stageIngress[0].identityHash,
    };
  };
  const hold = async (accountId) => {
    const release = await acquireAccountQueue(accountId, AbortSignal.timeout(45000), 2);
    leases.add(release);
    return () => {
      release();
      leases.delete(release);
    };
  };
  try {
    const first = await invoke("first-bootstrap");
    const firstAccount = first.selections[0].accountId;
    requireCondition(
      first.selections.every((entry) => entry.accountId === firstAccount),
      "bootstrap_account_changed",
    );
    const releaseFirst = await hold(firstAccount);
    let second;
    try {
      second = await invoke("second-bootstrap");
    } finally {
      releaseFirst();
    }
    const secondAccount = second.selections[0].accountId;
    requireCondition(firstAccount !== secondAccount, "new_sessions_not_distributed");
    requireCondition(
      first.sessionId !== second.sessionId && first.identityHash !== second.identityHash,
      "independent_sessions_collapsed",
    );
    restart();
    for (const [stage, initial, owner] of [
      ["first-resume", first, firstAccount],
      ["second-resume", second, secondAccount],
    ]) {
      const release = await hold(owner);
      try {
        const resumed = await invoke(stage, initial.sessionId);
        requireCondition(
          resumed.identityHash === initial.identityHash,
          "resume_affinity_identity_changed",
        );
        requireCondition(
          resumed.selections.every((entry) => entry.accountId === owner),
          "session_owner_changed_under_light_load",
        );
      } finally {
        release();
      }
    }
    requireCondition(blockedExternalRequests === 0, "external_client_request_blocked");
    console.log(
      JSON.stringify({
        family,
        status: "pass",
        independent_sessions: 2,
        resumed_sessions: 2,
        runtime_restarts: restarts,
        persisted_affinity: true,
        light_load_owner_preserved: true,
        real_upstream_requests: 0,
        blocked_external_requests: blockedExternalRequests,
      }),
    );
  } finally {
    server.stop(true);
    servers.delete(server);
    database.close();
    databases.delete(database);
  }
}

try {
  for (const [family, binary] of [
    ["kiroclaude", claudeBinary],
    ["kirocodex", codexBinary],
  ]) {
    if (familyFilter && family !== familyFilter) continue;
    try {
      if (family === "kiroclaude") await checkClaudeManagedSettings();
      const version = await runProcess(
        binary,
        ["--version"],
        { PATH: process.env.PATH, HOME: process.env.HOME },
        root,
      );
      console.log(
        JSON.stringify({ family, version: version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null }),
      );
      await runFamily(family);
    } catch (error) {
      console.log(
        JSON.stringify({
          family,
          status: "fail",
          error_code: typeof error?.code === "string" ? error.code : "probe_failed",
          error_type: error?.name ?? "Error",
        }),
      );
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.log(
    JSON.stringify({
      status: "fail",
      error_code: typeof error?.code === "string" ? error.code : "probe_failed",
      error_type: error?.name ?? "Error",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const release of leases) release();
  for (const server of servers) server.stop(true);
  for (const database of databases) database.close();
  for (const child of children) killGroup(child, "SIGKILL");
  await rm(root, { recursive: true, force: true });
}
