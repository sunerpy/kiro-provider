/**
 * Default: installed Claude/Pi/Codex wire-shape probe; never calls Kiro.
 * Runs a synthetic HTTP endpoint and clients in a private network namespace.
 * Execution requires Linux, bubblewrap, /proc and Unix sockets; other platforms fail closed.
 * bun scripts/probe-kimi-clients.ts --claude-bin /absolute/claude --pi-bin /absolute/pi
 *   --codex-bin /absolute/codex
 *   [--out /tmp/kimi-k3-client-evidence.json]
 * A successful fixture response is not evidence that the Kiro Messages adapter
 * accepts the captured request: that compatibility is reported separately.
 * Optional, explicit one-shot live mode additionally requires --confirm-live,
 * --live-candidate-url http://127.0.0.1:NON_PRODUCTION_PORT and --provider-config.
 * The private namespace can reach that exact candidate only through a Unix bridge.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { defaultConfigPath } from "../src/config/paths.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { handleModels } from "../src/server/routes/models.js";

type Row = Record<string, unknown>;
type Effort = "low" | "high" | "max";
type Wire = {
  protocol: "messages" | "responses";
  model: string;
  effort: string | null;
  thinking_type: string | null;
  budget_present: boolean;
  display_present: boolean;
  max_tokens: number | null;
  max_output_tokens_present: boolean;
  advisory_header: boolean;
  declared_tools: number;
  body_bytes: number;
  messages_contract_compatible: boolean;
  provider_preflight_ok: boolean | null;
  provider_preflight_code: string | null;
  provider_preflight_param: string | null;
};
const KEY = "synthetic-kimi-client-key";
const ACK = "SYNTHETIC_KIMI_CLIENT_OK";
const MODEL = "kimi-k3";
const LEVELS: readonly Effort[] = ["low", "high", "max"];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}
function save(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function requireKimiProbePlatform(platform: string): void {
  requireCondition(platform === "linux", "kimi_client_probe_requires_linux");
}

/** The namespace runner is Linux-only; never execute a client on an unsupported host. */
export async function runKimiClientProbeOnPlatform<T>(
  platform: string,
  execute: () => Promise<T>,
): Promise<T> {
  requireKimiProbePlatform(platform);
  return execute();
}

/** POSIX policy is pure so every CI platform can test the Linux safety boundary. */
export function privateCandidatePathAllowed(path: string, temporaryRoot: string): boolean {
  if (!posix.isAbsolute(path)) return false;
  return [temporaryRoot, "/config/.cache"].some((root) => {
    if (!posix.isAbsolute(root) || root === "/") return false;
    const relative = posix.relative(root, path);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !posix.isAbsolute(relative)
    );
  });
}

export function requirePrivateCandidateOwner(facts: {
  ownerUid: number | undefined;
  file: { regular: boolean; nlink: number; mode: number; uid: number };
  directory: { directory: boolean; mode: number; uid: number };
}): void {
  const knownOwner =
    facts.ownerUid !== undefined && Number.isSafeInteger(facts.ownerUid) && facts.ownerUid >= 0;
  requireCondition(
    knownOwner &&
      facts.file.regular &&
      facts.file.nlink === 1 &&
      (facts.file.mode & 0o077) === 0 &&
      facts.file.uid === facts.ownerUid,
    "owner_only_regular_candidate_config_required",
  );
  requireCondition(
    facts.directory.directory &&
      facts.directory.uid === facts.ownerUid &&
      (facts.directory.mode & 0o077) === 0,
    "owner_only_candidate_directory_required",
  );
}

