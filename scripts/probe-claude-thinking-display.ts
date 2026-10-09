/**
 * Installed Claude -> launcher -> Messages -> synthetic SDK thinking gate.
 * bun scripts/probe-claude-thinking-display.ts --claude-bin /path/to/claude \
 *   --before-launcher /path/to/pre-fix/kiroclaude --out /tmp/evidence.json
 * Requires bubblewrap. A separate network namespace contains its own 8787;
 * an owner-only temporary policy copy preserves restrictions and pins fixture
 * authentication. No production launcher, settings, account or service changes.
 * Requests/transcripts remain in memory; evidence contains enums/counts only.
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
import { workingDirectoryHash } from "../src/protocol/client-normalization.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { type AppDependencies, createApp } from "../src/server/app.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

async function main(): Promise<void> {
  const binary = option("--claude-bin");
  const before = option("--before-launcher");
  const output = option("--out");
  const caseFilter = new Set(option("--cases")?.split(",").filter(Boolean) ?? []);
  requireCondition(binary && before && output, "binary_before_launcher_and_output_required");
  const evidencePath = output;
  const repository = resolve(import.meta.dir, "..");
  requireCondition(!resolve(output).startsWith(`${repository}/`), "external_output_required");
  const parentNamespace = process.env.KIRO_THINKING_PROBE_PARENT_NETNS;
  if (!parentNamespace) {
    const root = mkdtempSync(join(tmpdir(), "kiro-thinking-display-"));
    chmodSync(root, 0o700);
    const helper = join(root, "token.sh");
    writeFileSync(helper, "#!/bin/sh\nprintf '%s\\n' 'synthetic-thinking-key'\n", { mode: 0o700 });
    const policyPath = "/etc/claude-code/managed-settings.json";
    const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf8")) : {};
    const policyCopy = join(root, "managed-settings.json");
    writeFileSync(
      policyCopy,
      JSON.stringify({
        ...policy,
        apiKeyHelper: helper,
        env: {
          ...policy.env,
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_USE_BEDROCK: "0",
          CLAUDE_CODE_USE_VERTEX: "0",
          CLAUDE_CODE_USE_FOUNDRY: "0",
          CLAUDE_CODE_USE_MANTLE: "0",
        },
      }),
      { mode: 0o600 },
    );
    mkdirSync(join(root, "cache"));
    const childOutput = join(root, "evidence.json");
    try {
      const process = Bun.spawn(
        [
          "bwrap",
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
          resolve(binary),
          "--before-launcher",
          resolve(before),
          "--out",
          childOutput,
          "--work-root",
          root,
          ...(caseFilter.size > 0 ? ["--cases", [...caseFilter].join(",")] : []),
        ],
        {
          env: {
            ...globalThis.process.env,
            KIRO_THINKING_PROBE_PARENT_NETNS: readlinkSync("/proc/self/ns/net"),
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      requireCondition(
        existsSync(childOutput),
        `isolated_probe_no_evidence:${exitCode}:${Buffer.byteLength(stdout)}:${Buffer.byteLength(stderr)}`,
      );
      const evidence = JSON.parse(readFileSync(childOutput, "utf8"));
      writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify(evidence));
      requireCondition(
        exitCode === 0,
        `isolated_probe_failed:${exitCode}:${stderr.match(/case_failed:[a-z0-9-]+/)?.[0] ?? "startup"}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  requireCondition(
    readlinkSync("/proc/self/ns/net") !== parentNamespace,
    "private_network_namespace_required",
  );
  const requestedRoot = option("--work-root");
  requireCondition(typeof requestedRoot === "string", "temporary_work_root_required");
  const root = requestedRoot;
  requireCondition(
    root.startsWith(`${tmpdir()}/kiro-thinking-display-`),
    "temporary_work_root_required",
  );
  const project = join(root, "project");
  const configDir = join(root, "claude");
  mkdirSync(project);
  mkdirSync(join(project, "subdir"));
  writeFileSync(join(project, "fixture.txt"), "OLD\n", { mode: 0o600 });
  mkdirSync(configDir);
  const sharedSettings = join(configDir, "settings.json");
  const sharedBytes = '{"showThinkingSummaries":true,"effortLevel":"low"}\n';
  writeFileSync(sharedSettings, sharedBytes, { mode: 0o600 });
  const callerSettings = join(root, "caller-settings.json");
  writeFileSync(callerSettings, '{"showThinkingSummaries":true}\n', { mode: 0o600 });
  const key = "synthetic-thinking-key";
  const marker = "THINKING_FIXTURE_OK";
  const signature = "fixture-thinking-signature";
  const config = ConfigSchema.parse({
    api_keys: [key],
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 11).toString("base64url")}`],
    reasoning_replay_token_format: "portable-v2",
  });
  const database = new AccountsDatabase(":memory:");
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
  let sdkDispatches = 0;
  let iteratorClosed = 0;
  let gate = true;
  let scenario: "baseline" | "cwd-change" | "history-cwd-change" | "edit-default" = "baseline";
  const sdkCaptures: Array<Record<string, unknown>> = [];
  const captures: Array<Record<string, unknown>> = [];
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
    reasoningReplayStore: new ReasoningReplayStore(database, config),
    affinityStore: database,
    makeClient: () => ({
      async send(command) {
        sdkDispatches += 1;
        const current = command.input.conversationState?.currentMessage?.userInputMessage;
        const fields = command.input.additionalModelRequestFields as
          | { thinking?: { display?: string }; output_config?: { effort?: string } }
          | undefined;
        const tools = current?.userInputMessageContext?.tools ?? [];
        const results = current?.userInputMessageContext?.toolResults ?? [];
        const lastBashInput = (command.input.conversationState?.history ?? [])
          .flatMap((message) => message.assistantResponseMessage?.toolUses ?? [])
          .filter((call) => call.name === "Bash")
          .at(-1)?.input;
        sdkCaptures.push({
          thinking_display: fields?.thinking?.display ?? null,
          effort: fields?.output_config?.effort ?? null,
          tool_result_count: results.length,
          last_history_bash_cd_prefix:
            typeof lastBashInput === "object" &&
            lastBashInput !== null &&
            "command" in lastBashInput &&
            typeof lastBashInput.command === "string" &&
            /^\s*cd\s/.test(lastBashInput.command),
          reasoning_replayed: (
            JSON.stringify(command.input.conversationState?.history) ?? ""
          ).includes(signature),
        });
        const events: SdkStreamEvent[] = [
          {
            reasoningContentEvent: {
              text: fields?.thinking?.display === "summarized" ? "Synthetic thinking summary." : "",
              signature,
            },
          },
        ];
        const priorNames = (command.input.conversationState?.history ?? []).flatMap(
          (message) => message.assistantResponseMessage?.toolUses?.map((call) => call.name) ?? [],
        );
        if (
          tools.length > 0 &&
          (results.length === 0 || (scenario === "edit-default" && !priorNames.includes("Edit")))
        ) {
          const nextName =
            scenario === "edit-default" ? (priorNames.includes("Read") ? "Edit" : "Read") : "Bash";
          const tool = tools.find(
            (value) => "toolSpecification" in value && value.toolSpecification?.name === nextName,
          );
          requireCondition(
            tool && "toolSpecification" in tool && tool.toolSpecification,
            "fixture_tool_missing",
          );
          events.push({
            toolUseEvent: {
              name: tool.toolSpecification.name,
              toolUseId: `fixture-call-${nextName}${scenario === "history-cwd-change" ? `-${sdkDispatches}` : ""}`,
              input: JSON.stringify(
                nextName === "Read"
                  ? { file_path: join(project, "fixture.txt") }
                  : nextName === "Edit"
                    ? {
                        file_path: join(project, "fixture.txt"),
                        old_string: "OLD",
                        new_string: "NEW",
                      }
                    : {
                        command:
                          scenario === "cwd-change" || scenario === "history-cwd-change"
                            ? `cd ${project} && printf '%s\\n' '${marker}'`
                            : `printf '%s\\n' '${marker}'`,
                        description: "Run synthetic check",
                      },
              ),
              stop: true,
            },
          });
        } else events.push({ assistantResponseEvent: { content: marker } });
        events.push({
          metadataEvent: { tokenUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
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
    port: 8787,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/messages")) return app(request);
      requireCondition(
        request.headers.get("x-api-key") === key ||
          request.headers.get("authorization") === `Bearer ${key}`,
        "synthetic_client_auth_required",
      );
      const encoded = Buffer.from(await request.arrayBuffer());
      const body = JSON.parse(
        (request.headers.get("content-encoding") === "gzip"
          ? gunzipSync(encoded)
          : encoded
        ).toString("utf8"),
      );
      const row: Record<string, unknown> = {
        thinking_display: body.thinking?.display ?? null,
        thinking_type: body.thinking?.type ?? null,
        effort: body.output_config?.effort ?? null,
        stream: body.stream === true,
        status: 0,
        rejected_capability: null,
      };
      captures.push(row);
      if (gate) {
        row.status = 400;
        return Response.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: "SYNTHETIC_ISOLATION_GATE" },
          },
          { status: 400 },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      if (scenario === "cwd-change" || scenario === "history-cwd-change") {
        // Model a normalization scope retained from an earlier working
        // directory while the real client now operates in this project.
        headers.set("x-kiro-working-directory-hash", workingDirectoryHash(join(project, "subdir")));
      }
      const beforeRequestDispatches = sdkDispatches;
      const response = await app(
        new Request(request.url, {
          method: request.method,
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        }),
      );
      row.status = response.status;
      row.thinking_display_mode = response.headers.get("x-kiro-thinking-display-mode");
      row.sdk_dispatches = sdkDispatches - beforeRequestDispatches;
      const sourceText =
        typeof body.system === "string"
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((part: { text?: string }) => part.text ?? "").join("\n")
            : "";
      row.system_has_current_subdir = sourceText.includes(join(project, "subdir"));
      row.native_directory_hint = /(?:Primary working directory|Working directory):\s*\//.test(
        sourceText,
      );
      row.native_cwd_tag = /<cwd>\//.test(sourceText);
      const historicalCalls = (body.messages ?? []).flatMap(
        (message: { role?: string; content?: unknown }) =>
          message.role === "assistant" && Array.isArray(message.content)
            ? message.content.filter((block: { type?: string }) => block.type === "tool_use")
            : [],
      );
      row.history_edit_default_false = historicalCalls.some(
        (call: { name?: string; input?: { replace_all?: boolean } }) =>
          call.name === "Edit" && call.input?.replace_all === false,
      );
      row.history_bash_cd_prefix = historicalCalls.some(
        (call: { name?: string; input?: { command?: string } }) =>
          call.name === "Bash" && /^\s*cd\s/.test(call.input?.command ?? ""),
      );
      row.history_last_bash_cd_prefix = /^\s*cd\s/.test(
        historicalCalls.filter((call: { name?: string }) => call.name === "Bash").at(-1)?.input
          ?.command ?? "",
      );
      if (response.status === 400) {
        const error = (await response.clone().json()) as { error?: { message?: string } };
        row.error_field_enums =
          error.error?.message?.match(
            /\b(?:output_config|thinking|display|updates|max_tokens|capability_rejected|cache_control|block_binding|budget_tokens|betas|context_management|iterations)\b/g,
          ) ?? [];
        row.rejected_capability =
          /^capability_rejected:([a-zA-Z0-9_.]+):/.exec(error.error?.message ?? "")?.[1] ?? null;
      }
      return response;
    },
  });
  const version =
    Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString()
      .match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
  const runs: Array<Record<string, unknown>> = [];
  try {
    async function run(
      name: string,
      launcher: string,
      effort: string,
      explicit = false,
      unsupported = false,
    ): Promise<void> {
      if (!gate && caseFilter.size > 0 && !caseFilter.has(name)) return;
      const start = captures.length,
        sdkStart = sdkCaptures.length,
        beforeDispatch = sdkDispatches,
        beforeClosed = iteratorClosed;
      let retainedSession: string | undefined;
      if (scenario === "history-cwd-change") {
        retainedSession = randomUUID();
        const userId = randomUUID(),
          assistantId = randomUUID();
        const common = {
          sessionId: retainedSession,
          cwd: project,
          isSidechain: false,
          version,
          timestamp: new Date().toISOString(),
        };
        const history = [
          {
            ...common,
            type: "user",
            uuid: userId,
            parentUuid: null,
            message: { role: "user", content: "Synthetic retained history." },
          },
          {
            ...common,
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              id: "fixture-retained-message",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [
                { type: "thinking", thinking: "", signature },
                {
                  type: "tool_use",
                  id: "fixture-retained-call",
                  name: "Bash",
                  input: { command: `cd ${project} && printf synthetic-history` },
                },
              ],
              stop_reason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
          {
            ...common,
            type: "user",
            uuid: randomUUID(),
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "fixture-retained-call",
                  content: "Synthetic retained result.",
                },
              ],
            },
          },
        ];
        const historyDirectory = join(
          configDir,
          "projects",
          project.replace(/[^A-Za-z0-9-]/g, "-"),
        );
        mkdirSync(historyDirectory, { recursive: true });
        writeFileSync(
          join(historyDirectory, `${retainedSession}.jsonl`),
          `${history.map((row) => JSON.stringify(row)).join("\n")}\n`,
          { mode: 0o600 },
        );
      }
      const child = Bun.spawn(
        [
          "sh",
          launcher,
          "--bare",
          "--setting-sources",
          "user",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--settings",
          callerSettings,
          '--settings={"showThinkingSummaries":true}',
          "--no-session-persistence",
          ...(retainedSession ? ["--resume", retainedSession, "--fork-session"] : []),
          "--tools",
          gate || unsupported ? "" : scenario === "edit-default" ? "Read,Edit" : "Bash",
          "--allowedTools",
          scenario === "baseline"
            ? "Bash(printf *)"
            : scenario === "edit-default"
              ? "Read,Edit"
              : "Bash",
          "--max-turns",
          scenario === "edit-default" ? "4" : "3",
          "--system-prompt",
          scenario === "history-cwd-change"
            ? "Synthetic check only. Do not delegate."
            : `Synthetic check only. Do not delegate.\nPrimary working directory: ${project}`,
          "--effort",
          effort,
          ...(unsupported ? ["--model", "claude-sonnet-5[1m]"] : []),
          ...(explicit ? ["--thinking-display", "summarized"] : []),
          "--output-format",
          "stream-json",
          "--verbose",
          "--print",
          `Return ${marker}.`,
        ],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HOME: root,
            CLAUDE_CONFIG_DIR: configDir,
            KIROCLAUDE_CONFIG_DIR: configDir,
            KIROCLAUDE_CLAUDE_BIN: binary,
            KIROCLAUDE_TOKEN_HELPER: join(root, "token.sh"),
            KIROCLAUDE_BASE_URL: "http://127.0.0.1:8787",
            KIROCLAUDE_EFFORT: effort,
            KIROCLAUDE_PERMISSION_MODE: "dontAsk",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_MAX_RETRIES: "0",
            DISABLE_AUTOUPDATER: "1",
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        },
      );
      const timeout = setTimeout(() => child.kill(9), 30_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timeout);
      const events = stdout.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line) as { type?: string; is_error?: boolean; result?: string }];
        } catch {
          return [];
        }
      });
      const result = events.findLast((event) => event.type === "result");
      const segment = captures.slice(start),
        sdk = sdkCaptures.slice(sdkStart);
      const expectedRejected = gate || unsupported;
      const expectedDisplay = explicit ? "summarized" : "omitted";
      const forcedOmitted = explicit && config.anthropic_thinking_display_mode === "omitted";
      const row = {
        case: name,
        effort,
        thinking_display_policy: config.anthropic_thinking_display_mode,
        exit_code: exitCode,
        request_count: segment.length,
        sdk_dispatches: sdkDispatches - beforeDispatch,
        iterator_closed: iteratorClosed - beforeClosed,
        stderr_bytes: Buffer.byteLength(stderr),
        marker_returned: result?.is_error === false && result.result?.trim() === marker,
        shared_settings_unchanged: readFileSync(sharedSettings, "utf8") === sharedBytes,
        requests: segment,
        sdk,
      };
      runs.push(row);
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            schema_version: 1,
            client_version: version,
            private_network_namespace: true,
            passed: false,
            runs,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      requireCondition(
        segment.length > 0 && row.shared_settings_unchanged,
        "client_capture_or_shared_settings_failed",
      );
      requireCondition(
        row.iterator_closed === row.sdk_dispatches,
        "upstream_iterator_cleanup_failed",
      );
      requireCondition(
        expectedRejected
          ? row.sdk_dispatches === 0 && segment.every((request) => request.status === 400)
          : exitCode === 0 &&
              row.marker_returned &&
              segment.filter((request) => request.status === 200).length >= 2 &&
              segment.every(
                (request) =>
                  (request.status === 200 ||
                    (request.status === 400 && request.sdk_dispatches === 0)) &&
                  (request.thinking_display === expectedDisplay ||
                    (!explicit && request.thinking_display === null)) &&
                  request.effort === effort,
              ) &&
              sdk.every(
                (request) =>
                  request.thinking_display === (forcedOmitted ? "omitted" : expectedDisplay) &&
                  request.effort === effort,
              ) &&
              (!forcedOmitted ||
                segment
                  .filter((request) => request.status === 200)
                  .every((request) => request.thinking_display_mode === "forced-omitted")) &&
              sdk.some(
                (request) => request.reasoning_replayed && Number(request.tool_result_count) > 0,
              ) &&
              (scenario !== "history-cwd-change" ||
                (sdk.at(-1)?.last_history_bash_cd_prefix === true &&
                  segment.some(
                    (request) =>
                      request.status === 200 &&
                      request.history_bash_cd_prefix === true &&
                      request.history_last_bash_cd_prefix === false,
                  ))),
        `case_failed:${name}`,
      );
    }
    await run("isolation-gate", join(repository, "scripts/kiroclaude"), "max");
    gate = false;
    await run("before-paseo-explicit-summarized", before, "max", true);
    await run("after-xhigh-tool-replay", join(repository, "scripts/kiroclaude"), "xhigh");
    await run("after-max-tool-replay", join(repository, "scripts/kiroclaude"), "max");
    await run(
      "explicit-summarized-tool-replay",
      join(repository, "scripts/kiroclaude"),
      "max",
      true,
    );
    await run(
      "unsupported-summarized-rejected",
      join(repository, "scripts/kiroclaude"),
      "max",
      true,
      true,
    );
    config.anthropic_thinking_display_mode = "omitted";
    await run(
      "recovery-explicit-summarized-tool-replay",
      join(repository, "scripts/kiroclaude"),
      "max",
      true,
    );
    scenario = "cwd-change";
    await run("replay-cwd-change", join(repository, "scripts/kiroclaude"), "max", true);
    scenario = "history-cwd-change";
    await run("replay-history-cwd-change", join(repository, "scripts/kiroclaude"), "max", true);
    scenario = "edit-default";
    await run("replay-edit-default", join(repository, "scripts/kiroclaude"), "max", true);
    writeFileSync(
      output,
      `${JSON.stringify({ schema_version: 1, client_version: version, private_network_namespace: true, passed: true, runs }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } finally {
    server.stop(true);
    database.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "probe_failed");
  process.exitCode = 1;
});
