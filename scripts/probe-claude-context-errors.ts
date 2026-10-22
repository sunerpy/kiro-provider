/**
 * Installed Claude -> isolated Messages provider -> synthetic SDK error gate.
 * CLAUDE_PROBE_BINARY=/absolute/path/to/claude bun scripts/probe-claude-context-errors.ts
 * Requires bubblewrap. Every request and session is synthetic; the provider is
 * in a private network namespace with an in-memory database. Existing sessions,
 * services and credentials remain untouched. Evidence contains counts/enums only.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

type JsonRecord = Record<string, unknown>;
type Scenario = "context-overflow" | "body-overflow" | "compact-recovery";
const KEY = "synthetic-claude-context-key";
const ACK = "SYNTHETIC_COMPACT_SUMMARY_OK";
const MODEL = "claude-opus-5-5";

function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

function record(value: unknown): JsonRecord {
  requireCondition(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "fixture_record_required",
  );
  return value as JsonRecord;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function fixtureSession(configDir: string, project: string, version: string): string {
  const session = randomUUID();
  const common = {
    sessionId: session,
    cwd: project,
    isSidechain: false,
    version,
    timestamp: new Date().toISOString(),
  };
  const history: JsonRecord[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 8; index++) {
    const user = randomUUID();
    const assistant = randomUUID();
    history.push(
      {
        ...common,
        type: "user",
        uuid: user,
        parentUuid: parent,
        message: {
          role: "user",
          content: `Synthetic history round ${index}. ${"fixture ".repeat(80)}`,
        },
      },
      {
        ...common,
        type: "assistant",
        uuid: assistant,
        parentUuid: user,
        message: {
          id: `synthetic-message-${index}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: `Synthetic reply ${index}.` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 40, output_tokens: 8 },
        },
      },
    );
    parent = assistant;
  }
  const directory = join(configDir, "projects", project.replace(/[^A-Za-z0-9-]/g, "-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${session}.jsonl`),
    `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600 },
  );
  return session;
}

async function run(binary: string, root: string, version: string, scenario: Scenario) {
  const config = ConfigSchema.parse({
    api_keys: [KEY],
    max_request_body_bytes: scenario === "body-overflow" ? 128 : 33_554_432,
    request_timeout_ms: 10_000,
    stream_idle_timeout_ms: 5_000,
    rate_limit_max_retries: 0,
    stream_max_attempts: 1,
    anthropic_thinking_display_mode: "omitted",
  });
  const database = new AccountsDatabase(":memory:");
  const account: ManagedAccount = {
    id: randomUUID(),
    email: "fixture@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    expiresAt: Date.now() + 3_600_000,
    isHealthy: true,
    rateLimitResetTime: 0,
    failCount: 0,
  };
  const sdk: Array<{ history_messages: number; input_chars: number }> = [];
  let iteratorClosed = 0;
  const dependencies: AppDependencies = {
    accountManager: {
      reconcileFromDb: () => [account],
      selectHealthyAccount: () => account,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        access: account.accessToken,
        refresh: account.refreshToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
        profileArn: account.profileArn,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: { refreshIfNeeded: async () => account, forceRefresh: async () => account },
    affinityStore: database,
    makeClient: () => ({
      async send(command) {
        const state = command.input.conversationState;
        sdk.push({
          history_messages: state?.history?.length ?? 0,
          input_chars: JSON.stringify(state).length,
        });
        if (scenario !== "compact-recovery" || sdk.length <= 2) {
          throw Object.assign(new Error("Input is too long"), {
            name: "ValidationException",
            reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
            $metadata: { httpStatusCode: 400 },
          });
        }
        const events: SdkStreamEvent[] = [
          { assistantResponseEvent: { content: ACK } },
          { metadataEvent: { tokenUsage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } } },
        ];
        return {
          generateAssistantResponseResponse: (async function* () {
            try {
              yield* events;
            } finally {
              iteratorClosed += 1;
            }
          })(),
        };
      },
    }),
  };
  const app = createApp(config, dependencies);
  const requests: Array<{
    body_bytes: number;
    messages: number;
    status: number;
    error_type: string | null;
    context_prefix: boolean;
    sdk_dispatches: number;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 8787,
    idleTimeout: 0,
    async fetch(request, bunServer) {
      if (new URL(request.url).pathname !== "/v1/messages") return app(request, bunServer);
      const raw = Buffer.from(await request.arrayBuffer());
      const encoded = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      const body = record(JSON.parse(encoded.toString("utf8")));
      const row = {
        body_bytes: encoded.byteLength,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        status: 0,
        error_type: null as string | null,
        context_prefix: false,
        sdk_dispatches: 0,
      };
      requests.push(row);
      const beforeDispatch = sdk.length;
      const response = await app(
        new Request(request.url, {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: encoded,
          signal: request.signal,
        }),
        bunServer,
      );
      row.status = response.status;
      row.sdk_dispatches = sdk.length - beforeDispatch;
      if (!response.ok) {
        const error = record(record(await response.clone().json()).error);
        row.error_type = typeof error.type === "string" ? error.type : null;
        row.context_prefix =
          typeof error.message === "string" && error.message.startsWith("Prompt is too long");
      }
      return response;
    },
  });
  const project = join(root, "project");
  const configDir = join(root, scenario);
  mkdirSync(configDir, { recursive: true });
  const session =
    scenario === "compact-recovery" ? fixtureSession(configDir, project, version) : undefined;
  const child = Bun.spawn(
    [
      binary,
      "--bare",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
      "--tools",
      "",
      "--max-turns",
      "1",
      "--system-prompt",
      "Synthetic isolated protocol check.",
      "--model",
      MODEL,
      "--effort",
      "high",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      ...(session ? ["--resume", session, "--fork-session"] : []),
      scenario === "compact-recovery" ? "/compact" : "Return the synthetic fixture marker.",
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_AUTH_TOKEN: "",
        ANTHROPIC_CUSTOM_HEADERS: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_AUTOUPDATER: "1",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(9), 40_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const events = stdout.split("\n").flatMap((line) => {
      try {
        return [record(JSON.parse(line))];
      } catch {
        return [];
      }
    });
    const result = events.findLast((event) => event.type === "result");
    const visible =
      events
        .filter((event) => event.type === "assistant")
        .flatMap((event) => {
          const content = record(event.message).content;
          return Array.isArray(content)
            ? content.flatMap((part) =>
                record(part).type === "text" ? [String(record(part).text)] : [],
              )
            : [];
        })
        .join("\n") + String(result?.result ?? "");
    const row = {
      case: scenario,
      exit_code: exitCode,
      client_error: result?.is_error === true,
      client_context_error: visible.includes("Prompt is too long"),
      client_size_error: visible.includes("Request too large (max 32MB)"),
      compact_marker:
        visible.includes(ACK) ||
        events.some(
          (event) => event.type === "user" && JSON.stringify(event.message).includes(ACK),
        ),
      compact_boundary_count: events.filter(
        (event) => event.type === "system" && event.subtype === "compact_boundary",
      ).length,
      client_result_success: result?.is_error === false,
      client_result_subtype: typeof result?.subtype === "string" ? result.subtype : null,
      client_event_types: Object.fromEntries(
        [...new Set(events.map((event) => String(event.type)))].map((type) => [
          type,
          events.filter((event) => event.type === type).length,
        ]),
      ),
      stderr_bytes: Buffer.byteLength(stderr),
      requests,
      sdk,
      iterator_closed: iteratorClosed,
    };
    if (scenario === "body-overflow") {
      requireCondition(
        requests.length > 0 &&
          requests.every((request) => request.status === 413) &&
          sdk.length === 0 &&
          row.client_size_error &&
          !row.client_context_error,
        `case_failed:${scenario}:${JSON.stringify(row)}`,
      );
    } else if (scenario === "context-overflow") {
      requireCondition(
        sdk.length > 0 &&
          requests
            .filter((request) => request.sdk_dispatches > 0)
            .every(
              (request) =>
                request.status === 400 &&
                request.error_type === "invalid_request_error" &&
                request.context_prefix,
            ) &&
          row.client_context_error &&
          !row.client_size_error,
        `case_failed:${scenario}:${JSON.stringify(row)}`,
      );
    } else {
      requireCondition(
        sdk.length === 3 &&
          (sdk[0]?.history_messages ?? 0) > (sdk[1]?.history_messages ?? 0) &&
          (sdk[1]?.history_messages ?? 0) > (sdk[2]?.history_messages ?? 0) &&
          row.compact_marker &&
          row.compact_boundary_count === 1 &&
          row.client_result_success &&
          exitCode === 0 &&
          iteratorClosed === 1 &&
          requests.at(-1)?.status === 200 &&
          !row.client_size_error,
        `case_failed:${scenario}:${JSON.stringify(row)}`,
      );
    }
    return { ...row, passed: true };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill(9);
      await child.exited;
    }
    await server.stop(true);
    database.close();
  }
}

async function main(): Promise<void> {
  const binary = resolve(
    option("--claude-bin") ?? process.env.CLAUDE_PROBE_BINARY ?? Bun.which("claude") ?? "claude",
  );
  const parentNamespace = process.env.CLAUDE_CONTEXT_PROBE_PARENT_NETNS;
  if (!parentNamespace) {
    const root = mkdtempSync(join(tmpdir(), "kiro-claude-context-"));
    chmodSync(root, 0o700);
    const helper = join(root, "key.sh");
    writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' '${KEY}'\n`, { mode: 0o700 });
    const policyPath = "/etc/claude-code/managed-settings.json";
    const policy = existsSync(policyPath)
      ? record(JSON.parse(readFileSync(policyPath, "utf8")))
      : {};
    const policyCopy = join(root, "managed-settings.json");
    writeFileSync(
      policyCopy,
      JSON.stringify({
        ...policy,
        apiKeyHelper: helper,
        env: {
          ...record(policy.env ?? {}),
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_CUSTOM_HEADERS: "",
          CLAUDE_CODE_USE_BEDROCK: "0",
          CLAUDE_CODE_USE_VERTEX: "0",
          CLAUDE_CODE_USE_FOUNDRY: "0",
          CLAUDE_CODE_USE_MANTLE: "0",
        },
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(root, "cache"));
    mkdirSync(join(root, "project"));
    const evidencePath = join(root, "evidence.json");
    try {
      const child = Bun.spawn(
        [
          "bwrap",
          "--die-with-parent",
          "--ro-bind",
          "/",
          "/",
          "--dev-bind",
          "/dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-net",
          "--bind",
          root,
          root,
          "--ro-bind",
          policyCopy,
          policyPath,
          Bun.which("bun") ?? "bun",
          resolve(import.meta.filename),
          "--claude-bin",
          binary,
          "--work-root",
          root,
        ],
        {
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            CLAUDE_CONTEXT_PROBE_PARENT_NETNS: readlinkSync("/proc/self/ns/net"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      requireCondition(
        existsSync(evidencePath),
        `isolated_probe_no_evidence:${exitCode}:${Buffer.byteLength(stdout)}:${Buffer.byteLength(stderr)}:${stderr.match(/case_failed:[a-z-]+/)?.[0] ?? "startup"}`,
      );
      console.log(readFileSync(evidencePath, "utf8"));
      requireCondition(exitCode === 0, "isolated_probe_failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  requireCondition(
    readlinkSync("/proc/self/ns/net") !== parentNamespace,
    "private_network_namespace_required",
  );
  const root = option("--work-root");
  requireCondition(
    typeof root === "string" && root.startsWith(`${tmpdir()}/kiro-claude-context-`),
    "temporary_work_root_required",
  );
  const version = Bun.spawnSync([binary, "--version"])
    .stdout.toString()
    .match(/\d+\.\d+\.\d+/)?.[0];
  requireCondition(version, "client_version_required");
  const originalError = console.error;
  console.error = () => {};
  const runs: unknown[] = [];
  try {
    for (const scenario of ["context-overflow", "body-overflow", "compact-recovery"] as const) {
      try {
        runs.push(await run(binary, root, version, scenario));
      } catch (error) {
        writeFileSync(
          join(root, "evidence.json"),
          JSON.stringify({
            schema_version: 1,
            client_version: version,
            private_network_namespace: true,
            passed: false,
            failure:
              error instanceof Error && error.message.startsWith("case_failed:")
                ? error.message
                : "probe_execution_failed",
            runs,
          }),
          { mode: 0o600 },
        );
        throw error;
      }
      writeFileSync(
        join(root, "evidence.json"),
        JSON.stringify({
          schema_version: 1,
          client_version: version,
          private_network_namespace: true,
          passed: false,
          runs,
        }),
        { mode: 0o600 },
      );
    }
    writeFileSync(
      join(root, "evidence.json"),
      JSON.stringify({
        schema_version: 1,
        client_version: version,
        private_network_namespace: true,
        passed: true,
        runs,
      }),
      { mode: 0o600 },
    );
  } finally {
    console.error = originalError;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "claude_context_probe_failed");
  process.exitCode = 1;
});
