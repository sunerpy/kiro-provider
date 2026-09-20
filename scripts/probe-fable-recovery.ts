/**
 * Live, bounded Fable recovery probe against two already-running isolated gateways.
 * Both configs must use the same synthetic tenant/keyring and distinct loopback ports.
 * Their account databases must contain different accounts in the same profile.
 * Usage: bun scripts/probe-fable-recovery.ts --config-a PATH --config-b PATH --confirm
 * Never writes captured content, signatures, token hashes or account identifiers.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { defaultConfigPath } from "../src/config/paths.js";
import type { Config } from "../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import {
  decodePortableReplayToken,
  encodePortableReplayToken,
} from "../src/reasoning/replay-token.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { checkApiKey } from "../src/server/auth-gate.js";

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: string | Block[] };
interface Reply {
  status: number;
  content: Block[];
  omitted: boolean;
  failed: boolean;
  signatureRejected: boolean;
}
const MODEL = "claude-fable-5-1";
const tools = [
  {
    name: "TaskOutput",
    description:
      "Read the provided synthetic fixture task. The caller supplies its result; no command is executed.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        block: { type: "boolean" },
        timeout: { type: "integer" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "TaskStop",
    description: "Stop a synthetic task. This is not needed for the fixture.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(name);
  return i < 0 ? undefined : Bun.argv[i + 1];
}
function isolatedConfig(name: string): Config {
  const path = arg(name);
  if (!path || resolve(path) === resolve(defaultConfigPath())) {
    throw new Error("isolated_configuration_required");
  }
  const config = loadConfig({ configPath: path, env: {} });
  if (
    config.host !== "127.0.0.1" ||
    config.port === 8787 ||
    config.port === 0 ||
    config.account_maintenance_enabled ||
    config.reasoning_replay_keys.length === 0
  ) {
    throw new Error("isolated_configuration_required");
  }
  return config;
}
function summary(reply: Reply) {
  return {
    status: reply.status,
    omitted: reply.omitted,
    failed: reply.failed,
    signature_rejected: reply.signatureRejected,
    thinking_blocks: reply.content.filter((block) => block.type === "thinking").length,
    tool_calls: reply.content.filter((block) => block.type === "tool_use").length,
    text_chars: reply.content.reduce(
      (n, block) => n + (typeof block.text === "string" ? block.text.length : 0),
      0,
    ),
  };
}
function textOf(reply: Reply): string {
  return reply.content.map((block) => (typeof block.text === "string" ? block.text : "")).join("");
}
async function post(
  config: Config,
  messages: Message[],
  stream: boolean,
  declarations = tools,
): Promise<Reply> {
  const response = await fetch(`http://${config.host}:${config.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.api_keys[0] as string },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages,
      stream,
      tools: declarations,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "max" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  const signatureRejected = !response.ok && /signature|reasoning_replay/i.test(raw);
  const content: Block[] = [];
  let failed = !response.ok;
  if (response.ok && stream) {
    const blocks = new Map<number, Block>();
    const argumentsByIndex = new Map<number, string>();
    let completed = false;
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "error") failed = true;
      if (event.type === "message_stop") completed = true;
      if (event.type === "content_block_start") blocks.set(event.index, { ...event.content_block });
      if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (!block) throw new Error("invalid_fixture_stream");
        if (event.delta.type === "text_delta")
          block.text = String(block.text ?? "") + event.delta.text;
        if (event.delta.type === "thinking_delta")
          block.thinking = String(block.thinking ?? "") + event.delta.thinking;
        // These are fragments of ONE Anthropic block, never separate Kiro signatures.
        if (event.delta.type === "signature_delta")
          block.signature = String(block.signature ?? "") + event.delta.signature;
        if (event.delta.type === "input_json_delta")
          argumentsByIndex.set(
            event.index,
            (argumentsByIndex.get(event.index) ?? "") + event.delta.partial_json,
          );
      }
    }
    failed ||= !completed;
    for (const [index, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      if (block.type === "tool_use") block.input = JSON.parse(argumentsByIndex.get(index) ?? "{}");
      content.push(block);
    }
  } else if (response.ok) {
    const value = JSON.parse(raw);
    if (!Array.isArray(value.content)) throw new Error("invalid_fixture_response");
    content.push(...value.content);
  }
  return {
    status: response.status,
    content,
    failed,
    signatureRejected,
    omitted: response.headers.get("x-kiro-reasoning-replay-mode") === "conflict-omitted",
  };
}

function corruptUpstreamSignature(config: Config, messages: Message[]): Message[] {
  const adapted = adaptAnthropicMessagesRequest(
    {
      model: MODEL,
      max_tokens: 4096,
      messages,
      tools,
      thinking: { type: "adaptive", display: "omitted" },
    },
    {},
    "v3-auto",
  );
  if (!adapted.ok) throw new Error("fixture_replay_not_adapted");
  const replay = adapted.value.body.reasoningReplays[0];
  if (!replay || replay.lookup.kind !== "anthropic-token") throw new Error("fixture_token_missing");
  const auth = checkApiKey(
    new Request("http://fixture", {
      headers: { "x-api-key": config.api_keys[0] as string },
    }),
    config.api_keys,
  );
  if (!auth.ok) throw new Error("fixture_tenant_missing");
  const context = {
    tenantId: auth.tenantId,
    model: MODEL,
    outputFingerprint: replay.outputFingerprint,
  };
  const keyring = loadReasoningReplayKeyring(config);
  const decoded = decodePortableReplayToken(replay.lookup.signature, context, keyring);
  if (decoded.legacy || decoded.content.kind !== "reasoning_text")
    throw new Error("fixture_token_not_portable");
  const signature = decoded.content.signature;
  const corrupted = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const token = encodePortableReplayToken(
    { text: decoded.content.text, signature: corrupted },
    context,
    { accountId: decoded.accountId, conversationId: decoded.conversationId },
    decoded.provenance,
    keyring.active,
  );
  const copy = structuredClone(messages);
  const assistant = copy[1];
  if (!assistant || !Array.isArray(assistant.content)) throw new Error("fixture_assistant_missing");
  const thinking = assistant.content.find((block) => block.type === "thinking");
  if (!thinking) throw new Error("fixture_thinking_missing");
  thinking.signature = token;
  return copy;
}

async function main() {
  if (!Bun.argv.includes("--confirm")) throw new Error("live_inference_requires_confirm");
  const a = isolatedConfig("--config-a");
  const b = isolatedConfig("--config-b");
  if (
    a.port === b.port ||
    a.api_keys[0] !== b.api_keys[0] ||
    JSON.stringify(a.reasoning_replay_keys) !== JSON.stringify(b.reasoning_replay_keys)
  )
    throw new Error("isolated_pair_mismatch");
  const trials = Number(arg("--trials") ?? "3");
  if (!Number.isInteger(trials) || trials < 1 || trials > 3) throw new Error("invalid_trial_bound");
  const evidence: Record<string, unknown>[] = [];
  let passed = true;
  for (let trial = 0; trial < trials; trial++) {
    const marker = `FIXTURE_${randomUUID().slice(0, 8)}`;
    const firstInput: Message = {
      role: "user",
      content: `Call TaskOutput exactly once with task_id "${marker}". This is a synthetic API fixture, not a real background task. Wait for its result, then reply exactly "${marker}:41". Do not call TaskStop.`,
    };
    const stream = trial % 2 === 0;
    const first = await post(a, [firstInput], stream);
    const calls = first.content.filter((block) => block.type === "tool_use");
    if (first.failed || calls.length !== 1 || calls[0]?.name !== "TaskOutput") {
      evidence.push({ trial, phase: "first_tool", passed: false, response: summary(first) });
      passed = false;
      break;
    }
    const history: Message[] = [
      firstInput,
      { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: "41" }] },
    ];
    const same = await post(a, history, stream);
    const migrated = await post(b, history, stream);
    const followup = await post(
      b,
      [
        ...history,
        { role: "assistant", content: migrated.content },
        {
          role: "user",
          content: `Recall the fixture result. Reply exactly "${marker}:41" without calling tools.`,
        },
      ],
      stream,
    );
    const withdrawn = await post(a, history, stream, [tools[1] as (typeof tools)[number]]);
    const visibleHistory = structuredClone(history);
    const assistant = visibleHistory[1];
    if (assistant && Array.isArray(assistant.content)) {
      assistant.content = assistant.content.filter(
        (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
      );
    }
    const visible = await post(a, visibleHistory, stream, [tools[1] as (typeof tools)[number]]);
    const signed = first.content.some(
      (block) => typeof block.signature === "string" && block.signature.startsWith("kr2_"),
    );
    const negative = signed
      ? await post(b, corruptUpstreamSignature(a, history), stream)
      : undefined;
    const answerMatches = (reply: Reply) =>
      !reply.failed &&
      textOf(reply).includes(`${marker}:41`) &&
      !reply.content.some((block) => block.type === "tool_use");
    const trialPassed =
      signed &&
      answerMatches(same) &&
      answerMatches(migrated) &&
      answerMatches(followup) &&
      answerMatches(visible) &&
      negative?.signatureRejected === true &&
      (answerMatches(withdrawn) || withdrawn.signatureRejected);
    evidence.push({
      trial,
      stream,
      passed: trialPassed,
      signed_replay: signed,
      first: summary(first),
      same_account: summary(same),
      migrated: summary(migrated),
      followup: summary(followup),
      withdrawn_signed: summary(withdrawn),
      withdrawn_visible_only: summary(visible),
      corrupted_upstream_signature: negative ? summary(negative) : null,
      same_answer: answerMatches(same),
      migrated_answer: answerMatches(migrated),
      followup_answer: answerMatches(followup),
      visible_answer: answerMatches(visible),
    });
    passed &&= trialPassed;
  }
  console.log(JSON.stringify({ model: MODEL, trials, passed, evidence }, null, 2));
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(() => {
    // Exception prose can contain response payloads, paths or authentication material.
    console.log(JSON.stringify({ passed: false, phase: "probe_error" }));
    process.exitCode = 1;
  });
}
