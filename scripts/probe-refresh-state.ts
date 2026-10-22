/** Offline packaged-binary probe. All credentials, state and upstream frames are synthetic. */
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { privateProbeStateEnvironment } from "./probe-private-state.js";

type ProbeFailure =
  | "invalid_arguments"
  | "unsafe_binary"
  | "provider_start_failed"
  | "child_failed"
  | "child_output_limit"
  | "unexpected_error";
class ProbeError extends Error {
  constructor(readonly code: ProbeFailure) {
    super(code);
  }
}
type Protocol = "messages" | "responses";
type HttpCheck = {
  phase: "auth_backoff" | "healthy";
  protocol: Protocol;
  stream: boolean;
  status: number;
  expected_error: boolean;
  retry_after: boolean;
  upstream_calls: number;
  visible_marker: boolean;
  terminal_event: boolean;
  passed: boolean;
};
type ProbeReport = {
  phase: "completed" | "failed";
  failure?: ProbeFailure;
  schema_before: number;
  schema_after_start: number;
  schema_after_restart: number;
  cli_exit_status: number;
  cli_account_count: number;
  cli_refresh_failed: boolean;
  cli_secrets_absent: boolean;
  http: HttpCheck[];
  fake_upstream_calls: number;
  blocked_external_requests: number;
  real_oauth_requests: number;
  children_reaped: boolean;
  servers_stopped: boolean;
  temporary_state_removed: boolean;
  passed: boolean;
};

const FIXTURE_ACCESS = "synthetic-refresh-probe-access";
const FIXTURE_KEY = "synthetic-refresh-probe-api-key";
const FIXTURE_MARKER = "SYNTHETIC_REFRESH_STATE_OK";
const MAX_CAPTURE_BYTES = 1_048_576;

export function parseRefreshProbeArguments(args: readonly string[]): string {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { binary: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const binary = parsed.values.binary;
    if (!binary || !isAbsolute(binary)) throw new ProbeError("invalid_arguments");
    return binary;
  } catch {
    throw new ProbeError("invalid_arguments");
  }
}

/** Keep HOME unchanged; private XDG/APPDATA roots control provider state. */
export function refreshProbeEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  configRoot: string,
  proxyUrl: string,
): Record<string, string> {
  const env: Record<string, string> = { LANG: "C.UTF-8" };
  for (const field of ["PATH", "HOME", "SYSTEMROOT", "WINDIR"] as const) {
    const value = inherited[field];
    if (value !== undefined) env[field] = value;
  }
  // Every provider fetch/SDK request uses the deny-by-default local proxy.
  // Even an unexpected OAuth refresh can never contact an AWS endpoint.
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.ALL_PROXY = proxyUrl;
  env.NO_PROXY = "127.0.0.1,localhost";
  return privateProbeStateEnvironment(env, configRoot);
}

export function fixtureTunnelAllowed(authority: string, upstreamPort: number): boolean {
  return (
    Number.isInteger(upstreamPort) &&
    upstreamPort > 0 &&
    upstreamPort <= 65_535 &&
    authority === `127.0.0.1:${upstreamPort}`
  );
}

async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > MAX_CAPTURE_BYTES) throw new ProbeError("child_output_limit");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function spawnCandidate(
  binary: string,
  args: string[],
  taskRoot: string,
  env: Record<string, string>,
) {
  const child = Bun.spawn([binary, ...args], {
    cwd: taskRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([capture(child.stdout), capture(child.stderr)]);
  void output.catch(() => undefined);
  return { child, output };
}
type CandidateProcess = ReturnType<typeof spawnCandidate>;

async function finishChild(process: CandidateProcess): Promise<void> {
  if (process.child.exitCode === null) process.child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      process.child.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          process.child.kill("SIGKILL");
          resolve();
        }, 5_000);
      }),
    ]);
    await process.child.exited;
    await process.output;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function schemaVersion(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    return (
      database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
    );
  } finally {
    database.close();
  }
}

async function waitReady(process: CandidateProcess, port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.child.exitCode !== null) throw new ProbeError("provider_start_failed");
    try {
      if (
        (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) }))
          .status === 200
      )
        return;
    } catch {
      /* Only this task's loopback listener is contacted. */
    }
    await Bun.sleep(50);
  }
  throw new ProbeError("provider_start_failed");
}

function responseError(value: unknown): { type?: string; code?: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("error" in value) ||
    typeof value.error !== "object" ||
    value.error === null
  )
    return {};
  return {
    ...("type" in value.error && typeof value.error.type === "string"
      ? { type: value.error.type }
      : {}),
    ...("code" in value.error && typeof value.error.code === "string"
      ? { code: value.error.code }
      : {}),
  };
}

