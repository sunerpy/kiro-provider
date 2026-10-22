/**
 * Real installed Pi -> isolated provider -> synthetic SDK reasoning replay gate.
 * PI_PROBE_BINARY=/absolute/path/to/pi bun scripts/probe-pi-reasoning-replay.ts
 * Uses ephemeral loopback ports, an in-memory database and an owner-only temp
 * agent directory. No installed config, sessions, credentials or services are
 * read. A wire mutation recreates an old summary-only output for recovery cases.
 * Only enums, counts and booleans leave the in-memory fixture.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

type JsonRecord = Record<string, unknown>;
type Scenario = "token-roundtrip" | "summary-compatible" | "summary-strict" | "invalid-token";
type RequestEvidence = {
  status: number;
  fidelity_mode: "compatible" | "strict";
  reasoning_items: number;
  encrypted_items: number;
  tool_output_count: number;
  current_tool_count: number;
  compatibility_mode: string | null;
  error_code: string | null;
};

const API_KEY = "synthetic-pi-replay-key";
const SIGNATURE = "synthetic-pi-replay-signature";
const ACK = "SYNTHETIC_PI_REPLAY_ACK";
const MODEL = "claude-opus-5-5";

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture_record_expected");
  }
  return value as JsonRecord;
}

function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extensionSource(): string {
  return `export default function (pi) {
  pi.registerProvider("synthetic-probe", {
    api: "openai-responses", baseUrl: process.env.PI_PROBE_BASE_URL,
    apiKey: "${API_KEY}",
    models: [{id: "${MODEL}", name: "Synthetic replay probe", reasoning: true,
      input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]
  });
  pi.registerTool({name: "probe_echo", label: "Synthetic echo",
    description: "Return a constant synthetic result without side effects",
    parameters: {type: "object", properties: {}, additionalProperties: false},
    async execute() { return {content: [{type: "text", text: "SYNTHETIC_TOOL_RESULT"}], details: {}}; }
  });
  if (process.env.PI_PROBE_STRICT === "1") {
    pi.on("before_provider_request", (event) => {
      // Avoid the separate strict gates for Pi's summary request and synthetic
      // system instructions. Historical reasoning and tools pass unchanged.
      const payload = {...event.payload, reasoning: {...event.payload.reasoning}};
      delete payload.reasoning.summary;
      payload.input = payload.input.filter(item => item.role !== "system" && item.role !== "developer");
      return payload;
    });
  }
}`;
}

/** Mutate only the first output, recreating an old persisted client artifact. */
function historicalWireMutation(response: Response, scenario: Scenario): Response {
  if (scenario === "token-roundtrip" || response.status !== 200 || !response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const mutate = (item: JsonRecord): void => {
    if (item.type !== "reasoning") return;
    if (scenario === "invalid-token") item.encrypted_content = "kr2_invalid-synthetic-token";
    else delete item.encrypted_content;
  };
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          let end = pending.indexOf("\n\n");
          while (end >= 0) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const lines = frame.split("\n").map((line) => {
              if (!line.startsWith("data: ")) return line;
              const event = record(JSON.parse(line.slice(6)));
              if (event.item) mutate(record(event.item));
              if (event.response) {
                for (const item of array(record(event.response).output)) mutate(record(item));
              }
              return `data: ${JSON.stringify(event)}`;
            });
            controller.enqueue(encoder.encode(`${lines.join("\n")}\n\n`));
            end = pending.indexOf("\n\n");
          }
        },
        flush(controller) {
          requireCondition(pending.trim().length === 0, "incomplete_synthetic_sse_frame");
          controller.enqueue(encoder.encode(decoder.decode()));
        },
      }),
    ),
    { status: response.status, headers: response.headers },
  );
}

