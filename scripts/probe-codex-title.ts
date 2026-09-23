/**
 * Drive the installed Codex TUI's automatic title worker against an isolated gateway.
 * Usage: bun scripts/probe-codex-title.ts --confirm --config /private/probe.json
 *   --endpoint http://127.0.0.1:18787/v1 --out /private/title-evidence.json
 * Never reads an existing Codex session. Only counts, enums and hashes leave memory.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const option = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const endpoint = new URL(option("--endpoint") ?? "http://127.0.0.1:18787/v1");
const configPath = option("--config");
const destination = option("--out");
const model = option("--model") ?? "gpt-5.6-sol";
const binary = option("--codex-bin") ?? "codex";
const timeoutMs = Number(option("--timeout-seconds", "180")) * 1000;
if (!process.argv.includes("--confirm") || !configPath || !destination) {
  throw new Error("--confirm, --config and --out are required");
}
if (
  endpoint.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
  !endpoint.port ||
  endpoint.port === "8787" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Use an explicit isolated loopback gateway port, never port 8787");
if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
  throw new Error("--timeout-seconds must be between 10 and 600");
}
const { api_keys: apiKeys } = JSON.parse(readFileSync(configPath, "utf8")) as {
  api_keys?: unknown[];
};
const apiKey = apiKeys?.[0];
if (typeof apiKey !== "string" || !apiKey) throw new Error("Probe config requires an API key");
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const root = mkdtempSync(join(tmpdir(), "kiro-codex-title-"));
chmodSync(root, 0o700);
const statePath = join(root, "codex");
const sqlitePath = join(root, "sqlite");
const projectPath = join(root, "project");
for (const path of [statePath, sqlitePath, projectPath]) mkdirSync(path, { mode: 0o700 });
const prompt = "请用一句话解释如何按颜色整理书架。直接回答，不使用任何工具。";
const normalizeTitle = (value: string): string =>
  Array.from(
    value
      .trim()
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.?!]+$/g, "")
      .trim(),
  )
    .slice(0, 36)
    .join("");
type RequestEvidence = {
  kind: "conversation" | "title";
  request_bytes: number;
  schema_matches_codex_title: boolean;
  input_item_types: string[];
  additional_tool_count: number;
  requested_model: string;
  first_item_keys: string[];
  first_item_role: string | null;
  top_level_tool_count: number;
  tool_types: string[];
  namespace_child_counts: number[];
  tool_name_hashes: string[];
  tool_choice: string;
  reasoning_effort: string;
  reasoning_summary: string;
  request_keys: string[];
  status?: number;
  structured_output_mode?: string | null;
  compatibility?: string | null;
  transport?: string | null;
  completed_events: number;
  failed_events: number;
  title_chars?: number;
  title_sha256?: string;
  duration_ms?: number;
  error_code?: string;
  error_param?: string;
  error_message_sha256?: string;
};
const requests: RequestEvidence[] = [];
const generatedTitles = new Set<string>();
let proxyErrors = 0;
let uiBytes = 0;
let uiTail = "";
const uiHash = createHash("sha256");
let persistedTitle: string | undefined;
let persistedTitleSource: "sqlite" | "session_index" | undefined;
let persistedThreadCount = 0;
let privateError: unknown;
let child: ReturnType<typeof Bun.spawn> | undefined;
let exitCode: number | null = null;
const started = performance.now();

const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    // A narrow forwarding surface prevents a client discovery call from leaving this gateway.
    if (!["/v1/responses", "/v1/models"].includes(pathname))
      return new Response(null, { status: 404 });
    const requestStarted = performance.now();
    let evidence: RequestEvidence | undefined;
    try {
      const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
      if (body && pathname === "/v1/responses") {
        const json = JSON.parse(new TextDecoder().decode(body));
        const format = json.text?.format;
        const schema = format?.schema;
        const title = schema?.properties?.title;
        const matches =
          format?.type === "json_schema" &&
          schema?.type === "object" &&
          Object.keys(schema.properties ?? {}).length === 1 &&
          title?.type === "string" &&
          title.minLength === 1 &&
          title.maxLength === 36 &&
          JSON.stringify(schema.required) === '["title"]' &&
          schema.additionalProperties === false;
        evidence = {
          kind: matches ? "title" : "conversation",
          request_bytes: body.byteLength,
          schema_matches_codex_title: matches,
          requested_model:
            typeof json.model === "string" && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(json.model)
              ? json.model
              : "unknown",
          first_item_keys: Object.keys(json.input?.[0] ?? {}).filter((key) =>
            /^[a-z_]{1,50}$/.test(key),
          ),
          first_item_role: ["developer", "system", "user", "assistant"].includes(
            json.input?.[0]?.role,
          )
            ? json.input[0].role
            : null,
          top_level_tool_count: Array.isArray(json.tools) ? json.tools.length : 0,
          tool_types: Array.isArray(json.tools)
            ? json.tools.map((tool: { type?: string }) =>
                ["namespace", "function", "custom", "web_search", "image_generation"].includes(
                  tool.type ?? "",
                )
                  ? tool.type
                  : "unknown",
              )
            : [],
          namespace_child_counts: Array.isArray(json.tools)
            ? json.tools
                .filter((tool: { type?: string }) => tool.type === "namespace")
                .map((tool: { tools?: unknown[] }) => tool.tools?.length ?? 0)
            : [],
          tool_name_hashes: Array.isArray(json.tools)
            ? json.tools.map((tool: { name?: string }) => hash(tool.name ?? ""))
            : [],
          tool_choice: ["none", "auto", "required"].includes(json.tool_choice)
            ? json.tool_choice
            : json.tool_choice === undefined
              ? "absent"
              : "other",
          reasoning_effort: [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
          ].includes(json.reasoning?.effort)
            ? json.reasoning.effort
            : "absent-or-other",
          reasoning_summary: ["auto", "detailed", "concise", "none"].includes(
            json.reasoning?.summary,
          )
            ? json.reasoning.summary
            : "absent-or-other",
          request_keys: Object.keys(json).filter((key) => /^[a-z_]{1,50}$/.test(key)),
          input_item_types: Array.isArray(json.input)
            ? json.input.map((item: { type?: string; role?: string }) =>
                [
                  "message",
                  "additional_tools",
                  "reasoning",
                  "function_call",
                  "function_call_output",
                  "custom_tool_call",
                  "custom_tool_call_output",
                ].includes(item.type ?? "")
                  ? item.type
                  : ["developer", "system", "user", "assistant"].includes(item.role ?? "")
                    ? item.role
                    : "unknown",
              )
            : [],
          additional_tool_count: Array.isArray(json.input)
            ? json.input
                .filter((item: { type?: string }) => item.type === "additional_tools")
                .reduce(
                  (count: number, item: { tools?: unknown[] }) =>
                    count + (Array.isArray(item.tools) ? item.tools.length : 0),
                  0,
                )
            : 0,
          completed_events: 0,
          failed_events: 0,
        };
        requests.push(evidence);
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("authorization", `Bearer ${apiKey}`);
      const upstream = await fetch(
        new URL(`${endpoint.pathname.replace(/\/$/, "")}${pathname.slice(3)}`, endpoint.origin),
        {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        },
      );
      if (!evidence)
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
      const current = evidence;
      evidence.status = upstream.status;
      evidence.structured_output_mode = upstream.headers.get("x-kiro-structured-output-mode");
      evidence.compatibility = upstream.headers.get("x-kiro-compatibility");
      evidence.transport = upstream.headers.get("x-kiro-transport");
      if (!upstream.ok) {
        const errorBody = (await upstream
          .clone()
          .json()
          .catch(() => ({}))) as { error?: { code?: unknown; param?: unknown; message?: unknown } };
        const safeEnum = (value: unknown): string | undefined =>
          typeof value === "string" && /^[a-zA-Z0-9_.[\]-]{1,100}$/.test(value) ? value : undefined;
        evidence.error_code = safeEnum(errorBody.error?.code);
        evidence.error_param = safeEnum(errorBody.error?.param);
        if (typeof errorBody.error?.message === "string")
          evidence.error_message_sha256 = hash(errorBody.error.message);
      }
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("content-length");
      let buffer = "";
      const decoder = new TextDecoder();
      const inspect = (chunk: Uint8Array): void => {
        buffer += decoder.decode(chunk, { stream: true });
        while (buffer.includes("\n\n")) {
          const next = buffer.indexOf("\n\n");
          const event = buffer.slice(0, next);
          buffer = buffer.slice(next + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data || data === "[DONE]") continue;
          let parsed: {
            type?: string;
            response?: { output?: { type: string; content?: { type: string; text?: string }[] }[] };
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (
            parsed.type === "response.failed" ||
            parsed.type === "error" ||
            parsed.type === "response.incomplete"
          )
            current.failed_events++;
          if (parsed.type !== "response.completed") continue;
          current.completed_events++;
          if (current.kind !== "title") continue;
          const output = (parsed.response?.output ?? [])
            .flatMap((item: { type: string; content?: { type: string; text?: string }[] }) =>
              item.type === "message" ? (item.content ?? []) : [],
            )
            .filter((part: { type: string }) => part.type === "output_text")
            .map((part: { text?: string }) => part.text ?? "")
            .join("");
          try {
            const payload = JSON.parse(output);
            if (Object.keys(payload).length !== 1 || typeof payload.title !== "string") continue;
            const title = normalizeTitle(payload.title);
            if (title) {
              generatedTitles.add(title);
              current.title_chars = Array.from(title).length;
              current.title_sha256 = hash(title);
            }
          } catch {
            /* A non-JSON response must not count as a generated title. */
          }
        }
        if (buffer.length > 2 * 1024 * 1024) throw new Error("Unexpectedly large SSE event");
      };
      const tracked = upstream.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            inspect(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            current.duration_ms = Math.round(performance.now() - requestStarted);
          },
        }),
      );
      return new Response(tracked, { status: upstream.status, headers: responseHeaders });
    } catch {
      proxyErrors++;
      return Response.json(
        { error: { type: "probe_proxy_error", message: "Isolated probe forwarding failed" } },
        { status: 502 },
      );
    }
  },
});

