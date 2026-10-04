/** Real CLI capture gate; forwards only to an explicitly isolated loopback gateway. */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
interface Capture {
  model: string;
  effort: string | null;
  reasoning_count: number;
  tool_call_count: number;
  tool_result_count: number;
  response_status: number;
  model_replay_mode: string | null;
  response_signed: boolean;
  thinking_display: string | null;
  provider_replay_response: boolean;
  preflight_rejection: boolean;
  failed_tool_result_count: number;
  max_tokens: number | null;
}
function countBlocks(body: Record<string, unknown>, type: string): number {
  const input = (body.messages ?? body.input) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(input)) return 0;
  return input.reduce(
    (count, item) =>
      count +
      (item.type === type ? 1 : 0) +
      (Array.isArray(item.content) ? item.content.filter((part) => part?.type === type).length : 0),
    0,
  );
}

async function main() {
  const client = option("--client") ?? "claude";
  requireCondition(client === "claude" || client === "codex", "invalid_client");
  const base = new URL(option("--base-url") ?? "http://invalid");
  requireCondition(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port &&
      base.port !== "8787" &&
      base.pathname === "/",
    "isolated_loopback_gateway_required",
  );
  const configPath = option("--provider-config");
  const output = option("--out");
  requireCondition(configPath && output, "provider_config_and_output_required");
  const repository = resolve(import.meta.dir, "..");
  requireCondition(
    !resolve(output).startsWith(`${repository}/`),
    "evidence_must_be_outside_repository",
  );
  const key = JSON.parse(readFileSync(configPath, "utf8")).api_keys?.[0];
  requireCondition(typeof key === "string" && key.length > 0, "isolated_api_key_required");
  const root = mkdtempSync(join(tmpdir(), "kiro-client-switch-"));
  chmodSync(root, 0o700);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const tokenHelper = join(root, "token.sh");
  writeFileSync(tokenHelper, "#!/bin/sh\nprintf '%s\\n' \"$KIRO_PROBE_API_KEY\"\n", {
    mode: 0o700,
  });
  let gate = true;
  let gateHits = 0;
  let gateProcess: ReturnType<typeof Bun.spawn> | undefined;
  const captures: Capture[] = [];
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
      )
        return Response.json(
          {
            type: "error",
            error: { type: "authentication_error", message: "Isolated probe key required" },
          },
          { status: 401 },
        );
      if (url.pathname.endsWith("/models")) {
        // Listing is read-only; gate generation is still never forwarded.
        const response = await fetch(new URL("/v1/models", base), {
          headers: { authorization: `Bearer ${key}` },
        });
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      if (!url.pathname.endsWith("/messages") && !url.pathname.endsWith("/responses"))
        return Response.json({ ok: true });
      if (request.method !== "POST")
        return Response.json({ error: { message: "POST required" } }, { status: 405 });
      if (gate) {
        gateHits += 1;
        writeFileSync(
          output,
          JSON.stringify(
            {
              client,
              gate_passed: true,
              gateway_port: base.port,
              capture_port: proxy.port,
              gate_hits: gateHits,
            },
            null,
            2,
          ),
        );
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
      ) as Record<string, unknown>;
      const row: Capture = {
        model: String(body.model),
        effort:
          (body.output_config as { effort?: string } | undefined)?.effort ??
          (body.reasoning as { effort?: string } | undefined)?.effort ??
          null,
        reasoning_count: countBlocks(body, "thinking") + countBlocks(body, "reasoning"),
        tool_call_count:
          countBlocks(body, "tool_use") +
          countBlocks(body, "function_call") +
          countBlocks(body, "custom_tool_call"),
        tool_result_count:
          countBlocks(body, "tool_result") +
          countBlocks(body, "function_call_output") +
          countBlocks(body, "custom_tool_call_output"),
        response_status: 0,
        model_replay_mode: null,
        response_signed: false,
        thinking_display: (body.thinking as { display?: string } | undefined)?.display ?? null,
        provider_replay_response: false,
        preflight_rejection: false,
        failed_tool_result_count: Array.isArray(body.messages)
          ? body.messages
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .filter((block) => block.type === "tool_result" && block.is_error === true).length
          : 0,
        max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
      };
      captures.push(row);
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("authorization", `Bearer ${key}`);
      headers.delete("x-api-key");
      const response = await fetch(new URL(url.pathname + url.search, base), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
      row.response_status = response.status;
      row.model_replay_mode = response.headers.get("x-kiro-reasoning-model-replay-mode");
      const inspection = response
        .clone()
        .text()
        .then((text) => {
          row.provider_replay_response = text.includes("kr2_");
          row.response_signed = row.provider_replay_response || text.includes('"signature_delta"');
          if (row.response_status === 400) {
            try {
              const error = JSON.parse(text).error;
              row.preflight_rejection =
                error?.type === "invalid_request_error" &&
                String(error.message).includes("messages.1.output_config");
            } catch {}
          }
        })
        .catch(() => undefined);
      pending.add(inspection);
      void inspection.finally(() => pending.delete(inspection));
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  });
  const proxyBase = `http://127.0.0.1:${proxy.port}`;
  // A namespace/container may expose this temporary policy copy as its native
  // managed-settings file. Preserve its restrictions and pin the capture port.
  const policyCopy = option("--managed-policy-copy");
  if (policyCopy) {
    requireCondition(
      resolve(policyCopy).startsWith(`${resolve(tmpdir())}/`),
      "temporary_policy_copy_required",
    );
    requireCondition(
      realpathSync(policyCopy) === resolve(policyCopy),
      "policy_copy_must_not_be_symlinked",
    );
    const policy = JSON.parse(readFileSync(policyCopy, "utf8"));
    writeFileSync(
      policyCopy,
      JSON.stringify({ ...policy, env: { ...policy.env, ANTHROPIC_BASE_URL: proxyBase } }),
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
    KIROCLAUDE_EFFORT: "max",
    KIROCLAUDE_PERMISSION_MODE: "dontAsk",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ANTHROPIC_BASE_URL: proxyBase,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    AWS_BEARER_TOKEN_BEDROCK: undefined,
    BEDROCK_API_KEY: undefined,
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
  mkdirSync(environment.CODEX_HOME as string);
  mkdirSync(environment.CLAUDE_CONFIG_DIR as string);
  const claudeBinary = option("--claude-bin") ?? "claude";
  const codexBinary = option("--codex-bin") ?? "codex";
  environment.KIROCLAUDE_CLAUDE_BIN = claudeBinary;
  const versions = Bun.spawnSync([client === "claude" ? claudeBinary : codexBinary, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const version = versions.stdout.toString().trim();
  const catalogPath = join(root, "catalog.json");
  if (client === "codex") {
    const catalogResponse = await fetch(new URL("/v1/models", base), {
      headers: { authorization: `Bearer ${key}` },
    });
    requireCondition(catalogResponse.ok, "catalog_fetch_failed");
    writeFileSync(catalogPath, JSON.stringify(await catalogResponse.json()));
  }
  const runs: Array<Record<string, unknown>> = [];
  async function run(
    model: string,
    effort: string,
    prompt: string,
    resume?: string,
    gateRun = false,
  ): Promise<string> {
    const start = captures.length;
    const session = resume ?? randomUUID();
    const args =
      client === "claude"
        ? [
            "sh",
            join(repository, "scripts/kiroclaude"),
            "--bare",
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-chrome",
            "--max-turns",
            gateRun ? "1" : "4",
            "--system-prompt",
            "Follow the current user request. The first turn contains arithmetic and one fixture printf command. Later turns ask only for the completed tool result; do not recompute arithmetic or invoke any tool on those turns. Do not delegate.",
            "--tools",
            gateRun ? "" : "Bash",
            "--allowedTools",
            "Bash(printf *)",
            "--model",
            model,
            "--effort",
            effort,
            "--output-format",
            "stream-json",
            "--verbose",
            ...(resume ? ["--resume", session] : ["--session-id", session]),
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
            `model_reasoning_effort="${effort}"`,
            "--config",
            `model_catalog_json="${catalogPath}"`,
            "--config",
            'web_search="disabled"',
            "--config",
            'approval_policy="never"',
            "--config",
            'developer_instructions="Execute only the requested fixture printf. Do not delegate or use network tools."',
            "exec",
            ...(resume
              ? ["resume", "--skip-git-repo-check", "--ignore-user-config", resume]
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
    if (gateRun) gateProcess = subprocess;
    const timer = setTimeout(() => subprocess.kill(9), gateRun ? 20_000 : 180_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    clearTimeout(timer);
    await Promise.all([...pending]);
    if (gateRun) {
      const startup = stdout.split("\n").flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return [
            {
              type: entry.type,
              subtype: entry.subtype,
              apiKeySource: entry.apiKeySource,
              is_error: entry.is_error,
              login_required: String(entry.result ?? "").includes("Not logged in"),
            },
          ];
        } catch {
          return [];
        }
      });
      writeFileSync(
        output as string,
        JSON.stringify(
          {
            client,
            version,
            gate_passed: gateHits > 0,
            gate_exit_code: exitCode,
            stderr_bytes: Buffer.byteLength(stderr),
            missing_library:
              /error while loading shared libraries: ([A-Za-z0-9_.-]+):/.exec(stderr)?.[1] ?? null,
            stdout_bytes: Buffer.byteLength(stdout),
            startup,
            gateway_port: base.port,
            capture_port: proxy.port,
          },
          null,
          2,
        ),
      );
      requireCondition(gateHits > 0, "capture_proxy_gate_failed");
      return session;
    }
    const events = stdout.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const id =
      client === "claude"
        ? session
        : (events.find((event) => event.type === "thread.started")?.thread_id ?? resume);
    const segment = captures.slice(start);
    const finalText =
      client === "claude"
        ? events.findLast((event) => event.type === "result")?.result
        : events
            .filter(
              (event) => event.type === "item.completed" && event.item?.type === "agent_message",
            )
            .at(-1)?.item.text;
    const row = {
      model,
      effort,
      resumed: !!resume,
      exit_code: exitCode,
      request_count: segment.length,
      reasoning_replayed: segment.some((entry) => entry.reasoning_count > 0),
      tool_turn: segment.some((entry) => entry.tool_result_count > 0),
      signed_response: segment.some((entry) => entry.response_signed),
      marker_preserved: !resume || String(finalText ?? "").trim() === "MODEL_SWITCH_TOOL_OK",
      statuses: segment.map((entry) => entry.response_status),
      preflight_rejections: segment.filter((entry) => entry.preflight_rejection).length,
      compatibility: segment.map((entry) => entry.model_replay_mode),
    };
    runs.push(row);
    writeFileSync(
      output as string,
      JSON.stringify(
        {
          schema_version: 1,
          client,
          version,
          gate_passed: gateHits > 0,
          gateway_port: base.port,
          capture_port: proxy.port,
          runs,
          captures,
        },
        null,
        2,
      ),
    );
    requireCondition(
      exitCode === 0 &&
        segment.length > 0 &&
        segment.some((entry) => entry.response_status === 200) &&
        segment.every(
          (entry) =>
            entry.response_status === 200 || (client === "claude" && entry.preflight_rejection),
        ),
      "client_turn_failed",
    );
    requireCondition(id, "client_session_id_missing");
    requireCondition(row.marker_preserved, "client_history_marker_missing");
    return id;
  }
  try {
    await run(
      client === "claude" ? "claude-opus-5-5" : "gpt-5.6-sol",
      "low",
      "Reply GATE.",
      undefined,
      true,
    );
    gate = false;
    const matrix =
      client === "claude"
        ? [
            ["claude-opus-5-5", "claude-opus-5-5", "low"],
            ["claude-opus-5-5", "claude-opus-5", "max"],
            ["claude-fable-5-1", "claude-opus-5-5", "max"],
          ]
        : [
            ["claude-opus-5-5", "claude-opus-5-5", "low"],
            ["claude-opus-5-5", "claude-opus-5-5-low", "low"],
            ["claude-opus-5-5-max", "claude-opus-5-5", "low"],
            ["claude-opus-5-5-max", "claude-opus-5-5-low", "low"],
            ["gpt-5.6-sol", "claude-opus-5-5", "max"],
          ];
    const selectedCase = option("--case-index");
    if (selectedCase !== undefined)
      requireCondition(
        /^\d+$/.test(selectedCase) && Number(selectedCase) < matrix.length,
        "invalid_case_index",
      );
    for (const [index, [from, to, effort]] of matrix.entries()) {
      if (option("--case-index") !== undefined && index !== Number(option("--case-index")))
        continue;
      const id = await run(
        from as string,
        "max",
        "Find the smallest positive integer n with remainders 5 mod 17, 7 mod 19, 11 mod 23, and 13 mod 29. Verify all remainders in your reasoning. Then run the shell command printf MODEL_SWITCH_TOOL_OK exactly once, then reply READY.",
      );
      const first = runs.at(-1);
      requireCondition(
        first?.tool_turn && first.signed_response,
        "initial_signed_tool_turn_missing",
      );
      await run(
        to as string,
        effort as string,
        "The arithmetic task and printf command are complete. Return only the exact text from the most recent completed Bash tool_result in the existing history. Do not recompute arithmetic, execute commands, or call tools.",
        id,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ client, version, gate_passed: true, runs: runs.length, pass: true })}\n`,
    );
  } finally {
    proxy.stop(true);
    await Promise.all([...pending]);
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  // Never publish arbitrary client stderr, prompt-bearing captures or credentials.
  const allowed = new Set([
    "invalid_client",
    "isolated_loopback_gateway_required",
    "provider_config_and_output_required",
    "evidence_must_be_outside_repository",
    "isolated_api_key_required",
    "temporary_policy_copy_required",
    "policy_copy_must_not_be_symlinked",
    "catalog_fetch_failed",
    "capture_proxy_gate_failed",
    "client_turn_failed",
    "client_session_id_missing",
    "initial_signed_tool_turn_missing",
    "client_history_marker_missing",
    "invalid_case_index",
  ]);
  process.stderr.write(
    `${JSON.stringify({ pass: false, code: error instanceof Error && allowed.has(error.message) ? error.message : "probe_failed" })}\n`,
  );
  process.exitCode = 1;
});
