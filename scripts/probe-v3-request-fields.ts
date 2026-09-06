/**
 * Minimal, payload-safe KiroRuntime probe for OpenAI Responses request fields.
 *
 * Usage:
 *   bun run scripts/probe-v3-request-fields.ts --confirm \
 *     [--model gpt-5.6-sol] [--proxy http://127.0.0.1:1080]
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { attachKiroRuntimeRequest, createSdkClient } from "../src/core/sdk-client.js";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { KIRO_CONSTANTS } from "../src/kiro/constants.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

interface ProbeCase {
  readonly name: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly prompt: string;
}

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined
    ? fallback
    : (process.argv[index + 1] as string);
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function loadProbeAuth(): { readonly id: string; readonly auth: KiroAuthDetails } {
  const path = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "kiro-provider",
    "accounts.db",
  );
  const database = new Database(path, { readonly: true });
  try {
    const now = Date.now();
    const row = database
      .query(
        `SELECT id, auth_method, region, oidc_region, client_id, client_secret,
                profile_arn, refresh_token, access_token, expires_at
           FROM accounts
          WHERE is_healthy = 1 AND expires_at > ?
            AND COALESCE(rate_limit_reset, 0) < ?
            AND COALESCE(overage_count, 0) = 0
          ORDER BY used_count ASC, expires_at DESC
          LIMIT 1`,
      )
      .get(now + 30 * 60 * 1_000, now) as Record<string, unknown> | null;
    if (!row) throw new Error("No healthy account with a fresh access token is available");
    const authMethod = row.auth_method === "idc" ? "idc" : "desktop";
    return {
      id: String(row.id),
      auth: {
        refresh: encodeRefreshToken({
          refreshToken: String(row.refresh_token),
          authMethod,
          ...(row.client_id ? { clientId: String(row.client_id) } : {}),
          ...(row.client_secret ? { clientSecret: String(row.client_secret) } : {}),
        }),
        access: String(row.access_token),
        expires: Number(row.expires_at),
        authMethod,
        region: String(row.region) as KiroAuthDetails["region"],
        ...(row.oidc_region
          ? { oidcRegion: String(row.oidc_region) as KiroAuthDetails["oidcRegion"] }
          : {}),
        ...(row.profile_arn ? { profileArn: String(row.profile_arn) } : {}),
      },
    };
  } finally {
    database.close();
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const metadata = Reflect.get(error, "$metadata");
  return typeof metadata === "object" && metadata !== null
    ? (Reflect.get(metadata, "httpStatusCode") as number | undefined)
    : undefined;
}

function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  const name = Reflect.get(error, "name");
  const reason = Reflect.get(error, "reason");
  return typeof reason === "string" ? reason : typeof name === "string" ? name : "unknown_error";
}

async function runCase(
  probe: ProbeCase,
  model: string,
  account: ReturnType<typeof loadProbeAuth>,
  proxyUrl?: string,
): Promise<Record<string, unknown>> {
  const client = createSdkClient(
    account.auth,
    account.auth.region,
    undefined,
    KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region),
    proxyUrl,
    account.id,
    false,
  );
  const conversationId = crypto.randomUUID();
  const input: GenerateAssistantResponseCommandInput = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      agentContinuationId: crypto.randomUUID(),
      agentTaskType: "vibe",
      currentMessage: {
        userInputMessage: {
          content: probe.prompt,
          modelId: model,
          origin: "AI_EDITOR",
        },
      },
    },
    ...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
    ...(probe.fields
      ? {
          additionalModelRequestFields:
            probe.fields as GenerateAssistantResponseCommandInput["additionalModelRequestFields"],
        }
      : {}),
  };
  const command = new GenerateAssistantResponseCommand(input);
  attachKiroRuntimeRequest(command);
  const startedAt = performance.now();
  let text = "";
  let eventCount = 0;
  let witnessed = false;
  try {
    const response = await client.send(command);
    for await (const event of response.generateAssistantResponseResponse ?? []) {
      eventCount += 1;
      text += event.assistantResponseEvent?.content ?? "";
      if (event.metadataEvent?.tokenUsage !== undefined) witnessed = true;
    }
    return {
      name: probe.name,
      ok: true,
      status: 200,
      duration_ms: Math.round(performance.now() - startedAt),
      event_count: eventCount,
      completion_witnessed: witnessed,
      text_chars: text.length,
      text_hash: hash16(text),
    };
  } catch (error) {
    return {
      name: probe.name,
      ok: false,
      status: statusOf(error),
      code: codeOf(error),
      message: error instanceof Error ? error.message : String(error),
      duration_ms: Math.round(performance.now() - startedAt),
    };
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Live probes require --confirm");
  }
  const model = argument("--model", "gpt-5.6-sol");
  const proxyUrl = argument("--proxy") || undefined;
  const selectedCases = new Set(
    argument("--cases")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const account = loadProbeAuth();
  const probes: readonly ProbeCase[] = [
    { name: "control", prompt: "Reply with exactly FIELD_PROBE_OK." },
    {
      name: "temperature",
      fields: { temperature: 0 },
      prompt: "Reply with exactly FIELD_PROBE_OK.",
    },
    {
      name: "top_p",
      fields: { top_p: 0.9 },
      prompt: "Reply with exactly FIELD_PROBE_OK.",
    },
    {
      name: "max_output_tokens",
      fields: { max_output_tokens: 64 },
      prompt: "Reply with exactly FIELD_PROBE_OK.",
    },
    {
      name: "response_format",
      fields: { response_format: { type: "json_object" } },
      prompt: 'Return exactly {"ok":true}.',
    },
    {
      name: "text_format",
      fields: { text: { format: { type: "json_object" } } },
      prompt: 'Return exactly {"ok":true}.',
    },
  ];
  const results = [];
  for (const probe of probes.filter(
    (candidate) => selectedCases.size === 0 || selectedCases.has(candidate.name),
  )) {
    results.push(await runCase(probe, model, account, proxyUrl));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        model,
        account_hash: hash16(account.id),
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main();