function readPersistedTitle(): void {
  const threadIds = new Set<string>();
  for (const name of readdirSync(sqlitePath).filter((name) => /^state.*\.sqlite$/.test(name))) {
    const db = new Database(join(sqlitePath, name), { readonly: true });
    try {
      const exists = db
        .query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
        .get() as { n: number };
      if (!exists.n) continue;
      const rows = db.query("SELECT id, title FROM threads WHERE cwd = ?").all(projectPath) as {
        id: string;
        title: string;
      }[];
      persistedThreadCount = rows.length;
      for (const row of rows) threadIds.add(row.id);
      persistedTitle = rows.map((row) => row.title).find((title) => generatedTitles.has(title));
      if (persistedTitle) persistedTitleSource = "sqlite";
    } finally {
      db.close();
    }
  }
  // Rollout-backed Codex threads store their explicit names in this append-only index;
  // the SQLite title can remain the first user message on these Codex versions.
  const indexPath = join(statePath, "session_index.jsonl");
  if (!persistedTitle && existsSync(indexPath)) {
    const names = new Map<string, string>();
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { id: string; thread_name: string };
      if (threadIds.has(entry.id)) names.set(entry.id, entry.thread_name);
    }
    persistedTitle = [...names.values()].find((title) => generatedTitles.has(title));
    if (persistedTitle) persistedTitleSource = "session_index";
  }
}