export function readPrivateCandidateConfig(path: string, production?: string): Row {
  // Check platform before resolving defaults or touching any candidate/production file.
  requireKimiProbePlatform(process.platform);
  requireCondition(
    privateCandidatePathAllowed(resolve(path), tmpdir()),
    "private_candidate_config_required",
  );
  requireCondition(realpathSync(path) === resolve(path), "candidate_config_must_not_be_symlinked");
  const file = statSync(path),
    directory = statSync(dirname(path));
  requirePrivateCandidateOwner({
    ownerUid: process.getuid?.(),
    file: { regular: file.isFile(), nlink: file.nlink, mode: file.mode, uid: file.uid },
    directory: { directory: directory.isDirectory(), mode: directory.mode, uid: directory.uid },
  });
  const productionPath = production ?? defaultConfigPath();
  requireCondition(
    !existsSync(productionPath) || realpathSync(path) !== realpathSync(productionPath),
    "production_config_forbidden",
  );
  return record(JSON.parse(readFileSync(path, "utf8")));
}

async function liveClaude(root: string, binary: string, socket: string): Promise<Row> {
  requireCondition(socket === join(root, "bridge.sock"), "private_bridge_socket_required");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 8787,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/messages")
        return new Response(null, { status: 404 });
      return fetch(`http://unix-bridge/v1/messages`, {
        unix: socket,
        method: "POST",
        headers: request.headers,
        body: await request.arrayBuffer(),
        signal: request.signal,
      });
    },
  });
  save(join(root, "provider.json"), { api_keys: [KEY] });
  const child = Bun.spawn(
    [
      "sh",
      resolve(import.meta.dir, "kiroclaude"),
      "--bare",
      "--safe-mode",
      "--model",
      "kimi-k3[1m]",
      "--effort",
      "max",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--system-prompt",
      "Follow the current transport validation instruction exactly.",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      `Do not use tools. Reply with exactly ${ACK} and no other text.`,
    ],
    {
      cwd: join(root, "project"),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        XDG_CACHE_HOME: join(root, "cache"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        KIROCLAUDE_CLAUDE_BIN: binary,
        KIROCLAUDE_PROVIDER_CONFIG: join(root, "provider.json"),
        KIROCLAUDE_TOKEN_HELPER: join(root, "key.sh"),
        KIROCLAUDE_BASE_URL: "http://127.0.0.1:8787",
        KIROCLAUDE_EFFORT: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(9), 130_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let acknowledged = false,
      tools = 0;
    for (const line of stdout.split("\n"))
      try {
        const event = record(JSON.parse(line));
        if (
          event.type === "result" &&
          event.subtype === "success" &&
          event.is_error !== true &&
          event.result === ACK
        )
          acknowledged = true;
        const message = record(event.message);
        if (Array.isArray(message.content))
          tools += message.content.filter((block) => record(block).type === "tool_use").length;
      } catch {}
    return {
      client: "claude",
      effort: "max",
      exit_code: code,
      acknowledged,
      tool_executions: tools,
      stderr_bytes: Buffer.byteLength(stderr),
      passed: code === 0 && acknowledged && tools === 0,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill(9);
      await child.exited;
    }
    await server.stop(true);
  }
}

export function createCandidateBridgeHandler(
  base: URL,
  config: Row,
  ledger: string,
  forward: (url: URL, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
) {
  const keys = config.api_keys;
  requireCondition(
    Array.isArray(keys) && typeof keys[0] === "string" && keys[0].trim(),
    "candidate_key_required",
  );
  requireCondition(config.port === Number(base.port), "candidate_config_port_mismatch");
  requireCondition(
    config.stream_max_attempts === 1 &&
      config.rate_limit_max_retries === 0 &&
      config.retry_empty_completion === false,
    "candidate_retries_must_be_disabled",
  );
  const evidence = {
    target_port: Number(base.port),
    exact_candidate_target: true,
    forwarded_requests: 0,
    inbound_requests: 0,
    inbound_request_budget: 2,
    local_capability_rejections: 0,
    budget_rejections: 0,
    request_budget: 1,
    native_synthetic_key_verified: false,
    candidate_config_key_injected: false,
    protocol: "messages",
    model: MODEL,
    effort: "max",
    thinking_type: null as string | null,
    budget_present: false,
    display_present: false,
    advisory_header: false,
    tools_count: 0,
    response_status: 0,
    preflight_error_code: null as string | null,
    preflight_error_param: null as string | null,
    advisory_response: false,
    stream_stop_events: 0,
    stream_error_events: 0,
  };
  const handler = {
    async fetch(request: Request) {
      evidence.inbound_requests++;
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/messages" ||
        evidence.forwarded_requests !== 0 ||
        evidence.inbound_requests > 2
      ) {
        if (evidence.forwarded_requests !== 0) evidence.budget_rejections++;
        return new Response(null, { status: 400 });
      }
      if (
        request.headers.get("authorization") !== `Bearer ${KEY}` &&
        request.headers.get("x-api-key") !== KEY
      )
        return new Response(null, { status: 401 });
      evidence.native_synthetic_key_verified = true;
      const raw = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      const body = record(JSON.parse(decoded.toString("utf8"))),
        thinking = record(body.thinking);
      evidence.thinking_type = typeof thinking.type === "string" ? thinking.type : null;
      evidence.budget_present = Object.hasOwn(thinking, "budget_tokens");
      evidence.display_present = Object.hasOwn(thinking, "display");
      evidence.advisory_header =
        request.headers.get("x-kiro-output-token-limit-mode") === "advisory";
      evidence.tools_count = Array.isArray(body.tools) ? body.tools.length : 0;
      if (
        body.model !== MODEL ||
        record(body.output_config).effort !== "max" ||
        !evidence.advisory_header ||
        evidence.tools_count !== 0 ||
        evidence.budget_present ||
        evidence.display_present ||
        (body.thinking !== undefined && thinking.type !== "adaptive")
      )
        return new Response(null, { status: 400 });
      const preflight = adaptAnthropicMessagesRequest(
        body,
        { requireMaxTokens: true, unsupportedOutputTokenLimitMode: "advisory" },
        "legacy-user-prefix",
      );
      if (!preflight.ok) {
        if (preflight.code === "unsupported_parameter" && preflight.param === "safeguards") {
          if (evidence.local_capability_rejections !== 0)
            return new Response(null, { status: 409 });
          try {
            writeFileSync(
              `${ledger}.preflight.lock`,
              `${JSON.stringify({ code: preflight.code, param: preflight.param })}\n`,
              { flag: "wx", mode: 0o600 },
            );
          } catch (error) {
            if (record(error).code !== "EEXIST") throw error;
            return new Response(null, { status: 409 });
          }
          evidence.local_capability_rejections++;
        }
        evidence.preflight_error_code = typeof preflight.code === "string" ? preflight.code : null;
        evidence.preflight_error_param =
          preflight.param === "safeguards" || preflight.param === "temperature"
            ? preflight.param
            : null;
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: preflight.message,
              code: preflight.code,
              param: preflight.param,
            },
          },
          { status: 400 },
        );
      }
      // Both requests may have passed the first check before arrayBuffer()
      // yielded. Reserve synchronously after validation, before any forwarding.
      if (evidence.forwarded_requests !== 0) {
        evidence.budget_rejections++;
        return new Response(null, { status: 400 });
      }
      try {
        const reservation = `${JSON.stringify({ phase: "reserved", http_request_budget: 1, timestamp: new Date().toISOString() })}\n`;
        writeFileSync(ledger, reservation, { flag: "wx", mode: 0o600 });
        writeFileSync(`${ledger}.dispatch.lock`, reservation, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (record(error).code !== "EEXIST") throw error;
        evidence.budget_rejections++;
        return new Response(null, { status: 409 });
      }
      evidence.forwarded_requests++;
      const headers = new Headers(request.headers);
      for (const name of ["host", "content-length", "content-encoding", "x-api-key"])
        headers.delete(name);
      headers.set("authorization", `Bearer ${keys[0].trim()}`);
      evidence.candidate_config_key_injected = true;
      save(ledger, {
        schema_version: 1,
        phase: "dispatch_started",
        timestamp: new Date().toISOString(),
        private_network_namespace: true,
        candidate_http_request_budget: 1,
        bridge: evidence,
      });
      const response = await forward(new URL("/v1/messages", base), {
        method: "POST",
        headers,
        body: decoded,
        signal: request.signal,
      });
      evidence.response_status = response.status;
      if (response.status === 400) {
        try {
          const error = record(record(await response.clone().json()).error);
          if (typeof error.code === "string" && /^[a-z_]+$/.test(error.code))
            evidence.preflight_error_code = error.code;
          if (typeof error.param === "string" && /^[A-Za-z0-9_.[\]]+$/.test(error.param))
            evidence.preflight_error_param = error.param;
        } catch {}
      }
      evidence.advisory_response =
        response.headers.get("x-kiro-output-token-limit-mode") === "advisory-unenforced";
      let pending = "";
      const inspected = response.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            pending += Buffer.from(chunk).toString("utf8");
            while (pending.includes("\n\n")) {
              const at = pending.indexOf("\n\n");
              const frame = pending.slice(0, at);
              pending = pending.slice(at + 2);
              if (/^event: message_stop$/m.test(frame)) evidence.stream_stop_events++;
              if (/^event: error$/m.test(frame)) evidence.stream_error_events++;
            }
          },
        }),
      );
      return new Response(inspected ?? null, {
        status: response.status,
        headers: response.headers,
      });
    },
  };
  return { fetch: handler.fetch, evidence };
}