async function runScenario(binary: string, root: string, scenario: Scenario) {
  const config = ConfigSchema.parse({
    api_keys: [API_KEY],
    responses_fidelity_mode: scenario === "summary-strict" ? "strict" : "compatible",
    responses_instruction_lift: "off",
    responses_native_tool_bridge: "off",
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 19).toString("base64url")}`],
    request_timeout_ms: 10_000,
    stream_idle_timeout_ms: 5_000,
    rate_limit_max_retries: 0,
    stream_max_attempts: 1,
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
  const sdk: Array<{ tool_count: number; tool_result_count: number; reasoning_replayed: boolean }> =
    [];
  const requests: RequestEvidence[] = [];
  let iteratorClosed = 0;
  const dependencies: AppDependencies = {
    accountManager: {
      reconcileFromDb: () => [account],
      getAccountCount: () => 1,
      selectHealthyAccount: () => account,
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
    reasoningReplayStore: new ReasoningReplayStore(database, config),
    makeClient: () => ({
      async send(command) {
        const state = command.input.conversationState;
        const context = state?.currentMessage?.userInputMessage?.userInputMessageContext;
        const tools = context?.tools ?? [];
        sdk.push({
          tool_count: tools.length,
          tool_result_count: context?.toolResults?.length ?? 0,
          reasoning_replayed: JSON.stringify(state?.history ?? []).includes(SIGNATURE),
        });
        const events: SdkStreamEvent[] = [];
        if (sdk.length === 1) {
          const tool = tools.find((candidate) => "toolSpecification" in candidate);
          requireCondition(
            tool && "toolSpecification" in tool && tool.toolSpecification,
            "fixture_tool_missing",
          );
          events.push(
            {
              reasoningContentEvent: { text: "Synthetic reasoning summary.", signature: SIGNATURE },
            },
            {
              toolUseEvent: {
                name: tool.toolSpecification.name,
                toolUseId: "synthetic-call",
                input: "{}",
                stop: true,
              },
            },
          );
        } else events.push({ assistantResponseEvent: { content: ACK } });
        events.push({
          metadataEvent: { tokenUsage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
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
  const app = createApp(config, dependencies);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request, bunServer) {
      requireCondition(new URL(request.url).pathname === "/v1/responses", "unexpected_probe_path");
      const body = record(await request.clone().json());
      const input = array(body.input).map(record);
      const row: RequestEvidence = {
        status: 0,
        fidelity_mode: config.responses_fidelity_mode,
        reasoning_items: input.filter((item) => item.type === "reasoning").length,
        encrypted_items: input.filter(
          (item) => item.type === "reasoning" && typeof item.encrypted_content === "string",
        ).length,
        tool_output_count: input.filter((item) => item.type === "function_call_output").length,
        current_tool_count: array(body.tools).length,
        compatibility_mode: null,
        error_code: null,
      };
      requests.push(row);
      const response = await app(request, bunServer);
      row.status = response.status;
      row.compatibility_mode = response.headers.get("x-kiro-compatibility");
      if (response.status !== 200) {
        const errorBody = record(await response.clone().json());
        const error = record(errorBody.error ?? errorBody);
        row.error_code = typeof error.code === "string" ? error.code : null;
      }
      return requests.length === 1 ? historicalWireMutation(response, scenario) : response;
    },
  });
  const child = spawn(
    binary,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-builtin-tools",
      "--tools",
      "probe_echo",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-mcp",
      "--extension",
      join(root, "extension.mjs"),
      "--provider",
      "synthetic-probe",
      "--model",
      MODEL,
      "--thinking",
      "high",
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        PI_CODING_AGENT_DIR: join(root, scenario),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_PROBE_STRICT: scenario === "summary-strict" ? "1" : "0",
        PI_PROBE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderrBytes = 0;
  let output = "";
  let settle: (() => void) | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  const stopReasons: string[] = [];
  const thinking: Array<{ signed: boolean; encrypted: boolean }> = [];
  let ackCount = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
  });
  child.on("error", () => rejectActive?.(new Error("pi_child_start_failed")));
  child.on("exit", () => rejectActive?.(new Error("pi_child_exited_early")));
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    let end = output.indexOf("\n");
    while (end >= 0) {
      const line = output.slice(0, end).replace(/\r$/, "");
      output = output.slice(end + 1);
      end = output.indexOf("\n");
      if (!line) continue;
      const event = record(JSON.parse(line));
      if (event.type === "message_end") {
        const message = record(event.message);
        if (message.role !== "assistant") continue;
        stopReasons.push(String(message.stopReason));
        for (const value of array(message.content)) {
          const block = record(value);
          if (block.type === "text" && block.text === ACK) ackCount += 1;
          if (block.type === "thinking") {
            const signature =
              typeof block.thinkingSignature === "string"
                ? record(JSON.parse(block.thinkingSignature))
                : {};
            thinking.push({
              signed: typeof block.thinkingSignature === "string",
              encrypted: typeof signature.encrypted_content === "string",
            });
          }
        }
      }
      if (event.type === "agent_settled") settle?.();
    }
  });
  const prompt = async (ordinal: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("pi_probe_timeout")), 20_000);
      settle = () => {
        clearTimeout(timeout);
        rejectActive = undefined;
        resolve();
      };
      rejectActive = (error) => {
        clearTimeout(timeout);
        rejectActive = undefined;
        reject(error);
      };
      child.stdin.write(
        `${JSON.stringify({ id: `synthetic-${ordinal}`, type: "prompt", message: "Complete the synthetic replay probe." })}\n`,
      );
    });
  };
  try {
    const success = scenario === "token-roundtrip" || scenario === "summary-compatible";
    await prompt(1);
    if (success) await prompt(2);
    requireCondition(
      success ? requests.length === 3 : requests.length >= 2 && requests.length <= 4,
      `request_count_failed:${scenario}:${JSON.stringify(requests)}`,
    );
    requireCondition(
      requests.every((request) => request.current_tool_count === 1),
      `current_tools_changed:${scenario}`,
    );
    requireCondition(requests[1]?.tool_output_count === 1, `tool_result_missing:${scenario}`);
    requireCondition(
      thinking.length === 1 && thinking[0]?.signed,
      `pi_history_missing:${scenario}`,
    );
    requireCondition(iteratorClosed === sdk.length, `iterator_cleanup_failed:${scenario}`);
    if (success) {
      requireCondition(
        requests.every((request) => request.status === 200),
        `unexpected_rejection:${scenario}`,
      );
      requireCondition(
        sdk.length === 3 && ackCount === 2 && sdk[1]?.tool_result_count === 1,
        `roundtrip_failed:${scenario}`,
      );
      requireCondition(
        sdk
          .slice(1)
          .every((entry) => entry.reasoning_replayed === (scenario === "token-roundtrip")),
        `replay_boundary_failed:${scenario}`,
      );
      if (scenario === "summary-compatible") {
        requireCondition(
          requests
            .slice(1)
            .every((request) =>
              request.compatibility_mode?.includes("reasoning_summary_replay_omitted"),
            ),
          "compatibility_header_missing",
        );
      }
    } else {
      requireCondition(
        sdk.length === 1 &&
          requests.slice(1).every((request) => request.status === 400) &&
          stopReasons.at(-1) === "error",
        `rejection_gate_failed:${scenario}`,
      );
      if (scenario === "summary-strict")
        requireCondition(
          requests[1]?.error_code === "unsupported_reasoning_plaintext_replay",
          `strict_error_changed:${JSON.stringify(requests[1])}`,
        );
      else
        requireCondition(
          requests.slice(1).every((request) => request.error_code === "invalid_reasoning_replay"),
          "invalid_token_was_omitted",
        );
    }
    return {
      case: scenario,
      passed: true,
      requests,
      sdk,
      iterator_closed: iteratorClosed,
      client_stop_reasons: stopReasons,
      client_thinking: thinking,
      ack_count: ackCount,
      stderr_bytes: stderrBytes,
    };
  } finally {
    rejectActive = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
      }
    }
    await server.stop(true);
    database.close();
  }
}

async function main(): Promise<void> {
  const binary = process.env.PI_PROBE_BINARY ?? Bun.which("pi");
  requireCondition(binary, "pi_binary_required");
  const versionResult = Bun.spawnSync([binary, "--version"]);
  const version = versionResult.stdout.toString().trim();
  requireCondition(
    versionResult.exitCode === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version),
    "pi_version_unrecognized",
  );
  const root = mkdtempSync(join(tmpdir(), "kiro-pi-replay-"));
  chmodSync(root, 0o700);
  writeFileSync(join(root, "extension.mjs"), extensionSource(), { mode: 0o600 });
  const originalError = console.error;
  let omissionAudits = 0;
  console.error = (...values: unknown[]) => {
    try {
      const audit = record(JSON.parse(String(values[0])));
      if (audit.event === "responses_reasoning_summary_omitted") {
        requireCondition(
          audit.protocol === "responses" && typeof audit.reasoning_item_count === "number",
          "invalid_omission_audit",
        );
        omissionAudits += 1;
      }
    } catch {
      // Provider diagnostics remain in memory and never become probe evidence.
    }
  };
  try {
    const runs = [];
    for (const scenario of [
      "token-roundtrip",
      "summary-compatible",
      "summary-strict",
      "invalid-token",
    ] as const) {
      runs.push(await runScenario(binary, root, scenario));
    }
    requireCondition(omissionAudits === 2, "omission_audit_count_failed");
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          client_version: version,
          passed: true,
          omission_audits: omissionAudits,
          runs,
        },
        null,
        2,
      ),
    );
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "pi_probe_failed");
  process.exitCode = 1;
});
