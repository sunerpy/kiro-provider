/**
 * Bounded packaged-binary Kiro probe with one read-only production account snapshot.
 * bun scripts/probe-claude-compatibility-live.ts --confirm --binary /private/candidate \
 *   --out /private/evidence.json [--accounts-db /private/accounts.db] [--keep-server]
 * Retained state is private; refresh credentials never enter the snapshot.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platformConfigRoot } from "../src/config/paths.js";
import { ConfigSchema } from "../src/config/schema.js";
import { RegionSchema } from "../src/kiro/regions.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

type Json = Record<string, unknown>;
type Block = { type: string; [key: string]: unknown };
type Result = {
  status: number;
  content: Block[];
  events: string[];
  bytes: number;
  errorType: string | null;
};
type Row = { case: string; ok: boolean; [key: string]: unknown };

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotAccount(sourcePath: string, destination: string): number {
  const source = new Database(sourcePath, { readonly: true });
  let row: Json | null;
  const now = Date.now();
  try {
    row = source
      .query<Json, [number, number]>(`
      SELECT id, email, auth_method, region, oidc_region, profile_arn,
             access_token, expires_at, used_count, limit_count
        FROM accounts
       WHERE is_healthy = 1 AND expires_at > ?
         AND COALESCE(rate_limit_reset, 0) < ? AND COALESCE(overage_count, 0) = 0
         AND COALESCE(access_token, '') != '' AND COALESCE(profile_arn, '') != ''
         AND auth_method IN ('desktop', 'idc')
         AND (COALESCE(limit_count, 0) = 0 OR COALESCE(used_count, 0) < limit_count)
         AND NOT EXISTS (SELECT 1 FROM removed_accounts WHERE removed_accounts.id = accounts.id)
       ORDER BY used_count ASC, expires_at DESC LIMIT 1
    `)
      .get(now + 30 * 60_000, now);
  } finally {
    source.close();
  }
  requireCondition(row, "no_fresh_healthy_account");
  const account: ManagedAccount = {
    id: String(row.id),
    email: String(row.email),
    authMethod: row.auth_method === "idc" ? "idc" : "desktop",
    // IdC encoding validates these fields even when the fresh access token
    // avoids refresh. Placeholders satisfy that local shape without copying
    // credentials that could rotate the production login.
    ...(row.auth_method === "idc"
      ? { clientId: "isolated-snapshot-client", clientSecret: "isolated-snapshot-secret" }
      : {}),
    region: RegionSchema.parse(row.region),
    ...(row.oidc_region ? { oidcRegion: RegionSchema.parse(row.oidc_region) } : {}),
    profileArn: String(row.profile_arn),
    refreshToken: "isolated-snapshot-refresh-disabled",
    accessToken: String(row.access_token),
    expiresAt: Number(row.expires_at),
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: Number(row.used_count ?? 0),
    limitCount: Number(row.limit_count ?? 0),
    overageCount: 0,
  };
  const database = new AccountsDatabase(destination);
  try {
    database.insertAccount(account);
  } finally {
    database.close();
  }
  return Math.floor((account.expiresAt - now) / 60_000);
}

function parseResult(status: number, wire: string, stream: boolean): Result {
  const content: Block[] = [];
  const events: string[] = [];
  let errorType: string | null = null;
  if (!stream || status !== 200) {
    const body: unknown = JSON.parse(wire);
    requireCondition(record(body), "invalid_json_response");
    if (Array.isArray(body.content)) {
      for (const block of body.content) {
        requireCondition(record(block) && typeof block.type === "string", "invalid_content_block");
        content.push(block as Block);
      }
    }
    if (
      record(body.error) &&
      ["api_error", "invalid_request_error", "authentication_error"].includes(
        String(body.error.type),
      )
    ) {
      errorType = String(body.error.type);
    }
  } else {
    const inputs = new Map<number, string>();
    for (const line of wire.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event: unknown = JSON.parse(line.slice(6));
      requireCondition(record(event) && typeof event.type === "string", "invalid_sse_event");
      requireCondition(
        [
          "message_start",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
          "message_delta",
          "message_stop",
          "ping",
          "error",
        ].includes(event.type),
        "invalid_sse_event",
      );
      events.push(event.type);
      const index = Number(event.index);
      if (event.type === "content_block_start") {
        requireCondition(
          record(event.content_block) && typeof event.content_block.type === "string",
          "invalid_content_block",
        );
        content[index] = { ...event.content_block } as Block;
      } else if (event.type === "content_block_delta") {
        const block = content[index];
        requireCondition(block && record(event.delta), "invalid_content_delta");
        const delta = event.delta;
        if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
        if (delta.type === "thinking_delta")
          block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
        if (delta.type === "signature_delta")
          block.signature = `${block.signature ?? ""}${delta.signature}`;
        if (delta.type === "input_json_delta")
          inputs.set(index, `${inputs.get(index) ?? ""}${delta.partial_json}`);
      } else if (event.type === "error") errorType = "api_error";
    }
    for (const [index, input] of inputs) {
      const block = content[index];
      requireCondition(block, "invalid_content_block");
      block.input = JSON.parse(input);
    }
  }
  return { status, content, events, errorType, bytes: Buffer.byteLength(wire) };
}

function summary(result: Result): Json {
  const thinking = result.content.filter((block) => block.type === "thinking");
  const visible = result.content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  return {
    status: result.status,
    response_bytes: result.bytes,
    content_blocks: result.content.length,
    thinking_blocks: thinking.length,
    thinking_chars: thinking.reduce(
      (count, block) => count + String(block.thinking ?? "").length,
      0,
    ),
    signature_chars: thinking.reduce(
      (count, block) => count + String(block.signature ?? "").length,
      0,
    ),
    tool_calls: result.content.filter((block) => block.type === "tool_use").length,
    visible_chars: visible.length,
    visible_sha256: hash(visible),
    sse_events: result.events.length,
    message_stop_events: result.events.filter((type) => type === "message_stop").length,
    error_events: result.events.filter((type) => type === "error").length,
    error_type: result.errorType,
  };
}

async function main(): Promise<void> {
  requireCondition(process.argv.includes("--confirm"), "confirmation_required");
  const binary = option("--binary");
  const output = option("--out");
  requireCondition(binary && output, "binary_and_output_required");
  const binaryPath = resolve(binary);
  const existingState = option("--reuse-state");
  const existingPid = Number(option("--server-pid"));
  const root = existingState
    ? resolve(existingState)
    : mkdtempSync(join(tmpdir(), "kiro-compat-live-"));
  if (existingState) {
    requireCondition(
      root.startsWith(join(tmpdir(), "kiro-compat-live-")) && realpathSync(root) === root,
      "isolated_state_required",
    );
    requireCondition(
      Number.isSafeInteger(existingPid) &&
        existingPid > 0 &&
        readlinkSync(`/proc/${existingPid}/exe`) === binaryPath,
      "candidate_pid_required",
    );
  }
  chmodSync(root, 0o700);
  const target = join(root, "xdg", "kiro-provider");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const source =
    option("--accounts-db") ?? join(platformConfigRoot(), "kiro-provider", "accounts.db");
  const configPath = join(target, "config.json");
  const existingConfig = existingState
    ? ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    : undefined;
  let minutes: number;
  if (existingState) {
    const database = new Database(join(target, "accounts.db"), { readonly: true });
    const snapshot = database
      .query<{ count: number; expires: number }, []>(
        "SELECT COUNT(*) AS count, MIN(expires_at) AS expires FROM accounts WHERE is_healthy = 1",
      )
      .get();
    database.close();
    requireCondition(
      snapshot?.count === 1 && snapshot.expires > Date.now() + 30 * 60_000,
      "no_fresh_healthy_account",
    );
    minutes = Math.floor((snapshot.expires - Date.now()) / 60_000);
  } else minutes = snapshotAccount(source, join(target, "accounts.db"));
  const reservation = existingState
    ? undefined
    : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = existingConfig?.port ?? reservation?.port;
  reservation?.stop(true);
  requireCondition(
    port !== undefined && port > 0 && existingConfig?.host !== "0.0.0.0",
    "isolated_port_required",
  );
  requireCondition(port !== 8787, "isolated_port_required");
  const key =
    existingConfig?.api_keys[0] ?? `sk-synthetic-compat-${randomBytes(16).toString("hex")}`;
  const config =
    existingConfig ??
    ConfigSchema.parse({
      api_keys: [key],
      host: "127.0.0.1",
      port,
      auth_source: "local",
      proxy_url: option("--proxy") ?? "http://127.0.0.1:1080",
      account_maintenance_enabled: false,
      dynamic_model_catalog: false,
      stream_max_attempts: 1,
      rate_limit_max_retries: 0,
      retry_empty_completion: false,
      request_timeout_ms: 240_000,
      stream_idle_timeout_ms: 120_000,
      token_expiry_buffer_ms: 60_000,
      log_level: "warn",
      instance_lock_path: join(target, "instance.lock"),
      reasoning_replay_key_path: join(target, "reasoning-replay-keys.json"),
    });
  requireCondition(
    config.host === "127.0.0.1" &&
      config.auth_source === "local" &&
      !config.account_maintenance_enabled &&
      !config.dynamic_model_catalog,
    "isolated_state_required",
  );
  if (!existingState)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const logPath = join(root, "provider.log");
  const log = openSync(logPath, "a", 0o600);
  const child = existingState
    ? undefined
    : spawn(binaryPath, ["serve", "--config", configPath], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          XDG_CONFIG_HOME: join(root, "xdg"),
          XDG_STATE_HOME: join(root, "state"),
          NO_PROXY: "127.0.0.1,localhost",
        },
        detached: true,
        stdio: ["ignore", log, log],
      });
  closeSync(log);
  child?.unref();
  const pid = child?.pid ?? existingPid;
  const base = `http://127.0.0.1:${port}`;
  const binarySha256 = hash(readFileSync(binaryPath));
  const rows: Row[] = [];
  const report = () => {
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          schema_version: 1,
          binary_sha256: binarySha256,
          selected_accounts: 1,
          min_token_remaining_minutes: minutes,
          source_readonly: true,
          refresh_credentials_copied: false,
          account_maintenance_enabled: false,
          dynamic_model_catalog: false,
          proxy_enabled: true,
          generation_request_count: rows.length,
          rows,
          pass: rows.length === 4 && rows.every((row) => row.ok),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const response = await fetch(`${base}/health`, {
          headers: { "x-api-key": key },
          signal: AbortSignal.timeout(2_000),
        });
        await response.arrayBuffer();
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(100);
    }
    requireCondition(ready, "candidate_gateway_not_ready");
    writeFileSync(
      join(root, "runtime.json"),
      JSON.stringify({
        provider_config: configPath,
        base_url: base,
        pid,
        binary_sha256: binarySha256,
      }),
      { mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ event: "live_gateway_ready", state: root, provider_config: configPath, base_url: base, pid, binary_sha256: binarySha256 })}\n`,
    );

    const send = async (body: Json): Promise<Result> => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(250_000),
      });
      return parseResult(response.status, await response.text(), body.stream === true);
    };
    const run = async (
      name: string,
      body: Json,
      verify: (result: Result) => boolean,
    ): Promise<Result> => {
      const start = performance.now();
      const result = await send(body);
      rows.push({
        case: name,
        ok: verify(result),
        effort: (body.output_config as Json)?.effort ?? null,
        stream: body.stream === true,
        duration_ms: Math.round(performance.now() - start),
        ...summary(result),
      });
      report();
      process.stdout.write(
        `${JSON.stringify({ event: "live_case_finished", case: name, ok: rows.at(-1)?.ok, status: result.status })}\n`,
      );
      return result;
    };
    const initial = {
      role: "user",
      content:
        "Find the smallest positive integer with remainders 5 mod 17, 7 mod 19, 11 mod 23, and 13 mod 29. Verify the remainders in your reasoning, then call fixture_record with the answer. Do not give a final answer before the tool call.",
    };
    const request = {
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    };
    const signed = (result: Result) =>
      result.status === 200 &&
      result.content.some(
        (block) =>
          block.type === "thinking" &&
          String(block.thinking ?? "").length > 0 &&
          String(block.signature ?? "").length > 0,
      ) &&
      !result.events.includes("error");
    const first = await run(
      "summary-json-tool",
      {
        ...request,
        stream: false,
        messages: [initial],
        tools: [
          {
            name: "fixture_record",
            description: "Record one computed integer for this synthetic probe.",
            input_schema: {
              type: "object",
              properties: { value: { type: "integer" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      },
      (result) =>
        signed(result) && result.content.filter((block) => block.type === "tool_use").length === 1,
    );
    const call = first.content.find((block) => block.type === "tool_use");
    requireCondition(
      first.status === 200 && call && record(call.input),
      "initial_signed_tool_turn_failed",
    );
    await run(
      "summary-sse-tool-replay",
      {
        ...request,
        stream: true,
        output_config: { effort: "xhigh" },
        tools: [],
        messages: [
          initial,
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: JSON.stringify({ value: call.input.value, recorded: true }),
              },
              {
                type: "text",
                text: "The value was recorded. Compute the next larger solution by adding the modulus period, verify its four remainders, and return only the next integer. Do not call tools.",
              },
            ],
          },
        ],
      },
      (result) =>
        signed(result) &&
        result.events.filter((type) => type === "message_stop").length === 1 &&
        result.content.every((block) => block.type !== "tool_use"),
    );
    const schema = {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        impossible: { type: "boolean" },
      },
      required: ["ok", "reason"],
      additionalProperties: false,
    };
    for (const stream of [false, true]) {
      const body = {
        model: "claude-sonnet-5",
        max_tokens: 4096,
        stream,
        output_config: { effort: "high", format: { type: "json_schema", schema } },
        messages: [
          {
            role: "user",
            content: `Evaluate the goal using only this synthetic transcript. Goal: execute printf FIXTURE_DONE and observe exit code 0 and output FIXTURE_DONE. Transcript: ${stream ? "The Bash command completed with exit code 0 and output FIXTURE_DONE." : "The assistant announced a plan to run Bash, but no tool was called."} Return only a JSON object with boolean ok, string reason, and boolean impossible. impossible must be false. ok must reflect the execution evidence.`,
          },
        ],
      };
      await run(stream ? "goal-sse-complete" : "goal-json-continue", body, (result) => {
        if (result.status !== 200 || result.events.includes("error")) return false;
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => String(block.text ?? ""))
          .join("");
        try {
          const value: unknown = JSON.parse(text);
          return (
            record(value) &&
            value.ok === stream &&
            typeof value.reason === "string" &&
            value.impossible === false &&
            (!stream || result.events.filter((type) => type === "message_stop").length === 1)
          );
        } catch {
          return false;
        }
      });
    }
    requireCondition(
      rows.every((row) => row.ok),
      "live_case_failed",
    );
    process.stdout.write(
      `${JSON.stringify({ event: "live_probe_finished", pass: true, cases: rows.length })}\n`,
    );
  } finally {
    report();
    if (child && !process.argv.includes("--keep-server")) {
      child.kill("SIGTERM");
      await Bun.sleep(250);
      if (child?.exitCode === null) child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }
}

void main().catch((error) => {
  const codes = new Set([
    "confirmation_required",
    "binary_and_output_required",
    "no_fresh_healthy_account",
    "isolated_port_required",
    "candidate_gateway_not_ready",
    "isolated_state_required",
    "candidate_pid_required",
    "invalid_json_response",
    "invalid_content_block",
    "invalid_sse_event",
    "invalid_content_delta",
    "initial_signed_tool_turn_failed",
    "live_case_failed",
  ]);
  process.stderr.write(
    `${JSON.stringify({ pass: false, code: error instanceof Error && codes.has(error.message) ? error.message : "live_probe_failed" })}\n`,
  );
  process.exitCode = 1;
});