function candidateBridge(root: string, base: URL, config: Row, ledger: string) {
  const handler = createCandidateBridgeHandler(base, config, ledger);
  const server = Bun.serve({ unix: join(root, "bridge.sock"), fetch: handler.fetch });
  return { server, evidence: handler.evidence };
}
function fixtureResponse(protocol: Wire["protocol"], stream: boolean): Response {
  if (protocol === "messages") {
    const message = {
      id: "msg_synthetic_kimi",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: ACK }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    };
    if (!stream) return Response.json(message);
    const events = [
      [
        "message_start",
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ACK } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 8 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(
      events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const item = {
    id: "msg_synthetic_kimi",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: ACK, annotations: [] }],
  };
  const response = {
    id: "resp_synthetic_kimi",
    object: "response",
    created_at: 1,
    status: "completed",
    model: MODEL,
    output: [item],
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (!stream) return Response.json(response);
  const events = [
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
      delta: ACK,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: ACK,
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
  ];
  return new Response(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function codexCatalog(
  binary: string,
  root: string,
  configuration: string[],
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn([binary, ...configuration, "app-server", "--listen", "stdio://"], {
    cwd: join(root, "project"),
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let pending = "",
    model: Row | undefined,
    failure: string | undefined;
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => {
    failure = "model_list_timeout";
    child.kill(9);
  }, 15_000);
  const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "synthetic-kimi-catalog", version: "1" } },
  });
  const stderr = new Response(child.stderr).text();
  try {
    while (!model && !failure) {
      const next = await reader.read();
      if (next.done) break;
      pending += Buffer.from(next.value).toString("utf8");
      while (pending.includes("\n")) {
        const at = pending.indexOf("\n");
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        try {
          const message = record(JSON.parse(line));
          if (message.id === 1) {
            if (message.error) {
              failure = "initialize_failed";
              break;
            }
            write({ jsonrpc: "2.0", method: "initialized", params: {} });
            write({ jsonrpc: "2.0", id: 2, method: "model/list", params: { includeHidden: true } });
          }
          if (message.id === 2) {
            const result = record(message.result);
            const rows = Array.isArray(result.data) ? result.data.map(record) : [];
            model = rows.find((item) => item.model === MODEL || item.id === MODEL);
            if (!model) failure = "kimi_missing_from_model_list";
          }
        } catch {}
      }
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill(9);
    await child.exited;
    reader.releaseLock();
  }
  const levels = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map(
        (item) => record(item).reasoningEffort ?? record(item).effort,
      )
    : [];
  return {
    present: Boolean(model),
    model: model?.model ?? model?.id ?? null,
    reasoning_levels: levels,
    default_reasoning_level: model?.defaultReasoningEffort ?? null,
    failure: failure ?? null,
    stderr_bytes: Buffer.byteLength(await stderr),
    passed:
      Boolean(model) &&
      JSON.stringify(levels) === JSON.stringify(LEVELS) &&
      model?.defaultReasoningEffort === "max",
  };
}

async function worker(root: string, claude: string, pi: string, codex: string) {
  const captures: Wire[] = [];
  const catalog = record(await handleModels().json());
  const models = Array.isArray(catalog.models) ? catalog.models.map(record) : [];
  const kimi = models.find((entry) => entry.slug === MODEL);
  requireCondition(
    kimi && kimi.output_limit === 131072 && kimi.context_window === 1000000,
    "provider_kimi_catalog_required",
  );
  const catalogPath = join(root, "catalog.json");
  save(catalogPath, catalog);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 8787,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) return Response.json(catalog);
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 20 });
      const protocol = url.pathname.endsWith("/messages")
        ? "messages"
        : url.pathname.endsWith("/responses")
          ? "responses"
          : undefined;
      if (!protocol) return Response.json({ ok: true });
      if (
        request.headers.get("authorization") !== `Bearer ${KEY}` &&
        request.headers.get("x-api-key") !== KEY
      )
        return Response.json(
          { error: { type: "authentication_error", message: "Synthetic key required" } },
          { status: 401 },
        );
      const raw = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      const body = record(JSON.parse(decoded.toString("utf8")));
      const thinking = record(body.thinking);
      const effort = record(body.output_config).effort ?? record(body.reasoning).effort;
      const compatible =
        protocol === "messages" &&
        (body.thinking === undefined || thinking.type === "adaptive") &&
        !Object.hasOwn(thinking, "budget_tokens") &&
        !Object.hasOwn(thinking, "display") &&
        (effort === undefined || LEVELS.includes(effort as Effort));
      const adapted =
        protocol === "messages"
          ? adaptAnthropicMessagesRequest(
              body,
              { requireMaxTokens: true, unsupportedOutputTokenLimitMode: "advisory" },
              "legacy-user-prefix",
            )
          : undefined;
      const allowedParams = new Set([
        "safeguards",
        "thinking",
        "thinking.display",
        "thinking.budget_tokens",
        "temperature",
        "max_tokens",
        "output_config",
        "output_config.effort",
        "context_management",
        "system",
        "metadata",
        "tool_choice",
      ]);
      captures.push({
        protocol,
        model: String(body.model),
        effort: typeof effort === "string" ? effort : null,
        thinking_type: typeof thinking.type === "string" ? thinking.type : null,
        budget_present: Object.hasOwn(thinking, "budget_tokens"),
        display_present: Object.hasOwn(thinking, "display"),
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
        max_output_tokens_present: Object.hasOwn(body, "max_output_tokens"),
        advisory_header: request.headers.get("x-kiro-output-token-limit-mode") === "advisory",
        declared_tools: Array.isArray(body.tools) ? body.tools.length : 0,
        body_bytes: decoded.byteLength,
        messages_contract_compatible: compatible,
        provider_preflight_ok: adapted?.ok ?? null,
        provider_preflight_code:
          adapted &&
          !adapted.ok &&
          typeof adapted.code === "string" &&
          /^[a-z_]+$/.test(adapted.code)
            ? adapted.code
            : null,
        provider_preflight_param:
          adapted &&
          !adapted.ok &&
          adapted.param &&
          (allowedParams.has(adapted.param) ||
            /^messages\.\d+\.(output_config|content)$/.test(adapted.param))
            ? adapted.param
            : null,
      });
      if (adapted && !adapted.ok)
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: adapted.message,
              ...(adapted.code ? { code: adapted.code } : {}),
              ...(adapted.param ? { param: adapted.param } : {}),
            },
          },
          { status: 400 },
        );
      return fixtureResponse(protocol, body.stream === true);
    },
  });
  const runs: Row[] = [];
  const launcher = resolve(import.meta.dir, "kiroclaude");
  const extension = join(root, "pi-extension.mjs");
  writeFileSync(
    extension,
    `export default function(pi){pi.registerProvider("synthetic-kimi",{api:"openai-responses",baseUrl:"http://127.0.0.1:8787/v1",apiKey:"${KEY}",models:[{id:"${MODEL}",name:"Synthetic K3",reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:"low",medium:null,high:"high",xhigh:null,max:"max"},input:["text","image"],contextWindow:1000000,maxTokens:131072,compat:{supportsMaxOutputTokens:false},cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});}\n`,
    { mode: 0o600 },
  );
  save(join(root, "provider.json"), { api_keys: [KEY] });
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    XDG_CACHE_HOME: join(root, "cache"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    KIROCLAUDE_CLAUDE_BIN: claude,
    KIROCLAUDE_PROVIDER_CONFIG: join(root, "provider.json"),
    KIROCLAUDE_TOKEN_HELPER: join(root, "key.sh"),
    KIROCLAUDE_BASE_URL: "http://127.0.0.1:8787",
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    CODEX_HOME: join(root, "codex"),
  };
  const codexConfiguration = [
    "--config",
    'model_provider="synthetic-kimi"',
    "--config",
    `model_providers.synthetic-kimi={name="Synthetic Kimi",base_url="http://127.0.0.1:8787/v1",wire_api="responses",auth={command="${join(root, "key.sh")}",timeout_ms=1000,refresh_interval_ms=300000},supports_websockets=false}`,
    "--config",
    `model_catalog_json="${catalogPath}"`,
    "--config",
    'web_search="disabled"',
    "--config",
    'approval_policy="never"',
  ];
  try {
    const loadedCatalog = await codexCatalog(codex, root, codexConfiguration, environment);
    for (const client of ["claude", "pi", "codex"] as const) {
      for (const effort of LEVELS) {
        const before = captures.length;
        const args =
          client === "claude"
            ? [
                "sh",
                launcher,
                "--model",
                "kimi-k3[1m]",
                "--effort",
                effort,
                "--bare",
                "--safe-mode",
                "--no-session-persistence",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--disable-slash-commands",
                "--setting-sources",
                "",
                "--system-prompt",
                "Synthetic wire capture only.",
                "--output-format",
                "stream-json",
                "--verbose",
                "--print",
                "Return only the fixed synthetic acknowledgement.",
              ]
            : client === "pi"
              ? [
                  pi,
                  "--offline",
                  "--no-approve",
                  "--no-session",
                  "--no-tools",
                  "--no-mcp",
                  "--no-context-files",
                  "--no-skills",
                  "--no-prompt-templates",
                  "--no-themes",
                  "--no-extensions",
                  "--extension",
                  extension,
                  "--provider",
                  "synthetic-kimi",
                  "--model",
                  MODEL,
                  "--thinking",
                  effort,
                  "--mode",
                  "json",
                  "--print",
                  "Return only the fixed synthetic acknowledgement.",
                ]
              : [
                  codex,
                  ...codexConfiguration,
                  "--config",
                  `model_reasoning_effort="${effort}"`,
                  "exec",
                  "--ephemeral",
                  "--ignore-user-config",
                  "--ignore-rules",
                  "--skip-git-repo-check",
                  "--sandbox",
                  "read-only",
                  "--model",
                  MODEL,
                  "--json",
                  "Return only the fixed synthetic acknowledgement. Do not call tools.",
                ];
        const child = Bun.spawn(args, {
          cwd: join(root, "project"),
          env: { ...environment, KIROCLAUDE_EFFORT: "" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolveTimeout) => {
          timer = setTimeout(() => {
            child.kill(9);
            resolveTimeout("timeout");
          }, 20_000);
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          Promise.race([child.exited, timeout]),
        ]);
        clearTimeout(timer);
        if (exit === "timeout") await child.exited;
        let acknowledged = false,
          toolExecutions = 0;
        for (const line of stdout.split("\n")) {
          try {
            const event = record(JSON.parse(line));
            if (event.type === "tool_execution_start") toolExecutions++;
            if (client === "codex" && event.type === "item.completed") {
              const item = record(event.item);
              if (item.type === "agent_message" && item.text === ACK) acknowledged = true;
              if (item.type === "command_execution" || item.type === "mcp_tool_call")
                toolExecutions++;
            }
            if (
              client === "claude" &&
              event.type === "result" &&
              event.subtype === "success" &&
              event.is_error !== true &&
              event.result === ACK
            )
              acknowledged = true;
            const message = record(event.message);
            if (
              client === "pi" &&
              event.type === "message_end" &&
              message.role === "assistant" &&
              Array.isArray(message.content)
            ) {
              acknowledged ||= message.content.some(
                (block) => record(block).type === "text" && record(block).text === ACK,
              );
            }
          } catch {}
        }
        const wire = captures.slice(before);
        const acceptedWire = wire.filter((row) => row.provider_preflight_ok !== false);
        const preflightRejections = wire.filter((row) => row.provider_preflight_ok === false);
        const allowedPreflight =
          preflightRejections.length <= 1 &&
          preflightRejections.every(
            (row) =>
              row.provider_preflight_code === "unsupported_parameter" &&
              row.provider_preflight_param === "safeguards",
          );
        const exact =
          acceptedWire.length === 1 &&
          wire.every((row) => row.model === MODEL && row.effort === effort);
        runs.push({
          client,
          effort,
          exit_code: exit,
          acknowledged,
          tool_executions: toolExecutions,
          stderr_bytes: Buffer.byteLength(stderr),
          stderr_unknown_model_warning: /unknown model|unrecognized model/i.test(stderr),
          request_count: wire.length,
          accepted_request_count: acceptedWire.length,
          provider_preflight_rejection_count: preflightRejections.length,
          allowed_preflight_rejections: allowedPreflight,
          wire,
          exact_requested_effort: exact,
          passed: exit === 0 && acknowledged && toolExecutions === 0 && exact && allowedPreflight,
        });
      }
    }
    return {
      schema_version: 1,
      private_network_namespace: true,
      synthetic_http_only: true,
      live_kiro_generation_count: 0,
      installed_client_files_modified: false,
      existing_sessions_loaded: false,
      provider_catalog: {
        model: kimi.slug,
        context_window: kimi.context_window,
        output_limit: kimi.output_limit,
        input_modalities: kimi.input_modalities,
        default_reasoning_level: kimi.default_reasoning_level,
        supported_reasoning_levels: kimi.supported_reasoning_levels,
      },
      codex_model_list: loadedCatalog,
      runs,
      wire_capture_passed: loadedCatalog.passed && runs.every((row) => row.passed === true),
      messages_contract_compatible: captures
        .filter((row) => row.protocol === "messages")
        .every((row) => row.messages_contract_compatible),
    };
  } finally {
    await server.stop(true);
  }
}

