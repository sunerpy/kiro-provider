// Run from a checkout with an installed Claude Code binary:
// bun scripts/probe-client-context.mjs --claude-bin /path/to/claude
// Add --thresholds for a synthetic large-history compaction check.
// --tool-loop checks signed-prefix stability across two harmless Bash true calls.
// --effort-matrix checks that every KIROCLAUDE_EFFORT value reaches the wire as
// the effort it names, including one synthetic Agent subagent at max.
// --launcher /path/to/kiroclaude checks an installed copy instead of ./kiroclaude.
// --native-comparison compares native default/[1m]/environment behavior.
// Installed Claude Code against a synthetic loopback API. No real model calls.
// All requests and outputs remain in memory; only enums/counts are reported.
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.ts";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.ts";

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const binary = option("--claude-bin", process.env.CLAUDE_CONTEXT_TEST_BINARY ?? "claude");
const launcher = option("--launcher", fileURLToPath(new URL("./kiroclaude", import.meta.url)));
const thresholdMode = process.argv.includes("--thresholds");
const toolLoop = process.argv.includes("--tool-loop");
const effortMatrix = process.argv.includes("--effort-matrix");
const caseFilter = option("--cases", "");
const root = await mkdtemp(join(tmpdir(), "claude-context-fixture-"));
const useLauncher = !process.argv.includes("--native-comparison");
if (effortMatrix && !useLauncher) throw new Error("--effort-matrix requires the launcher");
const tokenHelper = join(root, "fixture-token");
if (useLauncher) {
  await Bun.write(tokenHelper, "#!/bin/sh\nprintf '%s\\n' 'fixture-only'\n");
  await chmod(tokenHelper, 0o700);
}
// The subagent prompt carries this marker so the fixture can tell its request
// apart from the parent's.
const subagentMarker = "EFFORT_SUBAGENT_FIXTURE";
const effortCase = (name, effort, expectedEffort, extra = {}) => ({
  name,
  model: "claude-opus-5-5[1m]",
  env: effort === undefined ? {} : { KIROCLAUDE_EFFORT: effort },
  expectedEffort,
  expectedUltracode: false,
  ...extra,
});
const cases = effortMatrix
  ? [
      effortCase("effort-default", undefined, "xhigh", { expectedUltracode: true }),
      effortCase("effort-ultra", "ultra", "xhigh", { expectedUltracode: true }),
      effortCase("effort-low", "low", "low"),
      effortCase("effort-medium", "medium", "medium"),
      effortCase("effort-high", "high", "high"),
      effortCase("effort-xhigh", "xhigh", "xhigh"),
      effortCase("effort-max", "max", "max"),
      // A later explicit client flag still wins over the launcher's max.
      effortCase("effort-max-cli-override", "max", "high", { args: ["--effort", "high"] }),
      // Subagents inherit the session effort rather than a persisted setting.
      effortCase("effort-max-subagent", "max", "max", { agentLoop: true }),
    ]
  : toolLoop
  ? [
      {
        name: "tool-prefix",
        model: useLauncher ? "fable" : "claude-fable-5-1[1m]",
        env: {},
        expectedWindow: 1000000,
      },
    ]
  : useLauncher && !thresholdMode
    ? [
        // `opus` resolves through ANTHROPIC_DEFAULT_OPUS_MODEL, so this case
        // covers the family alias; launcher-opus55 and launcher-opus5 cover the
        // two named picker rows by their exact IDs.
        { name: "launcher-opus", model: "opus", env: {}, expectedWindow: 1000000 },
        {
          name: "launcher-opus55",
          model: "claude-opus-5-5[1m]",
          env: {},
          expectedWindow: 1000000,
        },
        { name: "launcher-opus5", model: "claude-opus-5[1m]", env: {}, expectedWindow: 1000000 },
        { name: "launcher-sonnet", model: "sonnet", env: {}, expectedWindow: 1000000 },
        { name: "launcher-fable", model: "fable", env: {}, expectedWindow: 1000000 },
        // The small-fast row maps to Sonnet 5, so it inherits that 1M window
        // rather than Kiro Haiku 4.5's 200K one.
        { name: "launcher-haiku", model: "haiku", env: {}, expectedWindow: 1000000 },
        { name: "launcher-sol", model: "gpt-5.6-sol[1m]", env: {}, expectedWindow: 1000000 },
        { name: "launcher-terra", model: "gpt-5.6-terra[1m]", env: {}, expectedWindow: 1000000 },
        { name: "launcher-luna", model: "gpt-5.6-luna[1m]", env: {}, expectedWindow: 1000000 },
      ]
    : thresholdMode
      ? [
          { name: "200k-below", model: "claude-opus-5", env: {}, usage: 166800 },
          { name: "200k-above", model: "claude-opus-5", env: {}, usage: 167200 },
          { name: "1m-old-threshold", model: "claude-opus-5[1m]", env: {}, usage: 167200 },
          { name: "1m-below", model: "claude-opus-5[1m]", env: {}, usage: 966000 },
          { name: "1m-above", model: "claude-opus-5[1m]", env: {}, usage: 967200 },
          {
            name: "1m-configured-above",
            model: "claude-opus-5[1m]",
            env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
            usage: 967200,
          },
          {
            name: "1m-settings-above",
            model: "claude-opus-5[1m]",
            env: {},
            settings: { autoCompactWindow: 1000000 },
            usage: 967200,
          },
        ]
      : [
          { name: "default", model: "claude-opus-5", env: {} },
          { name: "explicit-1m", model: "claude-opus-5[1m]", env: {} },
          {
            name: "auto-window-only",
            model: "claude-opus-5",
            env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
          },
          {
            name: "max-context-only",
            model: "claude-opus-5",
            env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" },
          },
          {
            name: "family-alias-1m",
            model: "opus",
            env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]" },
          },
        ];

