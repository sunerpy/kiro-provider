// Offline integration: real provider binary, AWS EventStream frames, and optional
// installed clients. All accounts, API keys, prompts, and state are synthetic.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const binary = option("--binary");
if (!binary) throw new Error("--binary must name the provider binary to verify");
const binarySha256 = createHash("sha256")
  .update(new Uint8Array(await Bun.file(binary).arrayBuffer())).digest("hex");
console.log(JSON.stringify({ kind: "binary", sha256: binarySha256 }));
const root = await mkdtemp(join(tmpdir(), "code-reference-fixture-"));
const state = join(root, "xdg", "kiro-provider");
await chmod(root, 0o700);
await mkdir(state, { recursive: true, mode: 0o700 });
const marker = "CODE_REFERENCE_FIXTURE_OK";
const references = [{
  licenseName: "MIT",
  repository: "fixture/public",
  url: "https://example.invalid/fixture/reference",
  recommendationContentSpan: { start: 0, end: marker.length },
}];
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const frame = (type, body) => codec.encode({
  headers: {
    ":message-type": { type: "string", value: "event" },
    ":event-type": { type: "string", value: type },
    ":content-type": { type: "string", value: "application/json" },
  },
  body: fromUtf8(JSON.stringify(body)),
});
let upstreamCalls = 0;
const upstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch() {
    upstreamCalls++;
    if (upstreamCalls > 16) return new Response("fixture request bound", { status: 429 });
    return new Response(Buffer.concat([
      frame("assistantResponseEvent", { content: marker }),
      frame("codeReferenceEvent", { references }),
      frame("meteringEvent", { usage: 0.01, unit: "credit", unitPlural: "credits" }),
    ]), { headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
  },
});
const db = new AccountsDatabase(join(state, "accounts.db"));
db.insertAccount({
  id: "code-reference-fixture", email: "fixture@example.invalid",
  authMethod: "desktop", region: "us-east-1",
  accessToken: "fixture-access", refreshToken: "fixture-refresh",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
  expiresAt: Date.now() + 3600000, isHealthy: true, failCount: 0,
  rateLimitResetTime: 0, usedCount: 0, limitCount: 1000,
});
db.close();
const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reserved.port;
reserved.stop(true);
const key = "code-reference-fixture-key";
const configPath = join(state, "config.json");
await Bun.write(configPath, JSON.stringify({
  host: "127.0.0.1", port, api_keys: [key], auth_source: "local",
  account_maintenance_enabled: false, dynamic_model_catalog: false,
  proxy_url: null, test_upstream_endpoint: `http://127.0.0.1:${upstream.port}`,
  request_timeout_ms: 15000, stream_idle_timeout_ms: 10000,
  stream_max_attempts: 1, rate_limit_max_retries: 0,
  retry_empty_completion: false, enable_legacy_chat_completions: true,
}));
await chmod(configPath, 0o600);
const env = { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") };
for (const name of Object.keys(env)) {
  if (name.startsWith("KIRO_PROVIDER_") || /^(https?|all)_proxy$/i.test(name)) delete env[name];
}
const provider = spawn(resolve(binary), ["serve", "--config", configPath], {
  cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
});
let providerLog = "";
provider.stdout.on("data", chunk => providerLog += chunk);
provider.stderr.on("data", chunk => providerLog += chunk);
const providerExit = new Promise(resolve => provider.once("exit", (code, signal) => resolve({ code, signal })));
const children = [];
const parseRows = (text) => text.split("\n").flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const parseSse = (text) => text.split("\n")
  .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
  .map(line => JSON.parse(line.slice(6)));
async function client(executable, args, childEnv) {
  const child = spawn(executable, args, {
    cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "", stderrBytes = 0, force;
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => stderrBytes += chunk.length);
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), 5000);
  }, 45000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { ...exit, events: parseRows(output), stderrBytes };
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
    if (ready) break;
    if (provider.exitCode !== null) break;
    await Bun.sleep(50);
  }
  if (!ready) throw new Error("Fixture provider did not become ready");
  for (const protocol of ["responses", "messages", "chat/completions"]) {
    for (const stream of [true, false]) {
      const body = protocol === "responses"
        ? { model: "gpt-5.6-sol", input: "Return fixture marker", reasoning: { effort: "max" }, store: false, stream }
        : { model: "claude-opus-5", messages: [{ role: "user", content: "Return fixture marker" }], max_tokens: 1024, stream };
      const response = await fetch(`http://127.0.0.1:${port}/v1/${protocol}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      const events = stream ? parseSse(text) : [];
      const result = !stream ? JSON.parse(text) : protocol === "responses"
        ? events.find(event => event.type === "response.completed")?.response
        : protocol === "messages" ? events.find(event => event.type === "message_delta")
          : events.find(event => event.choices?.[0]?.finish_reason);
      const retained = JSON.stringify(result?.x_kiro?.code_references) === JSON.stringify(references);
      const success = response.status === 200 && retained && text.includes(marker);
      const failureCodes = events.flatMap(event =>
        event.response?.error?.code ? [event.response.error.code] :
          event.error?.code ? [event.error.code] : []);
      console.log(JSON.stringify({ kind: "http", protocol, stream, status: response.status, retained, failureCodes, success }));
      if (!success) throw new Error(`Code reference contract failed: ${protocol}/${stream}`);
    }
  }
  if (process.argv.includes("--clients")) {
    const codexState = join(root, "codex-state");
    await mkdir(codexState, { mode: 0o700 });
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "dumb" };
    const codex = await client(option("--codex-bin", "codex"), [
      "exec", "--ephemeral", "--skip-git-repo-check", "--json",
      "-m", "gpt-5.6-sol", "-c", 'model_provider="fixture"',
      "-c", 'model_providers.fixture.name="Fixture"',
      "-c", `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
      "-c", 'model_providers.fixture.wire_api="responses"',
      "-c", 'model_providers.fixture.env_key="CODE_REFERENCE_FIXTURE_KEY"',
      "-c", 'model_reasoning_effort="max"',
      "Return the fixture marker, without tools.",
    ], { ...baseEnv, CODEX_HOME: codexState, CODE_REFERENCE_FIXTURE_KEY: key });
    const codexOk = codex.code === 0 && codex.events.some(event =>
      event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text === marker);
    console.log(JSON.stringify({ kind: "client", client: "codex", code: codex.code, success: codexOk, stderrBytes: codex.stderrBytes }));
    if (!codexOk) throw new Error("Codex did not accept the terminal code-reference metadata");
    const helper = join(root, "fixture-token");
    await Bun.write(helper, `#!/bin/sh\nprintf '%s\\n' '${key}'\n`);
    await chmod(helper, 0o700);
    const claude = await client(fileURLToPath(new URL("./kiroclaude", import.meta.url)), [
      "-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "",
      "--strict-mcp-config", "--model", "opus", "--tools", "", "--no-session-persistence",
      "Return the fixture marker, without tools.",
    ], {
      ...baseEnv, KIROCLAUDE_CONFIG_DIR: join(root, "claude-state"),
      KIROCLAUDE_BASE_URL: `http://127.0.0.1:${port}`,
      KIROCLAUDE_TOKEN_HELPER: helper,
      KIROCLAUDE_CLAUDE_BIN: option("--claude-bin", "claude"),
      CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
    });
    const claudeOk = claude.code === 0 && claude.events.some(event =>
      event.type === "result" && event.is_error === false && event.result === marker);
    console.log(JSON.stringify({ kind: "client", client: "claude", code: claude.code, success: claudeOk, stderrBytes: claude.stderrBytes }));
    if (!claudeOk) throw new Error("Claude did not accept the terminal code-reference metadata");
  }
  const warnings = parseRows(providerLog).filter(row => row.level === "warn" || row.level === "error");
  if (warnings.some(row => row.error_code === "unsupported_upstream_event"))
    throw new Error("Provider rejected the code reference fixture");
  console.log(JSON.stringify({ kind: "summary", success: true, upstreamCalls, realUpstreamRequests: 0 }));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (provider.exitCode === null && provider.signalCode === null) provider.kill("SIGTERM");
  await providerExit;
  upstream.stop(true);
  await rm(root, { recursive: true, force: true });
}
