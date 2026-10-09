/**
 * Real Claude Code Goal/Stop-hook probe through the gateway's auth, ingress,
 * SDK pipeline and Messages encoder, with a synthetic upstream by default.
 *
 * bun scripts/probe-claude-goal.ts --claude-bin /path/to/claude --out /tmp/evidence.json
 *
 * --native-goal sets the built-in /goal via stream-json instead of a configured
 * Stop prompt hook. --bind-port 8787 requires a distinct Linux network namespace
 * recorded in KIRO_GOAL_PROBE_PARENT_NETNS, so managed settings can stay intact.
 * --live-base-url http://127.0.0.1:PORT --provider-config /isolated/config.json
 * forwards only evaluator requests to an explicitly isolated live gateway.
 * No original session, production port, home, installed launcher or policy is changed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
const MARKER = "GOAL_SYNTHETIC_CHECK_PASSED";
const COMMAND = `printf '%s\\n' '${MARKER}'`;
const CONDITION = `The synthetic check is complete only after Bash executes ${COMMAND} and returns ${MARKER}. A promise to run it is incomplete. Return the JSON evaluator decision.`;

function evaluatorDecision(
  wire: string,
): { ok: boolean; reason: string; impossible?: boolean } | undefined {
  let text = "";
  try {
    const body = JSON.parse(wire) as { content?: Array<{ type: string; text?: string }> };
    text =
      body.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("") ?? "";
  } catch {
    for (const line of wire.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as {
          type?: string;
          delta?: { type: string; text?: string };
        };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta")
          text += event.delta.text ?? "";
      } catch {}
    }
  }
  try {
    const value = JSON.parse(text) as { ok?: unknown; reason?: unknown; impossible?: unknown };
    if (typeof value.ok !== "boolean" || typeof value.reason !== "string") return undefined;
    return {
      ok: value.ok,
      reason: value.reason,
      ...(typeof value.impossible === "boolean" ? { impossible: value.impossible } : {}),
    };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const binary = option("--claude-bin");
  const output = option("--out");
  const nativeGoal = process.argv.includes("--native-goal");
  const mode = option("--case") ?? "continue";
  requireCondition(binary && output, "claude_binary_and_evidence_required");
  requireCondition(
    ["continue", "complete", "impossible", "invalid", "rejected"].includes(mode),
    "invalid_case",
  );
  const repository = resolve(import.meta.dir, "..");
  requireCondition(!resolve(output).startsWith(`${repository}/`), "evidence_must_be_external");
  const port = Number(option("--bind-port") ?? "0");
  requireCondition(Number.isSafeInteger(port) && port >= 0 && port <= 65535, "invalid_port");
  if (port === 8787) {
    const parent = process.env.KIRO_GOAL_PROBE_PARENT_NETNS;
    requireCondition(
      parent && readlinkSync("/proc/self/ns/net") !== parent,
      "isolated_network_namespace_required",
    );
  }
  const live = option("--live-base-url");
  const providerConfig = option("--provider-config");
  const liveSocket = option("--live-unix-socket");
  let liveBase: URL | undefined;
  let liveKey: string | undefined;
  if (live !== undefined) {
    liveBase = new URL(live);
    requireCondition(
      liveBase.protocol === "http:" &&
        liveBase.hostname === "127.0.0.1" &&
        liveBase.port !== "" &&
        liveBase.port !== "8787" &&
        liveBase.pathname === "/" &&
        providerConfig,
      "isolated_live_gateway_required",
    );
    const config = ConfigSchema.parse(JSON.parse(readFileSync(providerConfig, "utf8")));
    requireCondition(
      config.port !== 8787 && config.port === Number(liveBase.port),
      "isolated_live_config_required",
    );
    liveKey = config.api_keys[0];
    requireCondition(liveKey, "isolated_live_key_required");
    requireCondition(
      mode === "continue" || mode === "complete",
      "live_case_requires_semantic_verdict",
    );
  }
  const root = mkdtempSync(join(tmpdir(), "kiro-claude-goal-"));
  chmodSync(root, 0o700);
  const key = `synthetic-${randomUUID()}`;
  const home = join(root, "home");
  const configDir = join(home, ".claude");
  const project = join(root, "project");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(project, { mode: 0o700 });
  const tokenHelper = join(root, "token.sh");
  writeFileSync(tokenHelper, '#!/bin/sh\nprintf "%s\\n" "$KIRO_GOAL_PROBE_KEY"\n', { mode: 0o700 });
  let mainRequests = 0;
  let mainDispatches = 0;
  let hookRequests = 0;
  let sdkDispatches = 0;
  let toolResults = 0;
  let iteratorClosed = 0;
  let schemaObserved = false;
  let feedbackReceived = 0;
  let pendingReason: string | undefined;
  let negativeBudgetStopped = false;
  const captures: Array<Record<string, unknown>> = [];
  const selected: ManagedAccount = {
    id: randomUUID(),
    email: "fixture@example.invalid",
    authMethod: "desktop",
    region: "us-east-1",
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
    refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access",
    expiresAt: Date.now() + 3_600_000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
  };
  const dependencies: AppDependencies = {
    accountManager: {
      reconcileFromDb: () => [selected],
      selectHealthyAccount: () => selected,
      getAccountCount: () => 1,
      toAuthDetails: () => ({
        access: selected.accessToken,
        refresh: selected.refreshToken,
        expires: selected.expiresAt,
        authMethod: selected.authMethod,
        region: selected.region,
        profileArn: selected.profileArn,
      }),
      markRateLimited() {},
      markUnhealthy() {},
    },
    tokenRefresher: { refreshIfNeeded: async () => selected, forceRefresh: async () => selected },
    makeClient: () => ({
      async send(command) {
        sdkDispatches += 1;
        const current = command.input.conversationState?.currentMessage?.userInputMessage;
        const tools = current?.userInputMessageContext?.tools ?? [];
        const events: SdkStreamEvent[] = [];
        if (tools.length > 0) mainDispatches += 1;
        if (tools.length === 0) {
          const verdict =
            mode === "invalid"
              ? "A promise is incomplete."
              : JSON.stringify({
                  ok: mode === "complete" || toolResults > 0,
                  reason:
                    mode === "impossible"
                      ? "Synthetic condition is impossible."
                      : toolResults > 0 || mode === "complete"
                        ? "Synthetic check complete."
                        : `Run Bash now with command ${COMMAND}.`,
                  ...(mode === "impossible" ? { impossible: true } : {}),
                });
          events.push({ assistantResponseEvent: { content: verdict } });
        } else if (mainDispatches === 1 || mode !== "continue") {
          events.push({
            assistantResponseEvent: { content: "I will run the remaining synthetic check now." },
          });
        } else if (toolResults === 0) {
          requireCondition(tools.length === 1, "unexpected_fixture_tool_count");
          const name = tools[0]?.toolSpecification?.name;
          requireCondition(name, "fixture_tool_missing");
          events.push({
            toolUseEvent: {
              toolUseId: "synthetic-check",
              name,
              input: JSON.stringify({
                command: COMMAND,
                description: "Run synthetic remaining check",
              }),
              stop: true,
            },
          });
        } else events.push({ assistantResponseEvent: { content: "Synthetic check complete." } });
        events.push({
          metadataEvent: { tokenUsage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } },
        });
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
  const app = createApp(
    ConfigSchema.parse({
      api_keys: [key],
      protocol_projection_mode: "v3-auto",
      request_timeout_ms: 60_000,
      stream_idle_timeout_ms: 20_000,
      rate_limit_max_retries: 0,
      stream_max_attempts: 1,
    }),
    dependencies,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 1000 });
      if (!path.endsWith("/messages")) return Response.json({ data: [], has_more: false });
      const encoded = Buffer.from(await request.arrayBuffer());
      const decoded =
        request.headers.get("content-encoding") === "gzip" ? gunzipSync(encoded) : encoded;
      const body = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
      const format = (
        body.output_config as
          | { format?: { schema?: { properties?: Record<string, unknown> } } }
          | undefined
      )?.format;
      const hook = format?.schema?.properties?.ok !== undefined;
      if (hook) {
        hookRequests += 1;
        const schema = format?.schema as Record<string, unknown>;
        schemaObserved =
          JSON.stringify(schema) ===
          JSON.stringify({
            type: "object",
            properties: {
              ok: { type: "boolean" },
              reason: { type: "string" },
              impossible: { type: "boolean" },
            },
            required: ["ok", "reason"],
            additionalProperties: false,
          });
      } else {
        mainRequests += 1;
        if (
          pendingReason !== undefined &&
          JSON.stringify(body.messages).includes(JSON.stringify(pendingReason).slice(1, -1))
        ) {
          feedbackReceived += 1;
          pendingReason = undefined;
        }
        for (const message of body.messages as Array<{ content: unknown }>) {
          if (
            Array.isArray(message.content) &&
            message.content.some(
              (block: { type?: string; content?: unknown }) =>
                block.type === "tool_result" && JSON.stringify(block.content).includes(MARKER),
            )
          )
            toolResults = 1;
        }
      }
      if (mode === "invalid" && hook && hookRequests > 3) {
        negativeBudgetStopped = true;
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Synthetic invalid-output retry budget reached",
            },
          },
          { status: 400 },
        );
      }
      requireCondition(mainRequests <= 4 && hookRequests <= 3, "fixture_request_budget_exceeded");
      const upstreamUrl = hook && liveBase ? new URL(path, liveBase).toString() : request.url;
      const projected = new Request(upstreamUrl, {
        method: "POST",
        headers: {
          ...Object.fromEntries(request.headers),
          "content-encoding": "identity",
          "x-api-key": hook && liveKey ? liveKey : key,
          authorization: `Bearer ${hook && liveKey ? liveKey : key}`,
        },
        body: decoded,
        signal: request.signal,
      });
      let response: Response;
      if (hook && mode === "rejected")
        response = Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Invalid request: output_config.format is outside the supported local structured output profile",
            },
          },
          { status: 400 },
        );
      else if (hook && liveBase)
        response = await fetch(projected, {
          timeout: false,
          ...(liveSocket ? { unix: liveSocket } : {}),
        } as RequestInit);
      else response = await app(projected);
      const wire = await response.text();
      const decision = hook ? evaluatorDecision(wire) : undefined;
      const errorCode =
        decision === undefined && hook
          ? [
              "structured_output_validation_failed",
              "structured_output_buffer_exceeded",
              "structured_output_unexpected_tool_call",
              "structured_output_unexpected_reasoning",
            ].find((code) => wire.includes(`(code: ${code})`))
          : undefined;
      if (decision && !decision.ok && decision.impossible !== true) pendingReason = decision.reason;
      captures.push({
        kind: hook ? "evaluator" : "main",
        status: response.status,
        stream: body.stream === true,
        model: body.model,
        max_tokens: body.max_tokens,
        profile: response.headers.get("x-kiro-structured-output"),
        format_observed: hook,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(hook
          ? {
              verdict:
                decision === undefined
                  ? "invalid"
                  : decision.ok
                    ? "complete"
                    : decision.impossible === true
                      ? "impossible"
                      : "incomplete",
            }
          : {}),
        tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      });
      return new Response(wire, { status: response.status, headers: response.headers });
    },
  });
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-chrome",
    "--system-prompt",
    "Synthetic protocol fixture. Perform only the requested synthetic check. Do not delegate.",
    "--model",
    "claude-opus-5-5[1m]",
    "--tools",
    "Bash",
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "5",
  ];
  if (nativeGoal) args.push("--input-format", "stream-json");
  else
    args.push(
      "--settings",
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "prompt", prompt: CONDITION, model: "claude-sonnet-5", timeout: 120 },
              ],
            },
          ],
        },
      }),
      "Run the remaining synthetic check.",
    );
  const child = spawn("sh", [join(repository, "scripts/kiroclaude"), ...args], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      KIROCLAUDE_CONFIG_DIR: configDir,
      KIROCLAUDE_CLAUDE_BIN: binary,
      KIROCLAUDE_BASE_URL: `http://127.0.0.1:${server.port}`,
      KIROCLAUDE_EFFORT: "max",
      KIROCLAUDE_TOKEN_HELPER: tokenHelper,
      KIRO_GOAL_PROBE_KEY: key,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
  });
  child.stdin.on("error", () => {});
  if (nativeGoal) {
    for (const text of [`/goal ${CONDITION}`])
      child.stdin.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
      );
  }
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), liveBase ? 240_000 : 25_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      },
    );
    const rows = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    let blockedStops = 0;
    let hookErrors = 0;
    let goalObserved = false;
    const projects = join(configDir, "projects");
    if (readdirSync(configDir).includes("projects")) {
      for (const directory of readdirSync(projects))
        for (const file of readdirSync(join(projects, directory)).filter((name) =>
          name.endsWith(".jsonl"),
        )) {
          for (const line of readFileSync(join(projects, directory, file), "utf8").split("\n")) {
            let entry: Record<string, unknown>;
            try {
              entry = JSON.parse(line);
            } catch {
              continue;
            }
            if (entry.subtype === "stop_hook_summary") {
              if (entry.preventedContinuation === true) blockedStops += 1;
              hookErrors += Array.isArray(entry.hookErrors) ? entry.hookErrors.length : 0;
            }
            if (
              entry.type === "attachment" &&
              (entry.attachment as { type?: string } | undefined)?.type === "goal_status"
            )
              goalObserved = true;
          }
        }
    }
    const success =
      exit.code === 0 &&
      schemaObserved &&
      hookRequests > 0 &&
      captures
        .filter((row) => row.kind === "evaluator")
        .every((row) =>
          mode === "rejected"
            ? row.status === 400 && row.verdict === "invalid"
            : mode === "invalid"
              ? row.error_code === "structured_output_validation_failed" &&
                row.verdict === "invalid"
              : row.status === 200 &&
                row.profile === "hook-evaluation-v1" &&
                row.verdict !== "invalid",
        ) &&
      (mode === "continue"
        ? mainDispatches === 3 && toolResults === 1 && feedbackReceived === 1 && hookRequests === 2
        : mainDispatches === 1 && toolResults === 0) &&
      (!nativeGoal || goalObserved);
    const report = {
      schema_version: 1,
      case: mode,
      native_goal: nativeGoal,
      success,
      ...exit,
      main_requests: mainRequests,
      main_dispatches: mainDispatches,
      evaluator_requests: hookRequests,
      observed_tool_result: toolResults === 1,
      sdk_dispatches: sdkDispatches,
      iterator_closed: iteratorClosed,
      blocked_stops: blockedStops,
      evaluator_feedback_received: feedbackReceived,
      negative_retry_budget_stopped: negativeBudgetStopped,
      hook_errors: hookErrors,
      goal_observed: goalObserved,
      client_result_count: rows.filter((row) => row.type === "result").length,
      stderr_bytes: stderrBytes,
      real_evaluator_requests: liveBase ? hookRequests : 0,
      captures,
    };
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (!success) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error("goal_probe_failed");
  process.exitCode = 1;
});