async function runCase(test) {
  const requests = [];
  const paths = [];
  const prefixes = [];
  const prefixChanges = [];
  const toolResults = new Set();
  let toolErrors = 0;
  let replies = 0;
  const visibleMessage = (message) => {
    const value = structuredClone(message);
    const context = value.userInputMessage?.userInputMessageContext;
    if (context) {
      delete context.tools;
      if (Object.keys(context).length === 0) delete value.userInputMessage.userInputMessageContext;
    }
    return value;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 1000 });
      if (path.endsWith("/models")) {
        return Response.json({
          data: [
            {
              id: "claude-opus-5",
              type: "model",
              display_name: "Fixture Opus",
              created_at: "2026-09-01T00:00:00Z",
              max_input_tokens: 1000000,
            },
          ],
          has_more: false,
        });
      }
      if (!path.endsWith("/messages")) return Response.json({ ok: true });
      const body = await request.json();
      const textLengths = (body.messages ?? []).flatMap((message) =>
        typeof message.content === "string"
          ? [message.content.length]
          : (message.content ?? [])
              .filter((block) => block.type === "text")
              .map((block) => block.text.length),
      );
      const serializedMessages = JSON.stringify(body.messages ?? []);
      // Only a subagent opens with the marker; the parent later carries it in
      // its Agent tool_use input, so the whole history cannot be used.
      const subagent =
        test.agentLoop === true &&
        JSON.stringify(body.messages?.[0] ?? {}).includes(subagentMarker);
      const hasToolResult = (body.messages ?? []).some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "tool_result"),
      );
      requests.push({
        model: body.model,
        maxTokens: body.max_tokens,
        beta1m: (request.headers.get("anthropic-beta") ?? "").includes("context-1m"),
        betaCount: (request.headers.get("anthropic-beta") ?? "").split(",").filter(Boolean).length,
        effort: body.output_config?.effort ?? null,
        thinking: body.thinking ?? null,
        largestMessageTextChars: textLengths.reduce((max, length) => Math.max(max, length), 0),
        ...(effortMatrix
          ? {
              role: subagent ? "subagent" : "main",
              ultracode: serializedMessages.includes("Ultracode is on"),
            }
          : {}),
      });
      if (toolLoop) {
        const adapted = adaptAnthropicMessagesRequest(body, {}, "v3-auto");
        if (!adapted.ok)
          return Response.json(
            {
              type: "error",
              error: { type: "invalid_request_error", message: adapted.message },
            },
            { status: 400 },
          );
        const prepared = transformToSdkRequest(adapted.value.body, body.model, {
          access: "fixture",
          refresh: "fixture",
          expires: 0,
          authMethod: "desktop",
          region: "us-east-1",
        });
        const history = (prepared.conversationState.history ?? []).map(visibleMessage);
        const previous = prefixes.at(-1);
        if (previous) {
          const changed = previous.flatMap((message, index) =>
            JSON.stringify(message) === JSON.stringify(history[index]) ? [] : [index],
          );
          if (changed.length)
            prefixChanges.push({ request: requests.length, changedIndexes: changed });
        }
        prefixes.push([...history, visibleMessage(prepared.conversationState.currentMessage)]);
        for (const message of body.messages) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content) {
            if (block.type !== "tool_result" || toolResults.has(block.tool_use_id)) continue;
            toolResults.add(block.tool_use_id);
            if (block.is_error) toolErrors++;
          }
        }
      }
      if (requests.length > 5) return new Response("fixture request limit", { status: 400 });
      const useAgent = test.agentLoop === true && !subagent && !hasToolResult;
      const useTool = useAgent || (toolLoop && ++replies <= 2);
      const message = {
        id: `msg_context_fixture_${requests.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: requests.length === 1 ? (test.usage ?? 1000) : 1000,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
      const events = [
        ["message_start", { type: "message_start", message }],
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: useTool
              ? {
                  type: "tool_use",
                  id: `fixture_tool_${useAgent ? "agent" : replies}`,
                  name: useAgent ? "Agent" : "Bash",
                  input: {},
                }
              : { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: useTool
              ? {
                  type: "input_json_delta",
                  partial_json: useAgent
                    ? JSON.stringify({
                        description: "Effort fixture",
                        prompt: `${subagentMarker}: return FIXTURE_OK.`,
                        subagent_type: "general-purpose",
                      })
                    : '{"command":"true","description":"Synthetic no-op fixture"}',
                }
              : { type: "text_delta", text: "FIXTURE_OK" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null },
            usage: {
              input_tokens: requests.length === 1 ? (test.usage ?? 1000) : 1000,
              output_tokens: 4,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(
        events
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream", "request-id": "req_context_fixture" } },
      );
    },
  });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_CONFIG_DIR: join(root, test.name),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: "fixture-only",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
    ...test.env,
    ...(useLauncher
      ? {
          KIROCLAUDE_CLAUDE_BIN: binary,
          KIROCLAUDE_CONFIG_DIR: join(root, test.name),
          KIROCLAUDE_BASE_URL: `http://127.0.0.1:${server.port}`,
          KIROCLAUDE_TOKEN_HELPER: tokenHelper,
        }
      : {}),
  };
  const child = spawn(
    useLauncher ? launcher : binary,
    [
      ...(test.args ?? []),
      ...(test.usage || toolLoop || effortMatrix ? ["--disable-slash-commands"] : ["--bare"]),
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--setting-sources",
      "",
      ...(test.settings ? ["--settings", JSON.stringify(test.settings)] : []),
      "--strict-mcp-config",
      "--system-prompt",
      "Synthetic local context-window fixture.",
      "--model",
      test.model,
      "--tools",
      toolLoop ? "Bash" : test.agentLoop ? "Agent" : "",
      "--permission-mode",
      toolLoop || test.agentLoop ? "bypassPermissions" : "dontAsk",
      ...(test.usage ? ["--input-format", "stream-json"] : ["Return FIXTURE_OK."]),
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let pendingLines = "";
  let followedUp = false;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    pendingLines += chunk.toString();
    const lines = pendingLines.split("\n");
    pendingLines = lines.pop() ?? "";
    for (const line of lines) {
      if (!test.usage || followedUp) continue;
      try {
        if (JSON.parse(line).type !== "result") continue;
        followedUp = true;
        child.stdin.end(
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "Return FIXTURE_OK again." },
          }) + "\n",
        );
      } catch {}
    }
  });
  child.stdin.on("error", () => {});
  if (test.usage)
    child.stdin.write(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "FIXTURE synthetic history. ".repeat(
              thresholdMode
                ? Math.ceil((test.usage * 4) / "FIXTURE synthetic history. ".length)
                : 1000,
            ) + "Return FIXTURE_OK.",
        },
      }) + "\n",
    );
  else child.stdin.end();
  child.stderr.on("data", (chunk) => (stderrBytes += chunk.length));
  const timer = setTimeout(() => child.kill("SIGTERM"), 25000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  server.stop(true);
  const messages = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const result = messages.findLast((item) => item.type === "result");
  return {
    case: test.name,
    ...exit,
    requests,
    ...(toolLoop
      ? {
          prefixChanges,
          prefixChecks: Math.max(0, prefixes.length - 1),
          toolResults: toolResults.size,
          toolErrors,
        }
      : {}),
    modelDiscoveryRequests: paths.filter((path) => path.endsWith("/models")).length,
    contextWindows: Object.values(result?.modelUsage ?? {}).map((usage) => usage.contextWindow),
    maxOutputTokens: Object.values(result?.modelUsage ?? {}).map((usage) => usage.maxOutputTokens),
    initModel: messages.find((item) => item.type === "system" && item.subtype === "init")?.model,
    success: result?.is_error === false && result.result === "FIXTURE_OK",
    ...(test.expectedWindow
      ? {
          expectedWindow: test.expectedWindow,
          windowMatches: Object.values(result?.modelUsage ?? {}).every(
            (usage) => usage.contextWindow === test.expectedWindow,
          ),
        }
      : {}),
    ...(test.usage
      ? {
          syntheticFirstInputTokens: test.usage,
          resultCount: messages.filter((item) => item.type === "result").length,
          reportedTotalInputTokens: Object.values(result?.modelUsage ?? {}).map(
            (usage) => usage.inputTokens,
          ),
          assistantInputTokens: messages
            .filter((item) => item.type === "assistant")
            .map((item) => item.message?.usage?.input_tokens ?? null),
          systemEvents: [
            ...new Set(
              messages.filter((item) => item.type === "system").map((item) => item.subtype),
            ),
          ],
          largeSyntheticHistory: thresholdMode,
          compactionBoundaries: messages.filter(
            (item) => item.type === "system" && item.subtype === "compact_boundary",
          ).length,
          compactions: messages
            .filter((item) => item.type === "system" && item.subtype === "compact_boundary")
            .map((item) => {
              const metadata = item.compact_metadata ?? item.compactMetadata ?? {};
              return {
                trigger: metadata.trigger,
                preTokens: metadata.pre_tokens,
                postTokens: metadata.post_tokens,
                durationMs: metadata.duration_ms,
                cumulativeDroppedTokens: metadata.cumulative_dropped_tokens,
                preservedMessageCount: metadata.preserved_messages?.uuids?.length ?? 0,
              };
            }),
        }
      : {}),
    ...(effortMatrix
      ? {
          expectedEffort: test.expectedEffort,
          expectedUltracode: test.expectedUltracode,
          effortMatches:
            requests.length > 0 &&
            requests.every(
              (item) =>
                item.effort === test.expectedEffort && item.ultracode === test.expectedUltracode,
            ),
          subagentRequests: requests.filter((item) => item.role === "subagent").length,
        }
      : {}),
    stderrBytes,
    realUpstreamRequests: 0,
  };
}

try {
  for (const test of cases.filter(
    (item) => !caseFilter || caseFilter.split(",").includes(item.name),
  )) {
    const result = await runCase(test);
    console.log(JSON.stringify(result));
    if (
      !result.success ||
      (test.expectedWindow !== undefined && result.contextWindows.length === 0) ||
      result.windowMatches === false ||
      (toolLoop &&
        (result.prefixChanges.length > 0 ||
          result.prefixChecks < 2 ||
          result.toolResults !== 2 ||
          result.toolErrors > 0)) ||
      (test.usage !== undefined &&
        (result.requests[0]?.largestMessageTextChars ?? 0) < test.usage * 4) ||
      (useLauncher && test.name === "1m-old-threshold" && result.compactionBoundaries !== 0) ||
      (useLauncher && test.name === "1m-above" && result.compactionBoundaries < 1) ||
      (effortMatrix &&
        (!result.effortMatches || (test.agentLoop === true && result.subagentRequests < 1)))
    )
      process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
