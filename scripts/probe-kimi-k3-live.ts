#!/usr/bin/env bun
/**
 * Bounded real-client K3 probe. It never prepares/copies production credentials.
 * Prepare an isolated one-account fixture separately, then explicitly authorize
 * --execute with an exact candidate SHA and a client HTTP reservation budget.
 * SDK attempts and refreshes are observed, not absolutely capped by those flags.
 * The isolated account is made access-only before starting any candidate.
 *
 * bun scripts/probe-kimi-k3-live.ts --state-dir /tmp/isolated-k3 \
 *   --binary /tmp/kiro-provider --sha256 <candidate-sha> \
 *   --cases tool-roundtrip,low,high-image,stored-default --max-requests 5 --execute
 *
 * The tool chain retains original opaque token/output/IDs only in memory.
 * A failed or crashed reservation cannot be resumed or automatically replayed.
 * Direct Kiro native Responses returned HTTP 400 in the bounded historical
 * K3 probe. It is unsupported, not a provider-default success case. The stored
 * default case checks the provider's verified stateless/local-storage route.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { platformConfigRoot } from "../src/config/paths.js";
import { ConfigSchema } from "../src/config/schema.js";
import { privateProbeStateEnvironment, privateProbeStateIsolated } from "./probe-private-state.js";

type Json = Record<string, unknown>;
type CaseName = "tool-roundtrip" | "low" | "high-image" | "stored-default";
const CASES: readonly CaseName[] = ["tool-roundtrip", "low", "high-image", "stored-default"];
const COST: Record<CaseName, number> = {
  "tool-roundtrip": 2,
  low: 1,
  "high-image": 1,
  "stored-default": 1,
};
const AUDIT_EVENTS = new Set([
  "sdk_connection_pool_selected",
  "upstream_request_accepted",
  "upstream_headers_received",
  "sdk_stream_terminal",
  "sdk_reasoning_signature_observed",
  "request_cleanup_complete",
  "reasoning_replay_resolved",
  "native_responses_terminal",
]);
const RAW_EVENTS = new Set([
  "assistantResponseEvent",
  "reasoningContentEvent",
  "toolUseEvent",
  "metadataEvent",
  "meteringEvent",
  "contextUsageEvent",
  "messageMetadataEvent",
  "codeReferenceEvent",
]);
const TOOL = {
  type: "function",
  name: "synthetic_k3_lookup",
  description: "Return the fixed synthetic fixture value. Call once before answering.",
  parameters: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  },
};
const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    execute: { type: "boolean", default: false },
    "fake-provider": { type: "boolean", default: false },
    "state-dir": { type: "string" },
    binary: { type: "string" },
    sha256: { type: "string" },
    cases: { type: "string", default: CASES.join(",") },
    "max-requests": { type: "string", default: "5" },
  },
});
const cases = values.cases.split(",") as CaseName[];
if (cases.some((name) => !CASES.includes(name)) || new Set(cases).size !== cases.length) {
  throw new Error("Invalid or duplicate probe cases");
}
const budget = Number(values["max-requests"]);
const planned = cases.reduce((sum, name) => sum + COST[name], 0);
if (!Number.isInteger(budget) || budget < 1 || budget > 5 || planned > budget) {
  throw new Error("The selected matrix exceeds the explicit request budget (maximum 5)");
}
if (!values.execute) {
  console.log(
    JSON.stringify({
      phase: "dry_run",
      generation_calls: 0,
      cases,
      planned_requests: planned,
      request_budget: budget,
    }),
  );
  process.exit(0);
}
if (
  !values["state-dir"] ||
  !values.binary ||
  !values.sha256 ||
  !/^[a-f0-9]{64}$/.test(values.sha256)
) {
  throw new Error("Execution requires --state-dir, --binary, and an exact --sha256");
}
if (!isAbsolute(values["state-dir"]) || !isAbsolute(values.binary))
  throw new Error("Use absolute fixture and binary paths");
const stateDir = realpathSync(values["state-dir"]);
const dbPath = join(stateDir, "xdg", "kiro-provider", "accounts.db");
const configPath = join(stateDir, "xdg", "kiro-provider", "config.json");
if (stateDir === realpathSync(".") || stateDir === "/") {
  throw new Error("A separate, non-symlink isolated state fixture is required");
}
for (const path of [dbPath, configPath]) {
  const info = lstatSync(path);
  const actual = realpathSync(path);
  const production = join(
    platformConfigRoot(),
    "kiro-provider",
    path === dbPath ? "accounts.db" : "config.json",
  );
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !actual.startsWith(stateDir + sep) ||
    (existsSync(production) && actual === realpathSync(production))
  ) {
    throw new Error(
      "Unsafe isolated fixture file: symlink, hardlink, outside-root or production target",
    );
  }
}
const preparation = JSON.parse(readFileSync(join(stateDir, "prepared.json"), "utf8")) as Json;
if (
  preparation.copied_accounts !== 1 ||
  preparation.fresh_tenant !== true ||
  preparation.fresh_replay_keyring !== true
) {
  throw new Error("Missing one-account/fresh-tenant/fresh-keyring isolation evidence");
}
const candidateSha = createHash("sha256").update(readFileSync(values.binary)).digest("hex");
if (candidateSha !== values.sha256) throw new Error("Candidate SHA mismatch");
const source = new Database(dbPath, { readonly: true, strict: true });
try {
  const row = source
    .query<{ total: number; eligible: number }, [number]>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN is_healthy=1 AND region='us-east-1' AND length(access_token)>0 AND expires_at>? AND profile_arn LIKE 'arn:aws:codewhisperer:us-east-1:%:profile/%' THEN 1 ELSE 0 END) AS eligible FROM accounts",
    )
    .get(Date.now() + planned * 130_000 + 60_000);
  if (row?.total !== 1 || row.eligible !== 1)
    throw new Error(
      "Fixture is not fresh enough for the complete bounded matrix; do not refresh production",
    );
} finally {
  source.close();
}
// Claim the durable run before changing configuration, credentials, or keys.
// Re-execution must not rotate even an isolated key or edit its config first.
const ledgerPath = join(stateDir, "kimi-k3-live-ledger.json");
const lock = openSync(ledgerPath, "wx", 0o600);
closeSync(lock);
const privateDir = mkdtempSync(join(stateDir, "probe-private-"));
const accessOnly = new Database(dbPath, { strict: true });
try {
  accessOnly.run("PRAGMA secure_delete = ON");
  accessOnly
    .query(
      "UPDATE accounts SET refresh_token = '', client_id = CASE WHEN auth_method = 'idc' THEN 'synthetic-probe-client-id' ELSE NULL END, client_secret = CASE WHEN auth_method = 'idc' THEN 'synthetic-probe-client-secret' ELSE NULL END, generation = generation + 1",
    )
    .run();
  accessOnly.run("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  accessOnly.close();
}
// Do not spread fixture configuration: it may name external keyrings, locks,
// legacy credential databases, test endpoints, or proxies. None are inherited.
const config = ConfigSchema.parse({
  api_keys: [`sk-k3-probe-${randomBytes(24).toString("hex")}`],
  reasoning_replay_keys: [`isolated:${randomBytes(32).toString("base64url")}`],
  reasoning_replay_key_path: join(privateDir, "reasoning-keyring.json"),
  instance_lock_path: join(privateDir, "instance.lock"),
  auth_source: "local",
  opencode_auth_db_path: null,
  proxy_url: null,
  protocol_projection_mode: "v3-auto",
  account_maintenance_enabled: false,
  dynamic_model_catalog: false,
  request_timeout_ms: 120_000,
  stream_idle_timeout_ms: 110_000,
  stream_max_attempts: 1,
  rate_limit_max_retries: 0,
  retry_empty_completion: false,
  max_inflight_requests: 1,
  account_inference_concurrency: 1,
  token_expiry_buffer_ms: 1,
  log_level: "debug",
});
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const ledger: {
  version: number;
  candidate_sha: string;
  request_budget: number;
  request_budget_kind: "client_http_reservations";
  access_only_fixture: true;
  reserved_requests: number;
  phase: string;
  records: Json[];
  child_reaped?: boolean;
  child_exit?: number | null;
  raw_capture_persisted: boolean;
  fake_provider: boolean;
  private_state_for_all_platforms?: boolean;
  isolated_provider_stored_response_count?: number;
} = {
  version: 1,
  candidate_sha: candidateSha,
  request_budget: budget,
  request_budget_kind: "client_http_reservations",
  access_only_fixture: true,
  reserved_requests: 0,
  phase: "starting",
  records: [],
  raw_capture_persisted: false,
  fake_provider: values["fake-provider"],
};
const persist = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
persist();

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function increment(record: Json, key: string) {
  record[key] = Number(record[key] ?? 0) + 1;
}
let active: Json | undefined;
function observe(line: string) {
  let event: Json;
  try {
    event = object(JSON.parse(line));
  } catch {
    return;
  }
  if (!active || typeof event.event !== "string") return;
  if (event.event.includes("token_refresh") || event.event.includes("usage_refresh"))
    increment(active, "refresh_events");
  if (!AUDIT_EVENTS.has(event.event)) return;
  const counts = object(active.audit_event_counts);
  increment(counts, event.event);
  active.audit_event_counts = counts;
  if (event.event === "sdk_connection_pool_selected") {
    increment(active, "sdk_attempts");
    active.effective_effort = ["low", "high", "max"].includes(String(event.effort))
      ? event.effort
      : null;
  }
  if (event.event === "request_cleanup_complete") increment(active, "cleanup_events");
  if (event.event === "native_responses_terminal") {
    active.native_terminal = {
      attempt: numeric(event.attempt),
      http_status: numeric(event.http_status),
      completion_witnessed: event.completion_witnessed === true,
      response_status: ["completed", "failed", "incomplete", "cancelled"].includes(
        String(event.response_status),
      )
        ? event.response_status
        : "other",
      terminal_event: [
        "response.completed",
        "response.failed",
        "response.incomplete",
        "response.cancelled",
      ].includes(String(event.terminal_event))
        ? event.terminal_event
        : "other",
    };
  }
  if (event.event === "sdk_stream_terminal") {
    let raw: Json = {};
    try {
      raw = object(JSON.parse(String(event.event_type_counts)));
    } catch {}
    active.terminal = {
      attempt: numeric(event.attempt),
      effort: ["low", "high", "max"].includes(String(event.effort)) ? event.effort : null,
      canonical_reasoning_chars: numeric(event.reasoning_chars),
      visible_chars: numeric(event.visible_chars),
      completion_witnessed: event.completion_witnessed === true,
      terminal_provenance: [
        "normal_complete",
        "upstream_error",
        "external_abort",
        "idle_timeout",
      ].includes(String(event.terminal_provenance))
        ? event.terminal_provenance
        : "other",
      raw_event_count: numeric(event.raw_event_count),
      event_type_counts: Object.fromEntries(
        Object.entries(raw).filter(
          ([name, count]) => RAW_EVENTS.has(name) && typeof count === "number",
        ),
      ),
    };
  }
  if (event.event === "sdk_reasoning_signature_observed") {
    increment(active, "signature_events");
    const lengths = object(active.signature_lengths);
    const relations = object(active.signature_relations);
    const length = numeric(event.signature_bytes);
    if (length !== undefined) increment(lengths, String(length));
    const relation = ["first", "duplicate", "extends", "shorter-prefix", "distinct"].includes(
      String(event.signature_relation),
    )
      ? String(event.signature_relation)
      : "other";
    increment(relations, relation);
    active.signature_lengths = lengths;
    active.signature_relations = relations;
  }
}
async function consume(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    const lines = (tail + decoder.decode(part.value, { stream: true })).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) observe(line);
  }
  if (tail) observe(tail);
}
const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});
const port = reservation.port;
reservation.stop(true);
const env = privateProbeStateEnvironment(
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KIRO_PROVIDER_")),
  ),
  join(stateDir, "xdg"),
);
ledger.private_state_for_all_platforms = privateProbeStateIsolated(env, join(stateDir, "xdg"));
if (!ledger.private_state_for_all_platforms) {
  throw new Error("Candidate state root is not private on every platform");
}
persist();
// This explicit test mode starts only a local synthetic provider: no SDK,
// credentials, external model call, or real candidate process is used.
const fake = values["fake-provider"]
  ? Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        if (new URL(request.url).pathname === "/health") return new Response("OK");
        const body = object(await request.json());
        const nativeRequested =
          body.store === true && body.reasoning === undefined && body.include === undefined;
        const native =
          nativeRequested &&
          config.protocol_projection_mode === "v3-auto" &&
          body.model !== "kimi-k3";
        const input = Array.isArray(body.input) ? body.input.map(object) : [];
        const result = input.find((item) => item.type === "function_call_output");
        const declared = Array.isArray(body.tools) ? body.tools.map(object) : [];
        const firstTool = declared.length > 0 && result === undefined;
        if (
          result &&
          (result.call_id !== "call_fake_k3" ||
            !input.some(
              (item) => item.type === "reasoning" && item.encrypted_content === "kr2_fake_k3_token",
            ))
        ) {
          return Response.json({ error: { code: "invalid_reasoning_replay" } }, { status: 400 });
        }
        const image = input.some(
          (item) =>
            Array.isArray(item.content) &&
            item.content.some((part: unknown) => object(part).type === "input_image"),
        );
        const answer = nativeRequested
          ? "K3_STORED_OK"
          : image
            ? "RED"
            : result
              ? "K3_TOOL_OK"
              : firstTool
                ? ""
                : "K3_EFFORT_OK";
        const reasoning = {
          type: "reasoning",
          id: "rs_fake",
          summary: [{ type: "summary_text", text: "fixture" }],
          encrypted_content: "kr2_fake_k3_token",
        };
        const output = [
          ...(!native ? [reasoning] : []),
          ...(firstTool
            ? [
                {
                  type: "function_call",
                  id: "fc_fake",
                  call_id: "call_fake_k3",
                  name: TOOL.name,
                  arguments: '{"value":41}',
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  id: "msg_fake",
                  content: [{ type: "output_text", text: answer }],
                },
              ]),
        ];
        const effort = object(body.reasoning).effort ?? "max";
        const emit = (event: Json) => observe(JSON.stringify(event));
        if (result) emit({ event: "reasoning_replay_resolved" });
        if (!native) {
          emit({ event: "sdk_connection_pool_selected", effort });
          emit({
            event: "sdk_reasoning_signature_observed",
            signature_bytes: 218,
            signature_relation: "first",
          });
          emit({
            event: "sdk_stream_terminal",
            attempt: 1,
            effort,
            reasoning_chars: 7,
            visible_chars: answer.length,
            raw_event_count: 3,
            event_type_counts: JSON.stringify({
              reasoningContentEvent: 1,
              assistantResponseEvent: 1,
              meteringEvent: 1,
            }),
            completion_witnessed: true,
            terminal_provenance: "normal_complete",
          });
        }
        emit({ event: "upstream_request_accepted" });
        emit({ event: "request_cleanup_complete" });
        const events = [
          ...(!native ? [{ type: "response.reasoning_summary_text.delta", delta: "fixture" }] : []),
          { type: "response.output_text.delta", delta: answer },
          { type: "response.completed", response: { output } },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: {
            "content-type": "text/event-stream",
            "x-kiro-transport": native ? "native" : "stateless",
          },
        });
      },
    })
  : undefined;
const child = fake
  ? undefined
  : Bun.spawn({
      cmd: [
        values.binary,
        "serve",
        "--config",
        configPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
const readers = child
  ? Promise.all([consume(child.stdout), consume(child.stderr)])
  : Promise.resolve();
const origin = `http://127.0.0.1:${port}`;
async function generate(name: string, request: Json): Promise<Json[]> {
  if (ledger.reserved_requests >= budget) throw new Error("Request budget exhausted");
  const record: Json = {
    case: name,
    reservation: ++ledger.reserved_requests,
    phase: "reserved_before_dispatch",
    sdk_attempts: 0,
    cleanup_events: 0,
    refresh_events: 0,
    signature_events: 0,
    signature_lengths: {},
    signature_relations: {},
    audit_event_counts: {},
    projection_mode: config.protocol_projection_mode,
    request_store: request.store === true,
    requested_effort: ["low", "high", "max"].includes(String(object(request.reasoning).effort))
      ? object(request.reasoning).effort
      : "unspecified",
  };
  ledger.records.push(record);
  active = record;
  persist(); // A crash after this point consumes the reservation, never retries it.
  const started = performance.now();
  try {
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.api_keys[0]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-k3",
        store: false,
        stream: true,
        tools: [],
        tool_choice: "none",
        include: ["reasoning.encrypted_content"],
        ...request,
      }),
      signal: AbortSignal.timeout(130_000),
    });
    record.http_status = response.status;
    const expectedTransport = "stateless";
    record.expected_transport = expectedTransport;
    record.transport = response.headers.get("x-kiro-transport");
    record.forced_display =
      response.headers.get("x-kiro-thinking-display-mode") === "forced-omitted";
    const wire = await response.text(); // Private output stays in memory only.
    if (!response.ok) {
      try {
        const code = object(object(JSON.parse(wire)).error).code;
        record.error_code = [
          "unsupported_model",
          "unsupported_reasoning_effort",
          "unsupported_response_semantics",
          "invalid_reasoning_replay",
          "invalid_upstream_reasoning",
          "context_length_exceeded",
          "all_accounts_exhausted",
          "rate_limit_exceeded",
          "upstream_http_error",
          "native_responses_unavailable",
          "request_timeout",
        ].includes(String(code))
          ? code
          : "other_http_error";
      } catch {
        record.error_code = "other_http_error";
      }
    }
    let output: Json[] = [];
    let publicReasoningChars = 0;
    let publicTextChars = 0;
    let publicText = "";
    let completed = false;
    for (const line of wire.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = object(JSON.parse(line.slice(6)));
      if (event.type === "response.reasoning_summary_text.delta")
        publicReasoningChars += typeof event.delta === "string" ? event.delta.length : 0;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        publicTextChars += event.delta.length;
        publicText += event.delta;
      }
      if (event.type === "response.completed") {
        completed = true;
        const items = object(event.response).output;
        output = Array.isArray(items) ? items.map(object) : [];
      }
    }
    record.completed = completed;
    record.public_reasoning_chars = publicReasoningChars;
    record.public_text_chars = publicTextChars;
    record.opaque_token_items = output.filter(
      (item) => item.type === "reasoning" && typeof item.encrypted_content === "string",
    ).length;
    record.tool_items = output.filter(
      (item) => item.type === "function_call" || item.type === "custom_tool_call",
    ).length;
    const expectedMarker =
      name === "high-image"
        ? "RED"
        : name === "tool-continuation"
          ? "K3_TOOL_OK"
          : name === "stored-default"
            ? "K3_STORED_OK"
            : "K3_EFFORT_OK";
    record.expected_marker_observed = name === "tool-first" || publicText.includes(expectedMarker);
    const deadline = performance.now() + 3_000;
    while (Number(record.cleanup_events) === 0 && performance.now() < deadline) await Bun.sleep(10);
    record.phase = response.ok && completed ? "completed" : "terminal_failure";
    if (
      !response.ok ||
      !completed ||
      record.transport !== expectedTransport ||
      Number(record.sdk_attempts) !== 1 ||
      Number(record.refresh_events) !== 0 ||
      Number(record.cleanup_events) !== 1 ||
      record.expected_marker_observed !== true
    ) {
      throw new Error("A bounded case failed; stop without retrying");
    }
    return output;
  } catch (error) {
    record.phase = "terminal_failure_no_retry";
    throw error;
  } finally {
    record.elapsed_ms = Math.round(performance.now() - started);
    persist();
  }
}

// One tiny 32x32 RGB-red PNG made in memory, with no user attachment.
function redPng(): string {
  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.from([0, 0, 0, 32, 0, 0, 0, 32, 8, 2, 0, 0, 0]);
  const pixels = Buffer.alloc(32 * (1 + 32 * 3));
  for (let row = 0; row < 32; row++)
    for (let column = 0; column < 32; column++) {
      pixels[row * (1 + 32 * 3) + 1 + column * 3] = 255;
    }
  return (
    "data:image/png;base64," +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64")
  );
}
try {
  let ready = false;
  const deadline = performance.now() + 10_000;
  while (!ready && performance.now() < deadline && (!child || child.exitCode === null)) {
    try {
      ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) throw new Error("Candidate did not start; no generation sent");
  ledger.phase = "running";
  persist();
  for (const name of cases) {
    if (name === "tool-roundtrip") {
      const user = {
        role: "user",
        content:
          "Call synthetic_k3_lookup exactly once with value 41. Wait for its result before answering.",
      };
      const first = await generate("tool-first", {
        tools: [TOOL],
        tool_choice: "auto",
        reasoning: { effort: "max" },
        input: [user],
      });
      const calls = first.filter((item) => item.type === "function_call");
      const call = calls[0];
      const hasToken = first.some(
        (item) =>
          item.type === "reasoning" &&
          typeof item.encrypted_content === "string" &&
          item.encrypted_content.startsWith("kr2_"),
      );
      let validArgs = false;
      try {
        validArgs = object(JSON.parse(String(call?.arguments))).value === 41;
      } catch {}
      if (
        !hasToken ||
        calls.length !== 1 ||
        call?.name !== TOOL.name ||
        typeof call.call_id !== "string" ||
        !validArgs
      ) {
        throw new Error(
          "Tool first generation lacks exact replay prerequisites; do not replace or retry it",
        );
      }
      try {
        await generate("tool-continuation", {
          tools: [TOOL],
          tool_choice: "auto",
          reasoning: { effort: "max" },
          input: [
            user,
            ...first,
            { type: "function_call_output", call_id: call.call_id, output: "41" },
            {
              role: "user",
              content: "Use the returned fixture value and answer exactly K3_TOOL_OK.",
            },
          ],
        });
      } finally {
        first.length = 0;
      }
    } else if (name === "high-image") {
      await generate(name, {
        reasoning: { effort: "high" },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Identify the predominant color; answer only its uppercase English color name.",
              },
              { type: "input_image", image_url: redPng(), detail: "auto" },
            ],
          },
        ],
      });
    } else if (name === "stored-default") {
      await generate(name, {
        store: true,
        include: undefined,
        input: "Work out 17 times 19, then answer exactly K3_STORED_OK.",
      });
    } else {
      await generate(name, {
        reasoning: { effort: name },
        input: "Work out 17 times 19, then answer exactly K3_EFFORT_OK.",
      });
    }
  }
  ledger.phase = "completed";
} catch {
  ledger.phase = "stopped_without_retry";
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(4_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  fake?.stop(true);
  await readers;
  ledger.child_reaped = !child || child.exitCode !== null;
  ledger.child_exit = child?.exitCode ?? 0;
  const finalState = new Database(dbPath, { readonly: true, strict: true });
  try {
    ledger.isolated_provider_stored_response_count =
      finalState
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM stored_responses")
        .get()?.count ?? 0;
  } finally {
    finalState.close();
  }
  persist();
  console.log(JSON.stringify(ledger));
}