export async function runRefreshStateProbe(binary: string): Promise<ProbeReport> {
  const report: ProbeReport = {
    phase: "failed",
    schema_before: 0,
    schema_after_start: 0,
    schema_after_restart: 0,
    cli_exit_status: -1,
    cli_account_count: 0,
    cli_refresh_failed: false,
    cli_secrets_absent: false,
    http: [],
    fake_upstream_calls: 0,
    blocked_external_requests: 0,
    real_oauth_requests: 0,
    children_reaped: false,
    servers_stopped: false,
    temporary_state_removed: false,
    passed: false,
  };
  let taskRoot: string | undefined;
  const children: CandidateProcess[] = [];
  let upstream: Bun.Server<undefined> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  const sockets = new Set<Socket>();
  try {
    const binaryInfo = lstatSync(binary);
    if (
      !isAbsolute(binary) ||
      binaryInfo.isSymbolicLink() ||
      !binaryInfo.isFile() ||
      (binaryInfo.mode & 0o111) === 0
    )
      throw new ProbeError("unsafe_binary");
    taskRoot = mkdtempSync(join(tmpdir(), "kiro-refresh-state-probe-"));
    chmodSync(taskRoot, 0o700);
    const configRoot = join(taskRoot, "config");
    const stateRoot = join(configRoot, "kiro-provider");
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const databasePath = join(stateRoot, "accounts.db");
    const codec = new EventStreamCodec(toUtf8, fromUtf8);
    const frame = (type: string, body: unknown): Uint8Array =>
      codec.encode({
        headers: {
          ":message-type": { type: "string", value: "event" },
          ":event-type": { type: "string", value: type },
          ":content-type": { type: "string", value: "application/json" },
        },
        body: fromUtf8(JSON.stringify(body)),
      });
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        report.fake_upstream_calls++;
        if (report.fake_upstream_calls > 8) return new Response(null, { status: 429 });
        return new Response(
          Buffer.concat([
            frame("assistantResponseEvent", { content: FIXTURE_MARKER }),
            frame("meteringEvent", { usage: 0.01, unit: "credit", unitPlural: "credits" }),
          ]),
          { headers: { "Content-Type": "application/vnd.amazon.eventstream" } },
        );
      },
    });
    const upstreamPort = upstream.port;
    if (upstreamPort === undefined) throw new ProbeError("unexpected_error");
    proxy = createServer((_request, response) => {
      report.blocked_external_requests++;
      response.writeHead(403);
      response.end();
    });
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, socket, head) => {
      if (!fixtureTunnelAllowed(request.url ?? "", upstreamPort)) {
        report.blocked_external_requests++;
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const target = connect(upstreamPort, "127.0.0.1");
      sockets.add(target);
      target.once("close", () => sockets.delete(target));
      target.on("error", () => socket.destroy());
      socket.on("error", () => target.destroy());
      target.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) target.write(head);
        target.pipe(socket);
        socket.pipe(target);
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy?.once("error", reject);
      proxy?.listen(0, "127.0.0.1", resolve);
    });
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new ProbeError("unexpected_error");
    const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
    const env = refreshProbeEnvironment(process.env, configRoot, proxyUrl);
    const database = new AccountsDatabase(databasePath);
    try {
      database.insertAccount({
        id: "synthetic-refresh-state",
        email: "fixture@example.invalid",
        authMethod: "desktop",
        region: "us-east-1",
        accessToken: FIXTURE_ACCESS,
        refreshToken: "synthetic-unusable-refresh",
        expiresAt: Date.now() + 3_600_000,
        isHealthy: true,
        failCount: 0,
        rateLimitResetTime: 0,
        usedCount: 10,
        limitCount: 100_000,
        overageCount: 0,
        lastSync: Date.now(),
        refreshFailureCount: 1,
        refreshFailureCode: "invalid_request",
        refreshFailedAt: Date.now(),
        refreshRetryAt: Date.now() + 60_000,
      });
    } finally {
      database.close();
    }
    const downgrade = new Database(databasePath, { strict: true });
    try {
      downgrade.run("PRAGMA user_version = 8");
    } finally {
      downgrade.close();
    }
    report.schema_before = schemaVersion(databasePath);
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reserved.port;
    reserved.stop(true);
    if (port === undefined) throw new ProbeError("unexpected_error");
    const configPath = join(stateRoot, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        host: "127.0.0.1",
        port,
        api_keys: [FIXTURE_KEY],
        auth_source: "local",
        protocol_projection_mode: "safe",
        account_maintenance_enabled: false,
        dynamic_model_catalog: false,
        proxy_url: proxyUrl,
        test_upstream_endpoint: `http://127.0.0.1:${upstreamPort}`,
        request_timeout_ms: 3_000,
        stream_idle_timeout_ms: 2_000,
        rate_limit_max_retries: 0,
        stream_max_attempts: 1,
        retry_empty_completion: false,
        usage_refresh_interval_ms: 3_600_000,
        instance_lock_path: join(stateRoot, "probe-instance.lock"),
        reasoning_replay_key_path: join(stateRoot, "probe-replay-keys.json"),
      }),
      { mode: 0o600 },
    );
    let provider = spawnCandidate(binary, ["serve", "--config", configPath], taskRoot, env);
    children.push(provider);
    await waitReady(provider, port);
    report.schema_after_start = schemaVersion(databasePath);
    const cli = spawnCandidate(binary, ["accounts", "list", "--json"], taskRoot, env);
    children.push(cli);
    const cliTimer = setTimeout(() => cli.child.kill("SIGKILL"), 5_000);
    try {
      report.cli_exit_status = await cli.child.exited;
      const [stdout] = await cli.output;
      const rows: unknown = JSON.parse(stdout);
      if (Array.isArray(rows)) {
        report.cli_account_count = rows.length;
        report.cli_refresh_failed = rows.length === 1 && rows[0]?.availability === "refresh-failed";
        report.cli_secrets_absent =
          !stdout.includes(FIXTURE_ACCESS) &&
          rows.every(
            (row) =>
              typeof row === "object" &&
              row !== null &&
              !["access_token", "refresh_token", "client_secret", "client_id"].some((field) =>
                Object.hasOwn(row, field),
              ),
          );
      }
    } finally {
      clearTimeout(cliTimer);
    }
    const matrix = async (phase: HttpCheck["phase"]): Promise<void> => {
      for (const protocol of ["messages", "responses"] as const)
        for (const stream of [false, true]) {
          const before = report.fake_upstream_calls;
          const response = await fetch(`http://127.0.0.1:${port}/v1/${protocol}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": FIXTURE_KEY },
            body: JSON.stringify(
              protocol === "messages"
                ? {
                    model: "claude-sonnet-5",
                    max_tokens: 1024,
                    stream,
                    messages: [{ role: "user", content: "synthetic" }],
                  }
                : { model: "claude-sonnet-5", store: false, stream, input: "synthetic" },
            ),
            signal: AbortSignal.timeout(5_000),
          });
          const wire = await response.text();
          let error: ReturnType<typeof responseError> = {};
          try {
            error = responseError(JSON.parse(wire));
          } catch {
            /* A successful SSE body is not JSON. */
          }
          const expectedError =
            protocol === "messages"
              ? error.type === "overloaded_error"
              : error.code === "upstream_token_refresh_failed";
          const retryAfter = Number(response.headers.get("Retry-After")) > 0;
          const terminalEvent =
            !stream ||
            (protocol === "messages"
              ? wire.includes("event: message_stop")
              : wire.includes("response.completed"));
          const delta = report.fake_upstream_calls - before;
          const visibleMarker = wire.includes(FIXTURE_MARKER);
          const passed =
            phase === "auth_backoff"
              ? response.status === 503 && expectedError && retryAfter && delta === 0
              : response.status === 200 && visibleMarker && terminalEvent && delta === 1;
          report.http.push({
            phase,
            protocol,
            stream,
            status: response.status,
            expected_error: expectedError,
            retry_after: retryAfter,
            upstream_calls: delta,
            visible_marker: visibleMarker,
            terminal_event: terminalEvent,
            passed,
          });
        }
    };
    await matrix("auth_backoff");
    await finishChild(provider);
    const reset = new Database(databasePath, { strict: true });
    try {
      reset.run(
        "UPDATE accounts SET refresh_failure_count = NULL, refresh_failure_code = NULL, refresh_failed_at = NULL, refresh_retry_at = NULL, last_sync = ?, rate_limit_reset = 0",
        [Date.now()],
      );
    } finally {
      reset.close();
    }
    provider = spawnCandidate(binary, ["serve", "--config", configPath], taskRoot, env);
    children.push(provider);
    await waitReady(provider, port);
    report.schema_after_restart = schemaVersion(databasePath);
    await matrix("healthy");
    report.passed =
      report.schema_before === 8 &&
      report.schema_after_start === 9 &&
      report.schema_after_restart === 9 &&
      report.cli_exit_status === 0 &&
      report.cli_account_count === 1 &&
      report.cli_refresh_failed &&
      report.cli_secrets_absent &&
      report.http.length === 8 &&
      report.http.every((check) => check.passed) &&
      report.fake_upstream_calls === 4 &&
      report.blocked_external_requests === 0;
    report.phase = report.passed ? "completed" : "failed";
  } catch (error) {
    report.failure = error instanceof ProbeError ? error.code : "unexpected_error";
  } finally {
    for (const child of children) {
      try {
        await finishChild(child);
      } catch {
        report.passed = false;
      }
    }
    report.children_reaped = children.every((child) => child.child.exitCode !== null);
    for (const socket of sockets) socket.destroy();
    upstream?.stop(true);
    if (proxy?.listening) await new Promise<void>((resolve) => proxy?.close(() => resolve()));
    report.servers_stopped = !proxy?.listening;
    if (taskRoot !== undefined) {
      try {
        rmSync(taskRoot, { recursive: true, force: true });
        report.temporary_state_removed = !existsSync(taskRoot);
      } catch {
        report.passed = false;
      }
    }
    report.passed =
      report.passed &&
      report.children_reaped &&
      report.servers_stopped &&
      report.temporary_state_removed;
    report.phase = report.passed ? "completed" : "failed";
  }
  return report;
}

if (import.meta.main) {
  try {
    const report = await runRefreshStateProbe(parseRefreshProbeArguments(process.argv.slice(2)));
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ phase: "rejected", failure: "invalid_arguments", passed: false }));
    process.exitCode = 1;
  }
}