async function main() {
  const claude = resolve(
    option("--claude-bin") ?? process.env.CLAUDE_PROBE_BINARY ?? Bun.which("claude") ?? "claude",
  );
  const pi = resolve(option("--pi-bin") ?? process.env.PI_PROBE_BINARY ?? Bun.which("pi") ?? "pi");
  const codex = resolve(
    option("--codex-bin") ?? process.env.CODEX_PROBE_BINARY ?? Bun.which("codex") ?? "codex",
  );
  const parentNamespace = process.env.KIMI_PROBE_PARENT_NETNS;
  if (parentNamespace) {
    requireCondition(
      readlinkSync("/proc/self/ns/net") !== parentNamespace,
      "private_network_namespace_required",
    );
    const root = option("--work-root");
    requireCondition(
      typeof root === "string" && root.startsWith(join(tmpdir(), "kiro-kimi-client-")),
      "temporary_work_root_required",
    );
    const socket = option("--bridge-socket");
    const result = socket
      ? await liveClaude(root, claude, socket)
      : await worker(root, claude, pi, codex);
    save(join(root, "evidence.json"), result);
    return;
  }
  const output = option("--out");
  requireCondition(
    !output || !resolve(output).startsWith(`${resolve(import.meta.dir, "..")}/`),
    "evidence_outside_repository_required",
  );
  const liveTarget = option("--live-candidate-url");
  const confirmLive = process.argv.includes("--confirm-live");
  requireCondition(
    Boolean(liveTarget) === confirmLive,
    "explicit_live_confirmation_and_candidate_required",
  );
  requireCondition(!liveTarget || typeof output === "string", "live_dispatch_ledger_required");
  const liveBase = liveTarget ? new URL(liveTarget) : undefined;
  let candidateConfig: Row | undefined;
  if (liveBase) {
    requireCondition(
      liveBase.protocol === "http:" &&
        liveBase.hostname === "127.0.0.1" &&
        liveBase.port &&
        liveBase.port !== "8787" &&
        liveBase.pathname === "/" &&
        !liveBase.username &&
        !liveBase.password &&
        !liveBase.search &&
        !liveBase.hash,
      "isolated_candidate_loopback_required",
    );
    const path = option("--provider-config");
    requireCondition(typeof path === "string", "private_candidate_config_required");
    candidateConfig = readPrivateCandidateConfig(path);
  }
  const root = mkdtempSync(join(tmpdir(), "kiro-kimi-client-"));
  chmodSync(root, 0o700);
  for (const directory of ["project", "cache", "claude", "pi", "codex"])
    mkdirSync(join(root, directory), { mode: 0o700 });
  writeFileSync(join(root, "key.sh"), `#!/bin/sh\nprintf '%s\\n' '${KEY}'\n`, { mode: 0o700 });
  const policyPath = "/etc/claude-code/managed-settings.json";
  const policy = existsSync(policyPath) ? record(JSON.parse(readFileSync(policyPath, "utf8"))) : {};
  const copy = join(root, "managed-settings.json");
  save(copy, {
    ...policy,
    apiKeyHelper: join(root, "key.sh"),
    env: {
      ...record(policy.env),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_FOUNDRY: "0",
      CLAUDE_CODE_USE_MANTLE: "0",
    },
  });
  let bridge: ReturnType<typeof candidateBridge> | undefined;
  try {
    if (liveBase && candidateConfig && output)
      bridge = candidateBridge(root, liveBase, candidateConfig, resolve(output));
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
        copy,
        policyPath,
        Bun.which("bun") ?? "bun",
        resolve(import.meta.filename),
        "--work-root",
        root,
        "--claude-bin",
        claude,
        "--pi-bin",
        pi,
        "--codex-bin",
        codex,
        ...(bridge ? ["--bridge-socket", join(root, "bridge.sock")] : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          KIMI_PROBE_PARENT_NETNS: readlinkSync("/proc/self/ns/net"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    requireCondition(
      code === 0 && existsSync(join(root, "evidence.json")),
      `isolated_probe_failed:${code}:${Buffer.byteLength(stdout)}:${Buffer.byteLength(stderr)}`,
    );
    let result = JSON.parse(readFileSync(join(root, "evidence.json"), "utf8"));
    if (bridge)
      result = {
        schema_version: 1,
        private_network_namespace: true,
        synthetic_http_only: false,
        candidate_http_request_budget: 1,
        installed_client_files_modified: false,
        existing_sessions_loaded: false,
        client: result,
        bridge: bridge.evidence,
        live_passed:
          result.passed === true &&
          bridge.evidence.forwarded_requests === 1 &&
          bridge.evidence.response_status === 200 &&
          bridge.evidence.advisory_response &&
          bridge.evidence.stream_stop_events === 1 &&
          bridge.evidence.stream_error_events === 0,
      };
    if (output) save(resolve(output), result);
    console.log(JSON.stringify(result, null, 2));
    if (bridge) requireCondition(result.live_passed === true, "single_candidate_live_probe_failed");
    else {
      requireCondition(result.wire_capture_passed === true, "client_wire_capture_failed");
      requireCondition(
        result.messages_contract_compatible === true,
        "messages_thinking_shape_incompatible",
      );
    }
  } finally {
    if (bridge) await bridge.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main)
  await runKimiClientProbeOnPlatform(process.platform, main).catch((error) => {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error && /^[A-Za-z0-9_:.-]+$/.test(error.message)
            ? error.message
            : "probe_execution_failed",
      }),
    );
    process.exitCode = 1;
  });
