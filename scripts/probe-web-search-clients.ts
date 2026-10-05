/**
 * Real-client hosted web search acceptance through a capture gate.
 *
 *   bun run scripts/probe-web-search-clients.ts --client codex|claude \
 *     --base-url http://127.0.0.1:18879/ --provider-config <isolated config.json> \
 *     --root <persistent client state outside the repository> --phase first|resume \
 *     --out <evidence.json> [--managed-policy-copy <temporary policy copy>] \
 *     [--codex-bin codex] [--claude-bin claude]
 *
 * A loopback capture proxy rejects the client's first generation request
 * (`KIRO_ISOLATION_GATE`) to prove the client reaches the probe port, then
 * forwards later requests to the isolated gateway with the probe key. `first`
 * asks the client for a cited web answer; restart the gateway, then `resume`
 * continues the same session, switches effort and switches to the other
 * verified model. Codex runs with `web_search = "live"`; Claude Code runs its
 * WebSearch tool without `--bare`, inside a namespace that binds the policy
 * copy over its managed settings. Codex also runs a client-tool session: the
 * same turn must search the web and read a local marker file through its own
 * shell tool, and `resume` continues that session too. Evidence holds counts,
 * enums and booleans.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

type Json = Record<string, unknown>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

const SEARCH_PROMPT =
  "Use web search to find the latest stable release of the Bun JavaScript runtime. Reply with the version number and one notable change, and cite your source.";
const FOLLOW_UP = "In one sentence, restate the version you found and where you found it.";
const CLIENT_TOOL_PROMPT =
  "In this turn, use web search to find the latest stable release of the Bun JavaScript runtime, and also run `cat build-marker.txt` in the current directory to read the local build marker. Reply with the Bun version, the exact marker text, and cite your web source.";
const CLIENT_TOOL_FOLLOW_UP =
  "In one sentence, restate the Bun version you found and the build marker you read.";

function inputCounts(body: Json): Json {
  const items = ((body.messages ?? body.input) as Json[] | undefined) ?? [];
  const blocks = items.flatMap((item) => [
    item,
    ...(Array.isArray(item.content) ? (item.content as Json[]) : []),
  ]);
  const count = (type: string) => blocks.filter((block) => block.type === type).length;
  const clientCalls = count("function_call") + count("custom_tool_call");
  const clientOutputs = count("function_call_output") + count("custom_tool_call_output");
  const tools = ((body.tools as Json[] | undefined) ?? []).map((tool) =>
    String(tool.type ?? "function"),
  );
  return {
    hosted_tool: tools.find((type) => type.startsWith("web_search")) ?? null,
    tool_count: tools.length,
    web_search_calls: count("web_search_call"),
    server_tool_uses: count("server_tool_use"),
    search_results: count("web_search_tool_result"),
    reasoning_items: count("reasoning") + count("thinking"),
    client_tool_calls: clientCalls + count("tool_use"),
    client_tool_results: clientOutputs + count("tool_result"),
  };
}

function responseCounts(text: string): Json {
  return {
    response_search_calls: (text.match(/"type":"web_search_call"/g) ?? []).length,
    search_completed_events: (text.match(/response\.web_search_call\.completed/g) ?? []).length,
    server_tool_use_blocks: (text.match(/"type":"server_tool_use"/g) ?? []).length,
    search_result_blocks: (text.match(/"type":"web_search_tool_result"/g) ?? []).length,
    citations:
      (text.match(/"type":"url_citation"/g) ?? []).length +
      (text.match(/"type":"web_search_result_location"/g) ?? []).length,
    provider_tokens: text.includes("kr2_"),
    stream_errors: (text.match(/event: error|"type":"response\.failed"/g) ?? []).length,
    // One response that both completed a search and handed out a client call.
    mixed_response:
      /"type":"web_search_call"/.test(text) &&
      /"type":"(?:function_call|custom_tool_call)"/.test(text),
  };
}

async function main(): Promise<void> {
  const client = option("--client");
  requireCondition(client === "claude" || client === "codex", "invalid_client");
  const phase = option("--phase");
  requireCondition(phase === "first" || phase === "resume", "phase_required");
  const base = new URL(option("--base-url") ?? "http://invalid");
  requireCondition(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port !== "" &&
      base.port !== "8787" &&
      base.pathname === "/",
    "isolated_loopback_gateway_required",
  );
  const repository = resolve(import.meta.dir, "..");
  const outside = (path: string | undefined): path is string =>
    path !== undefined && !resolve(path).startsWith(`${repository}/`);
  const configPath = option("--provider-config");
  const output = option("--out");
  const root = option("--root");
  requireCondition(configPath && outside(output) && outside(root), "external_paths_required");
  const key = JSON.parse(readFileSync(configPath, "utf8")).api_keys?.[0];
  requireCondition(typeof key === "string" && key.length > 0, "isolated_api_key_required");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const markerPath = join(cwd, "build-marker.txt");
  if (!existsSync(markerPath)) {
    writeFileSync(markerPath, `KWS-MARKER-${randomUUID().slice(0, 8)}\n`, { mode: 0o600 });
  }
  const marker = readFileSync(markerPath, "utf8").trim();
  const tokenHelper = join(root, "token.sh");
  writeFileSync(tokenHelper, "#!/bin/sh\nprintf '%s\\n' \"$KIRO_PROBE_API_KEY\"\n", {
    mode: 0o700,
  });
  const sessionsPath = join(root, "sessions.json");
  const sessions: Json = existsSync(sessionsPath)
    ? (JSON.parse(readFileSync(sessionsPath, "utf8")) as Json)
    : {};

  let gate = phase === "first";
  let gateHits = 0;
  let gateProcess: ReturnType<typeof Bun.spawn> | undefined;
  const captures: Json[] = [];
  const pending = new Set<Promise<void>>();
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") !== `Bearer ${key}` &&
        request.headers.get("x-api-key") !== key
      ) {
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: "probe key" } },
          { status: 401 },
        );
      }
      if (url.pathname.endsWith("/models")) {
        const response = await fetch(new URL("/v1/models", base), {
          headers: { authorization: `Bearer ${key}` },
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      if (!url.pathname.endsWith("/messages") && !url.pathname.endsWith("/responses")) {
        return Response.json({ ok: true });
      }
      if (gate) {
        gateHits += 1;
        setTimeout(() => gateProcess?.kill(9), 100);
        return Response.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "KIRO_ISOLATION_GATE" },
          },
          { status: 400 },
        );
      }
      const encoded = Buffer.from(await request.arrayBuffer());
      const body = JSON.parse(
        (request.headers.get("content-encoding") === "gzip"
          ? gunzipSync(encoded)
          : encoded
        ).toString("utf8"),
      ) as Json;
      const row: Json = {
        path: url.pathname.endsWith("/messages") ? "messages" : "responses",
        model: String(body.model),
        ...inputCounts(body),
      };
      captures.push(row);
      const headers = new Headers(request.headers);
      for (const name of ["host", "content-length", "content-encoding", "x-api-key"]) {
        headers.delete(name);
      }
      headers.set("authorization", `Bearer ${key}`);
      const response = await fetch(new URL(url.pathname + url.search, base), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
      row.status = response.status;
      row.model_replay_mode = response.headers.get("x-kiro-reasoning-model-replay-mode");
      const inspection = response
        .clone()
        .text()
        .then((text) => {
          Object.assign(row, responseCounts(text));
          if (response.status >= 400) {
            try {
              row.error_code = JSON.parse(text).error?.code ?? null;
            } catch {
              row.error_code = null;
            }
          }
        })
        .catch(() => undefined);
      pending.add(inspection);
      void inspection.finally(() => pending.delete(inspection));
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
  const proxyBase = `http://127.0.0.1:${proxy.port}`;
  const policyCopy = option("--managed-policy-copy");
  if (client === "claude") {
    requireCondition(policyCopy, "managed_policy_copy_required");
    requireCondition(
      resolve(policyCopy).startsWith(`${resolve(tmpdir())}/`) &&
        realpathSync(policyCopy) === resolve(policyCopy),
      "temporary_policy_copy_required",
    );
    const policy = JSON.parse(readFileSync(policyCopy, "utf8")) as Json;
    writeFileSync(
      policyCopy,
      JSON.stringify({
        ...policy,
        env: { ...(policy.env as Json), ANTHROPIC_BASE_URL: proxyBase },
      }),
      { mode: 0o600 },
    );
  }
  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    KIRO_PROBE_API_KEY: key,
    KIROCLAUDE_CONFIG_DIR: join(root, "claude"),
    KIROCLAUDE_PROVIDER_CONFIG: resolve(configPath),
    KIROCLAUDE_BASE_URL: proxyBase,
    KIROCLAUDE_TOKEN_HELPER: tokenHelper,
    KIROCLAUDE_PERMISSION_MODE: "dontAsk",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ANTHROPIC_BASE_URL: proxyBase,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDECODE: undefined,
    OPENAI_API_KEY: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    ALL_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    all_proxy: undefined,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  mkdirSync(environment.CODEX_HOME as string, { recursive: true });
  mkdirSync(environment.CLAUDE_CONFIG_DIR as string, { recursive: true });
  const claudeBinary = option("--claude-bin") ?? "claude";
  const codexBinary = option("--codex-bin") ?? "codex";
  environment.KIROCLAUDE_CLAUDE_BIN = claudeBinary;
  const version = Bun.spawnSync([client === "claude" ? claudeBinary : codexBinary, "--version"], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  const catalogPath = join(root, "catalog.json");
  if (client === "codex") {
    const catalog = await fetch(new URL("/v1/models", base), {
      headers: { authorization: `Bearer ${key}` },
    });
    requireCondition(catalog.ok, "catalog_fetch_failed");
    writeFileSync(catalogPath, JSON.stringify(await catalog.json()));
  }

  const runs: Json[] = [];
  async function run(
    label: string,
    model: string,
    prompt: string,
    options: { readonly resume?: string; readonly effort?: string; readonly gate?: boolean } = {},
  ): Promise<string | undefined> {
    const start = captures.length;
    const session = options.resume ?? randomUUID();
    const args =
      client === "claude"
        ? [
            "sh",
            join(repository, "scripts/kiroclaude"),
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-chrome",
            "--max-turns",
            options.gate ? "1" : "6",
            "--tools",
            "WebSearch",
            "--allowedTools",
            "WebSearch",
            "--model",
            model,
            ...(options.effort ? ["--effort", options.effort] : []),
            "--output-format",
            "stream-json",
            "--verbose",
            ...(options.resume ? ["--resume", session] : ["--session-id", session]),
            "--print",
            prompt,
          ]
        : [
            codexBinary,
            "--config",
            'model_provider="probe"',
            "--config",
            `model_providers.probe={name="Isolated probe",base_url="${proxyBase}/v1",wire_api="responses",auth={command="${tokenHelper}",timeout_ms=5000,refresh_interval_ms=300000},supports_websockets=false}`,
            "--config",
            `model_catalog_json="${catalogPath}"`,
            "--config",
            'web_search="live"',
            "--config",
            'approval_policy="never"',
            ...(options.effort ? ["--config", `model_reasoning_effort="${options.effort}"`] : []),
            "exec",
            ...(options.resume
              ? ["resume", "--skip-git-repo-check", "--ignore-user-config", options.resume]
              : ["--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only"]),
            "--model",
            model,
            "--json",
            prompt,
          ];
    const subprocess = Bun.spawn(args, {
      cwd,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.gate) gateProcess = subprocess;
    const timer = setTimeout(() => subprocess.kill(9), options.gate ? 30_000 : 900_000);
    const [stdout, , exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    clearTimeout(timer);
    await Promise.all([...pending]);
    if (options.gate) {
      runs.push({ label, gate_hits: gateHits, gate_passed: gateHits > 0 });
      return undefined;
    }
    const events = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
    const id =
      client === "claude"
        ? session
        : String(events.find((event) => event.type === "thread.started")?.thread_id ?? session);
    const finalText =
      client === "claude"
        ? String(events.findLast((event) => event.type === "result")?.result ?? "")
        : String(
            (
              events
                .filter(
                  (event) =>
                    event.type === "item.completed" &&
                    (event.item as Json | undefined)?.type === "agent_message",
                )
                .at(-1)?.item as Json | undefined
            )?.text ?? "",
          );
    const clientSearches =
      client === "claude"
        ? events.filter((event) => JSON.stringify(event).includes('"name":"WebSearch"')).length
        : events.filter(
            (event) =>
              event.type === "item.completed" &&
              (event.item as Json | undefined)?.type === "web_search",
          ).length;
    runs.push({
      label,
      model,
      effort: options.effort ?? null,
      exit_code: exitCode,
      requests: captures.slice(start),
      client_search_items: clientSearches,
      final_text: finalText.length > 0,
      final_mentions_version: /\d+\.\d+\.\d+/.test(finalText),
      final_mentions_marker: finalText.includes(marker),
      client_tool_items:
        client === "codex"
          ? events.filter(
              (event) =>
                event.type === "item.completed" &&
                (event.item as Json | undefined)?.type === "command_execution",
            ).length
          : 0,
      result_is_error:
        client === "claude"
          ? events.findLast((event) => event.type === "result")?.is_error === true
          : false,
    });
    return id;
  }

  const first = client === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5";
  const other = client === "codex" ? "claude-opus-5-5" : "gpt-5.6-sol";
  if (phase === "first") {
    await run("gate", first, "gate", { gate: true });
    requireCondition(gateHits > 0, "capture_proxy_gate_failed");
    gate = false;
    const session = await run("search", first, SEARCH_PROMPT);
    sessions[client] = session;
    if (client === "codex") {
      sessions["codex-client-tool"] = await run("client-tool", first, CLIENT_TOOL_PROMPT);
    }
    writeFileSync(sessionsPath, JSON.stringify(sessions), { mode: 0o600 });
  } else {
    const session = String(sessions[client] ?? "");
    requireCondition(session.length > 0, "first_phase_session_required");
    await run("resume", first, FOLLOW_UP, { resume: session });
    await run("effort-switch", first, FOLLOW_UP, { resume: session, effort: "low" });
    await run("model-switch", other, FOLLOW_UP, { resume: session });
    if (client === "codex") {
      const tooled = String(sessions["codex-client-tool"] ?? "");
      requireCondition(tooled.length > 0, "first_phase_client_tool_session_required");
      await run("client-tool-resume", first, CLIENT_TOOL_FOLLOW_UP, { resume: tooled });
    }
  }
  proxy.stop(true);
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        schema_version: 1,
        client,
        version,
        phase,
        gateway_port: Number(base.port),
        capture_port: proxy.port,
        runs,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

await main();
