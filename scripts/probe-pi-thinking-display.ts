/**
 * Real installed Pi -> isolated Responses provider -> synthetic SDK display gate.
 * PI_PROBE_BINARY=/absolute/path/to/pi bun scripts/probe-pi-thinking-display.ts
 * Add --out /tmp/evidence.json for the complete sanitized fixture evidence.
 * The default mode performs no live Kiro calls. It resumes only generated fixture
 * sessions, uses an in-memory database, disables both client retry layers and
 * exposes one constant-returning tool. Evidence is enums/counts/booleans only.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

type JsonRecord = Record<string, unknown>;
type Display = "preserve" | "omitted";
type SignatureCase =
  | "single"
  | "duplicate"
  | "late"
  | "nonempty-conflict"
  | "nonempty-transport-error";
type ClientEvidence = {
  stop_reasons: string[];
  thinking: Array<{ text_chars: number; encrypted: boolean }>;
  tool_results: number;
  auto_retry_events: number;
  ack_count: number;
  invalid_reasoning_error: boolean;
  transport_error: boolean;
  stderr_bytes: number;
};
type RequestEvidence = {
  stage: "bootstrap" | "resumed";
  status: number;
  requested_effort: string | null;
  reasoning_items: number;
  encrypted_items: number;
  declared_tools: number;
  tool_results: number;
  forced_display_header: boolean;
  error_code: string | null;
};
type SdkEvidence = {
  stage: "bootstrap" | "resumed";
  upstream_display: string | null;
  upstream_effort: string | null;
  declared_tools: number;
  current_tool_results: number;
  historical_tool_calls: number;
  old_signature_replayed: boolean;
  new_signature_replayed: boolean;
  new_reasoning_replayed: boolean;
};

const KEY = "synthetic-pi-thinking-key";
const OLD_SIGNATURE = "synthetic-old-signature";
const NEW_SIGNATURE = "synthetic-new-signature";
const ACK = "SYNTHETIC_PI_THINKING_ACK";

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

function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extensionSource(): string {
  return `export default function (pi) {
    pi.registerProvider("synthetic-thinking", {
      api: "openai-responses", baseUrl: process.env.PI_PROBE_BASE_URL,
      apiKey: "${KEY}",
      models: [{id: process.env.PI_PROBE_MODEL, name: "Synthetic display probe",
        reasoning: true, thinkingLevelMap: {off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max"},
        input: ["text"], contextWindow: 200000, maxTokens: 4096,
        compat: {supportsMaxOutputTokens: false},
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]
    });
    pi.registerTool({name: "probe_echo", label: "Synthetic echo",
      description: "Return a constant fixture without side effects",
      parameters: {type: "object", properties: {}, additionalProperties: false},
      async execute() { return {content: [{type: "text", text: "SYNTHETIC_TOOL_RESULT"}], details: {}}; }
    });
  }`;
}

async function runPi(
  binary: string,
  root: string,
  caseRoot: string,
  baseUrl: string,
  model: string,
): Promise<ClientEvidence> {
  const child = spawn(
    binary,
    [
      "--mode",
      "rpc",
      "--session-id",
      "fixture-thinking",
      "--session-dir",
      join(caseRoot, "sessions"),
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
      "synthetic-thinking",
      "--model",
      model,
      "--thinking",
      "max",
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        PI_CODING_AGENT_DIR: caseRoot,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_PROBE_BASE_URL: baseUrl,
        PI_PROBE_MODEL: model,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const evidence: ClientEvidence = {
    stop_reasons: [],
    thinking: [],
    tool_results: 0,
    auto_retry_events: 0,
    ack_count: 0,
    invalid_reasoning_error: false,
    transport_error: false,
    stderr_bytes: 0,
  };
  let pending = "";
  let resolveRun: (() => void) | undefined;
  let rejectRun: ((error: Error) => void) | undefined;
  const settled = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  child.on("error", () => rejectRun?.(new Error("pi_child_start_failed")));
  child.on("exit", () => rejectRun?.(new Error("pi_child_exited_early")));
  child.stderr.on("data", (chunk: Buffer) => {
    evidence.stderr_bytes += chunk.byteLength;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end = pending.indexOf("\n");
    while (end >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
      if (!line) continue;
      try {
        const event = record(JSON.parse(line));
        if (event.type === "auto_retry_start") evidence.auto_retry_events += 1;
        if (event.type === "message_end") {
          const message = record(event.message);
          if (message.role === "toolResult") evidence.tool_results += 1;
          if (message.role !== "assistant") continue;
          evidence.stop_reasons.push(String(message.stopReason));
          if (
            typeof message.errorMessage === "string" &&
            message.errorMessage.includes("invalid_upstream_reasoning")
          )
            evidence.invalid_reasoning_error = true;
          if (
            typeof message.errorMessage === "string" &&
            message.errorMessage.includes("upstream_stream_error")
          )
            evidence.transport_error = true;
          for (const value of array(message.content)) {
            const block = record(value);
            if (block.type === "text" && block.text === ACK) evidence.ack_count += 1;
            if (block.type === "thinking") {
              const signature =
                typeof block.thinkingSignature === "string"
                  ? record(JSON.parse(block.thinkingSignature))
                  : {};
              evidence.thinking.push({
                text_chars: typeof block.thinking === "string" ? block.thinking.length : 0,
                encrypted: typeof signature.encrypted_content === "string",
              });
            }
          }
        }
        if (event.type === "agent_settled") resolveRun?.();
      } catch {
        rejectRun?.(new Error("invalid_fixture_rpc_record"));
      }
    }
  });
  const timeout = setTimeout(() => rejectRun?.(new Error("pi_probe_timeout")), 25_000);
  try {
    child.stdin.write(
      `${JSON.stringify({ id: "synthetic-prompt", type: "prompt", message: "Complete the synthetic display fixture." })}\n`,
    );
    await settled;
    return evidence;
  } finally {
    clearTimeout(timeout);
    rejectRun = undefined;
    resolveRun = undefined;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
  }
}

async function runCase(
  binary: string,
  root: string,
  model: string,
  display: Display,
  signatureCase: SignatureCase,
) {
  const name = `${model}-${display}-${signatureCase}`;
  const caseRoot = join(root, name);
  mkdirSync(caseRoot, { mode: 0o700 });
  writeFileSync(
    join(caseRoot, "settings.json"),
    JSON.stringify({
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      compaction: { enabled: false },
    }),
    { mode: 0o600 },
  );
  const makeConfig = (policy: Display) =>
    ConfigSchema.parse({
      api_keys: [KEY],
      responses_thinking_display_mode: policy,
      responses_instruction_lift: "off",
      responses_native_tool_bridge: "off",
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 23).toString("base64url")}`],
      request_timeout_ms: 10_000,
      stream_idle_timeout_ms: 5_000,
      rate_limit_max_retries: 0,
      stream_max_attempts: 3,
    });
  const config = makeConfig("preserve");
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
  let stage: "bootstrap" | "resumed" = "bootstrap";
  let stageDispatches = 0;
  let iteratorClosed = 0;
  const sdk: SdkEvidence[] = [];
  const requests: RequestEvidence[] = [];
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
        stageDispatches += 1;
        const state = command.input.conversationState;
        const context = state?.currentMessage?.userInputMessage?.userInputMessageContext;
        const tools = context?.tools ?? [];
        const history = JSON.stringify(state?.history ?? []);
        const fields = optionalRecord(command.input.additionalModelRequestFields);
        const thinking = optionalRecord(fields?.thinking);
        const outputConfig = optionalRecord(fields?.output_config);
        sdk.push({
          stage,
          upstream_display: typeof thinking?.display === "string" ? thinking.display : null,
          upstream_effort: typeof outputConfig?.effort === "string" ? outputConfig.effort : null,
          declared_tools: tools.length,
          current_tool_results: context?.toolResults?.length ?? 0,
          historical_tool_calls:
            state?.history?.reduce(
              (count, message) => count + (message.assistantResponseMessage?.toolUses?.length ?? 0),
              0,
            ) ?? 0,
          old_signature_replayed: history.includes(OLD_SIGNATURE),
          new_signature_replayed: history.includes(NEW_SIGNATURE),
          new_reasoning_replayed: history.includes("Synthetic new reasoning."),
        });
        const events: SdkStreamEvent[] = [];
        if (stageDispatches === 1) {
          const signature = stage === "bootstrap" ? OLD_SIGNATURE : NEW_SIGNATURE;
          const currentCase = stage === "bootstrap" ? "single" : signatureCase;
          // Even an omitted request may receive text. The policy must suppress
          // public deltas while authenticating and replaying the full capture.
          const text =
            stage === "bootstrap" ? "Synthetic old reasoning." : "Synthetic new reasoning.";
          const tool = tools.find((value) => "toolSpecification" in value);
          requireCondition(
            tool && "toolSpecification" in tool && tool.toolSpecification,
            "fixture_tool_missing",
          );
          events.push({
            reasoningContentEvent: {
              text:
                currentCase === "nonempty-conflict"
                  ? "Synthetic nonempty conflicting reasoning."
                  : text,
              ...(currentCase === "late" ? {} : { signature }),
            },
          });
          if (currentCase === "duplicate") events.push({ reasoningContentEvent: { signature } });
          if (currentCase === "nonempty-conflict")
            events.push({
              reasoningContentEvent: { signature: "synthetic-conflicting-signature" },
            });
          events.push({
            toolUseEvent: {
              name: tool.toolSpecification.name,
              toolUseId: stage === "bootstrap" ? "synthetic-old-call" : "synthetic-new-call",
              input: "{}",
              stop: true,
            },
          });
          if (currentCase === "late") events.push({ reasoningContentEvent: { signature } });
        } else events.push({ assistantResponseEvent: { content: ACK } });
        events.push({
          metadataEvent: { tokenUsage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
        });
        return {
          generateAssistantResponseResponse: (async function* () {
            try {
              if (
                stage === "resumed" &&
                signatureCase === "nonempty-transport-error" &&
                stageDispatches === 1
              ) {
                yield {
                  reasoningContentEvent: { text: "Synthetic reasoning before transport reset." },
                };
                throw Object.assign(new Error("Synthetic transport reset"), { code: "ECONNRESET" });
              }
              yield* events;
            } finally {
              iteratorClosed += 1;
            }
          })(),
        };
      },
    }),
  };
  let app = createApp(config, dependencies);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request, bunServer) {
      requireCondition(new URL(request.url).pathname === "/v1/responses", "unexpected_probe_path");
      const body = record(await request.clone().json());
      const input = array(body.input).map(record);
      const row: RequestEvidence = {
        stage,
        status: 0,
        requested_effort:
          typeof optionalRecord(body.reasoning)?.effort === "string"
            ? String(optionalRecord(body.reasoning)?.effort)
            : null,
        reasoning_items: input.filter((item) => item.type === "reasoning").length,
        encrypted_items: input.filter(
          (item) => item.type === "reasoning" && typeof item.encrypted_content === "string",
        ).length,
        declared_tools: array(body.tools).length,
        tool_results: input.filter((item) => item.type === "function_call_output").length,
        forced_display_header: false,
        error_code: null,
      };
      requests.push(row);
      const response = await app(request, bunServer);
      row.status = response.status;
      if (!response.ok) {
        const error = optionalRecord(record(await response.clone().json()).error);
        row.error_code = typeof error?.code === "string" ? error.code : null;
      }
      row.forced_display_header =
        response.headers.get("x-kiro-thinking-display-mode") === "forced-omitted";
      return response;
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/v1`;
    const bootstrap = await runPi(binary, root, caseRoot, url, model);
    requireCondition(
      bootstrap.ack_count === 1 && bootstrap.tool_results === 1 && sdk.length === 2,
      `bootstrap_failed:${JSON.stringify({ case: name, bootstrap, requests, sdk })}`,
    );
    stage = "resumed";
    stageDispatches = 0;
    app = createApp(makeConfig(display), dependencies);
    const resumed = await runPi(binary, root, caseRoot, url, model);
    const current = sdk.filter((entry) => entry.stage === "resumed");
    const currentRequests = requests.filter((entry) => entry.stage === "resumed");
    const success =
      signatureCase !== "nonempty-conflict" && signatureCase !== "nonempty-transport-error";
    const checks = {
      max_effort_preserved:
        requests.every((entry) => entry.requested_effort === "max") &&
        sdk.every((entry) => entry.upstream_effort === "max"),
      current_tools_preserved:
        requests.every((entry) => entry.declared_tools === 1) &&
        sdk.every((entry) => entry.declared_tools === 1),
      old_tool_history_resumed:
        current.length > 0 &&
        current.every(
          (entry) => entry.old_signature_replayed && entry.historical_tool_calls >= 1,
        ) &&
        currentRequests.every((entry) => entry.encrypted_items >= 1),
      forced_header_correct: requests.every(
        (entry) =>
          entry.forced_display_header === (entry.stage === "resumed" && display === "omitted"),
      ),
      omitted_upstream:
        display !== "omitted" || current.every((entry) => entry.upstream_display === "omitted"),
      preserve_upstream:
        display !== "preserve" || current.every((entry) => entry.upstream_display === null),
      no_client_retry: bootstrap.auto_retry_events === 0 && resumed.auto_retry_events === 0,
      iterator_cleanup: iteratorClosed === sdk.length,
      output_contract: success
        ? current.length === 2 &&
          resumed.ack_count === 1 &&
          resumed.tool_results === 1 &&
          resumed.stop_reasons.join(",") === "toolUse,stop" &&
          resumed.thinking.some((entry) => entry.encrypted) &&
          resumed.thinking.every((entry) =>
            display === "omitted" ? entry.text_chars === 0 : entry.text_chars > 0,
          ) &&
          current[1]?.new_signature_replayed === true &&
          current[1]?.new_reasoning_replayed === true &&
          current[1]?.current_tool_results === 1
        : current.length === 1 &&
          resumed.tool_results === 0 &&
          resumed.ack_count === 0 &&
          resumed.stop_reasons.at(-1) === "error" &&
          (signatureCase === "nonempty-conflict"
            ? resumed.invalid_reasoning_error
            : resumed.transport_error) &&
          (display !== "omitted" || resumed.thinking.every((entry) => entry.text_chars === 0)),
    };
    const result = {
      case: name,
      model,
      display,
      signature_case: signatureCase,
      passed: Object.values(checks).every(Boolean),
      checks,
      requests,
      sdk,
      bootstrap,
      resumed,
      iterator_closed: iteratorClosed,
    };
    requireCondition(result.passed, `case_failed:${JSON.stringify(result)}`);
    return result;
  } finally {
    await server.stop(true);
    database.close();
  }
}

async function main(): Promise<void> {
  requireCondition(
    !process.argv.includes("--live-ab"),
    "live_ab_requires_separate_bounded_harness",
  );
  const binary = process.env.PI_PROBE_BINARY ?? Bun.which("pi");
  requireCondition(binary, "pi_binary_required");
  const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim();
  requireCondition(/^\d+\.\d+\.\d+$/.test(version), "pi_version_unrecognized");
  const root = mkdtempSync(join(tmpdir(), "kiro-pi-thinking-"));
  chmodSync(root, 0o700);
  writeFileSync(join(root, "extension.mjs"), extensionSource(), { mode: 0o600 });
  const originalError = console.error;
  const displayAudits: Array<{ event: string; fields_valid: boolean }> = [];
  console.error = (...values: unknown[]) => {
    try {
      const audit = record(JSON.parse(String(values[0])));
      if (audit.event === "responses_thinking_display_forced")
        displayAudits.push({
          event: audit.event,
          fields_valid:
            audit.protocol === "responses" &&
            audit.effective_display === "omitted" &&
            audit.effort === "max" &&
            ["claude-opus-5-5", "claude-opus-5.5", "claude-fable-5.1"].includes(
              String(audit.model),
            ) &&
            Object.keys(audit).every((key) =>
              [
                "timestamp",
                "level",
                "event",
                "protocol",
                "effective_display",
                "effort",
                "model",
              ].includes(key),
            ),
        });
    } catch {}
  };
  const outputIndex = process.argv.indexOf("--out");
  const output = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
  requireCondition(
    outputIndex < 0 || (typeof output === "string" && output.startsWith(`${tmpdir()}/`)),
    "temporary_evidence_path_required",
  );
  const runs: Array<Awaited<ReturnType<typeof runCase>>> = [];
  const models = (process.env.PI_PROBE_MODELS ?? "claude-opus-5-5,claude-fable-5-1").split(",");
  requireCondition(
    models.length > 0 &&
      models.every((model) => ["claude-opus-5-5", "claude-fable-5-1"].includes(model)),
    "invalid_fixture_models",
  );
  try {
    for (const model of models) {
      for (const display of ["preserve", "omitted"] as const) {
        for (const signatureCase of [
          "single",
          "duplicate",
          "late",
          "nonempty-conflict",
          "nonempty-transport-error",
        ] as const) {
          runs.push(await runCase(binary, root, model, display, signatureCase));
        }
      }
    }
    requireCondition(
      displayAudits.length === models.length * 8 &&
        displayAudits.every((audit) => audit.fields_valid),
      "display_audit_contract_failed",
    );
    const evidence = {
      schema_version: 1,
      client_version: version,
      live_upstream_calls: 0,
      passed: true,
      display_audit_count: displayAudits.length,
      audit_fields_valid: true,
      runs,
    };
    if (output)
      writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(
      JSON.stringify(
        {
          ...evidence,
          runs: runs.map((run) => ({
            case: run.case,
            passed: run.passed,
            checks: run.checks,
            requests: run.requests.length,
            sdk_dispatches: run.sdk.length,
            iterator_closed: run.iterator_closed,
          })),
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
  console.error(error instanceof Error ? error.message : "pi_thinking_display_probe_failed");
  process.exitCode = 1;
});