try {
  const catalogResponse = await fetch(`${endpoint.toString().replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!catalogResponse.ok) throw new Error("Isolated gateway model catalog unavailable");
  const catalog = (await catalogResponse.json()) as { models?: { slug?: string }[] };
  if (!catalog.models?.some((entry) => entry.slug === model))
    throw new Error("Requested model missing from Codex catalog projection");
  const catalogPath = join(statePath, "models.json");
  writeFileSync(catalogPath, JSON.stringify({ models: catalog.models }), { mode: 0o600 });
  writeFileSync(
    join(statePath, "config.toml"),
    `${[
      `model = ${JSON.stringify(model)}`,
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      'model_provider = "title_probe"',
      'model_reasoning_effort = "low"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'web_search = "disabled"',
      "check_for_update_on_startup = false",
      "model_context_window = 1000000",
      "[model_providers.title_probe]",
      'name = "Isolated title acceptance"',
      `base_url = "http://127.0.0.1:${proxy.port}/v1"`,
      'wire_api = "responses"',
      'env_key = "KIRO_TITLE_PROBE_KEY"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "[features]",
      "apps = false",
      "plugins = false",
      "memories = false",
      "shell_snapshot = false",
      "shell_tool = false",
      "unified_exec = false",
      "code_mode = false",
      "multi_agent = false",
      "multi_agent_v2 = false",
      "view_image = false",
      `[projects.${JSON.stringify(projectPath)}]`,
      'trust_level = "trusted"',
      "[analytics]",
      "enabled = false",
      "[feedback]",
      "enabled = false",
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    CODEX_HOME: statePath,
    CODEX_SQLITE_HOME: sqlitePath,
    KIRO_TITLE_PROBE_KEY: apiKey,
    TERM: "xterm-256color",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  });
  child = Bun.spawn([binary, "--no-daemon", "--no-alt-screen", "-C", projectPath, prompt], {
    cwd: projectPath,
    env,
    terminal: {
      cols: 120,
      rows: 40,
      data(terminal, data) {
        uiBytes += data.byteLength;
        uiHash.update(data);
        const text = new TextDecoder().decode(data);
        uiTail = (uiTail + text).slice(-65_536);
        // Answer terminal capability probes without persisting or printing screen contents.
        if (text.includes("\u001b[6n")) terminal.write("\u001b[1;1R");
        if (text.includes("\u001b]11;?")) terminal.write("\u001b]11;rgb:0000/0000/0000\u0007");
        if (text.includes("\u001b]10;?")) terminal.write("\u001b]10;rgb:ffff/ffff/ffff\u0007");
      },
    },
  });
  const deadline = performance.now() + timeoutMs;
  let acknowledgedStartup = false;
  while (performance.now() < deadline && child.exitCode === null) {
    await Bun.sleep(250);
    const screen = stripVTControlCharacters(uiTail);
    if (
      !acknowledgedStartup &&
      requests.length === 0 &&
      (/(?:Press (?:enter|Enter) to continue|enter to start|Enter to start)/.test(screen) ||
        performance.now() - started > 5_000)
    ) {
      child.terminal?.write("\r");
      acknowledgedStartup = true;
    }
    readPersistedTitle();
    if (requests.some((row) => row.kind === "title" && (row.status ?? 0) >= 400)) {
      throw new Error("Gateway rejected the automatic title request");
    }
    if (
      persistedTitle &&
      requests.some((row) => row.kind === "conversation" && row.completed_events === 1)
    )
      break;
  }
  if (!persistedTitle) throw new Error("Automatic title was not persisted before deadline");
  if (!requests.some((row) => row.kind === "conversation" && row.completed_events === 1)) {
    throw new Error("Conversation did not complete");
  }
} catch (error) {
  privateError = error;
} finally {
  if (child && child.exitCode === null) {
    child.terminal?.write("\u0003");
    await Bun.sleep(200);
    child.terminal?.write("\u0003");
    await Promise.race([child.exited, Bun.sleep(3_000)]);
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(3_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  exitCode = child?.exitCode ?? null;
  child?.terminal?.close();
  // Reopen persisted storage after TUI shutdown: an in-memory name is not acceptance.
  try {
    readPersistedTitle();
  } catch (error) {
    privateError ??= error;
  }
  proxy.stop(true);
  const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const versionText = new TextDecoder().decode(version.stdout).trim();
  const passed =
    !privateError &&
    !!persistedTitle &&
    proxyErrors === 0 &&
    requests.some(
      (row) =>
        row.kind === "title" &&
        row.status === 200 &&
        row.completed_events === 1 &&
        row.failed_events === 0,
    );
  const evidence = {
    schema_version: 1,
    case: "codex-tui-automatic-title",
    passed,
    codex_version: /^codex-cli [\w.+-]+$/.test(versionText) ? versionText : "unrecognized",
    model,
    duration_ms: Math.round(performance.now() - started),
    tui_exit_code: exitCode,
    isolated_state: true,
    state_removed: true,
    manual_rename_calls: 0,
    title_persisted_after_exit: !!persistedTitle,
    title_persistence_source: persistedTitleSource ?? null,
    title_chars: persistedTitle ? Array.from(persistedTitle).length : 0,
    title_sha256: persistedTitle ? hash(persistedTitle) : null,
    persisted_thread_count: persistedThreadCount,
    request_count: requests.length,
    requests,
    proxy_errors: proxyErrors,
    ui_bytes: uiBytes,
    ui_sha256: uiHash.digest("hex"),
    failure_class: privateError
      ? privateError instanceof Error
        ? hash(privateError.message)
        : "unknown"
      : null,
    startup_hints: {
      signin_prompt: /Sign in with ChatGPT|Sign in to Codex/.test(uiTail),
      trust_prompt: /Do you trust|trust this folder/.test(uiTail),
      terminal_error: /Error opening terminal|could not read cursor/.test(uiTail),
      config_error: /Error loading configuration|Error loading config/.test(uiTail),
      enter_prompt: /(?:enter|Enter).*continue/.test(stripVTControlCharacters(uiTail)),
    },
  };
  rmSync(root, { recursive: true, force: true });
  writeFileSync(resolve(destination), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = passed ? 0 : 1;
}
