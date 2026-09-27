// Offline packaged-binary regression. Synthetic accounts and AWS EventStream
// frames only; the upstream is loopback and no installed service is changed.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { fromUtf8, toUtf8 } from "@smithy/core/serde";
import { AccountsDatabase } from "../src/storage/accounts-db.ts";

const index = process.argv.indexOf("--binary");
const binary = index >= 0 ? process.argv[index + 1] : undefined;
if (!binary) throw new Error("Usage: bun scripts/probe-opus-prefix.mjs --binary PATH");
const sha256 = createHash("sha256")
  .update(await Bun.file(binary).bytes())
  .digest("hex");
const root = await mkdtemp(join(tmpdir(), "kiro-opus-prefix-fixture-"));
await chmod(root, 0o700);
const state = join(root, "xdg", "kiro-provider");
await mkdir(state, { recursive: true, mode: 0o700 });
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const frame = (type, body) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: fromUtf8(JSON.stringify(body)),
  });
const empty = [
  ["reasoningContentEvent", { signature: "fixture-prefix-a", text: "" }],
  ["reasoningContentEvent", { signature: "fixture-prefix-b" }],
];
const marker = "OPUS_PREFIX_BINARY_OK";
const text = ["assistantResponseEvent", { content: marker }];
const cases = [
  {
    name: "empty-conflict-json",
    stream: false,
    events: [...empty, text],
    status: 200,
    omitted: true,
  },
  {
    name: "empty-conflict-sse",
    stream: true,
    events: [...empty, text],
    status: 200,
    omitted: true,
  },
  {
    name: "nonempty-conflict-json",
    stream: false,
    events: [
      ["reasoningContentEvent", { signature: "fixture-prefix-a", text: "fixture-private" }],
      empty[1],
      text,
    ],
    status: 502,
    omitted: false,
  },
  {
    name: "nonempty-conflict-sse",
    stream: true,
    events: [
      ["reasoningContentEvent", { signature: "fixture-prefix-a", text: "fixture-private" }],
      empty[1],
      text,
    ],
    status: 502,
    omitted: false,
  },
];
let calls = 0;
let maxPreserved = true;
let omittedForwarded = true;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.json();
    maxPreserved &&= body.additionalModelRequestFields?.output_config?.effort === "max";
    omittedForwarded &&= body.additionalModelRequestFields?.thinking?.display === "omitted";
    const scenario = cases[calls++];
    if (!scenario) return new Response("fixture bound exceeded", { status: 429 });
    return new Response(
      Buffer.concat([
        ...scenario.events.map(([type, value]) => frame(type, value)),
        frame("meteringEvent", { usage: 0.01, unit: "credit", unitPlural: "credits" }),
      ]),
      { headers: { "Content-Type": "application/vnd.amazon.eventstream" } },
    );
  },
});
const database = new AccountsDatabase(join(state, "accounts.db"));
database.insertAccount({
  id: "opus-prefix-fixture",
  email: "fixture@example.invalid",
  authMethod: "desktop",
  region: "us-east-1",
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
  expiresAt: Date.now() + 3_600_000,
  isHealthy: true,
  failCount: 0,
  rateLimitResetTime: 0,
  usedCount: 0,
  limitCount: 1000,
});
database.close();
const configPath = join(state, "config.json");
await Bun.write(
  configPath,
  JSON.stringify({
    host: "127.0.0.1",
    port: 0,
    api_keys: ["fixture-prefix-key"],
    auth_source: "local",
    account_maintenance_enabled: false,
    dynamic_model_catalog: false,
    proxy_url: null,
    test_upstream_endpoint: `http://127.0.0.1:${upstream.port}`,
    request_timeout_ms: 15_000,
    stream_idle_timeout_ms: 10_000,
    stream_max_attempts: 1,
    rate_limit_max_retries: 0,
    retry_empty_completion: false,
  }),
);
await chmod(configPath, 0o600);
const env = { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") };
for (const name of Object.keys(env)) {
  if (name.startsWith("KIRO_PROVIDER_") || /^(https?|all)_proxy$/i.test(name)) delete env[name];
}
const provider = Bun.spawn([resolve(binary), "serve", "--config", configPath], {
  cwd: root,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stderr = new Response(provider.stderr).text();
let passed = true;
const results = [];
try {
  const reader = provider.stdout.getReader();
  let output = "";
  let base;
  while (!base) {
    let timer;
    const part = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture_startup_timeout")), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (part.done) throw new Error("fixture_startup_failed");
    output += new TextDecoder().decode(part.value);
    base = output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  }
  for (const scenario of cases) {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "fixture-prefix-key" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 1024,
        stream: scenario.stream,
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "Return the synthetic fixture marker." }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    const omitted = response.headers.get("x-kiro-reasoning-replay-mode") === "conflict-omitted";
    const outputSeen = body.includes(marker);
    const leaked = ["fixture-prefix-a", "fixture-prefix-b", "fixture-private", "kr2_"].some((s) =>
      body.includes(s),
    );
    const success =
      response.status === scenario.status &&
      omitted === scenario.omitted &&
      outputSeen === scenario.omitted &&
      !leaked &&
      (!scenario.stream || !scenario.omitted || body.includes("event: message_stop"));
    results.push({
      case: scenario.name,
      status: response.status,
      omitted,
      outputSeen,
      leaked,
      success,
    });
    passed &&= success;
  }
} finally {
  provider.kill("SIGTERM");
  await provider.exited;
  upstream.stop(true);
}
const auditRows = (await stderr).split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
const audit = auditRows.filter(
  (row) => row.event === "anthropic_output_reasoning_conflict_omitted",
);
passed &&= calls === cases.length && maxPreserved && omittedForwarded && audit.length === 2;
const evidence = {
  schemaVersion: 1,
  binarySha256: sha256,
  liveUpstreamRequests: 0,
  syntheticUpstreamCalls: calls,
  maxPreserved,
  omittedForwarded,
  omissionAudits: audit.map((row) => ({
    model: row.model,
    reasoningEvents: row.reasoning_event_count,
    prefixEvents: row.prefix_event_count,
    prefixBytes: row.prefix_bytes,
  })),
  results,
  passed,
};
console.log(JSON.stringify(evidence, null, 2));
await Bun.write(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ evidencePath: join(root, "evidence.json") }));
if (!passed) process.exitCode = 1;
