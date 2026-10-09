/**
 * Bounded direct Kiro signature-shape probe. All prompts and histories are
 * synthetic; fresh access credentials stay in memory and the source DB is
 * read-only. No refresh, service, installed binary or production state writes.
 * bun scripts/probe-reasoning-signatures.ts --confirm --out /private/result.json
 *   [--display summarized|omitted] [--turns 1|2|3] [--long]
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ChatMessage,
  GenerateAssistantResponseCommand,
} from "@aws/codewhisperer-streaming-client";
import { platformConfigRoot } from "../src/config/paths.js";
import {
  attachKiroRuntimeRequest,
  clearSdkClientCache,
  createSdkClient,
} from "../src/core/sdk-client.js";
import { RegionSchema } from "../src/kiro/regions.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
type AccountRow = {
  access_token: string;
  expires_at: number;
  region: string;
  profile_arn: string;
  auth_method: string;
};

async function main(): Promise<void> {
  requireCondition(process.argv.includes("--confirm"), "confirmation_required");
  const output = option("--out");
  requireCondition(
    output && !resolve(output).startsWith(`${resolve(import.meta.dir, "..")}/`),
    "external_output_required",
  );
  const display = option("--display") ?? "summarized";
  requireCondition(display === "summarized" || display === "omitted", "invalid_display");
  const turns = Number(option("--turns") ?? "3");
  requireCondition(Number.isInteger(turns) && turns >= 1 && turns <= 3, "invalid_turn_count");
  const database = new Database(
    option("--accounts-db") ?? join(platformConfigRoot(), "kiro-provider", "accounts.db"),
    { readonly: true },
  );
  let row: AccountRow | null;
  const now = Date.now();
  try {
    row = database
      .query<AccountRow, [number, number]>(`
      SELECT access_token, expires_at, region, profile_arn, auth_method FROM accounts
      WHERE is_healthy = 1 AND expires_at > ? AND COALESCE(rate_limit_reset, 0) < ?
        AND COALESCE(overage_count, 0) = 0 AND COALESCE(access_token, '') != ''
        AND COALESCE(profile_arn, '') != '' AND auth_method IN ('desktop', 'idc')
        AND (COALESCE(limit_count, 0) = 0 OR COALESCE(used_count, 0) < limit_count)
        AND NOT EXISTS (SELECT 1 FROM removed_accounts WHERE removed_accounts.id = accounts.id)
      ORDER BY used_count ASC, expires_at DESC LIMIT 1
    `)
      .get(now + 15 * 60_000, now);
  } finally {
    database.close(false);
  }
  requireCondition(row, "no_fresh_eligible_account");
  const region = RegionSchema.parse(row.region);
  const auth: KiroAuthDetails = {
    access: row.access_token,
    refresh: "isolated-probe-refresh-disabled",
    expires: row.expires_at,
    region,
    profileArn: row.profile_arn,
    authMethod: row.auth_method === "idc" ? "idc" : "desktop",
  };
  const client = createSdkClient(
    auth,
    region,
    "max",
    `https://runtime.${region}.kiro.dev`,
    process.env.https_proxy ?? process.env.HTTPS_PROXY,
    undefined,
    false,
    "kiro-runtime",
  );
  const prompts = [
    process.argv.includes("--long")
      ? "Synthetic optimization: durations A=7 B=5 C=9 D=4 E=8 F=6 G=3 H=5 I=4 J=7 K=6 L=2. D follows A; E follows A,B; F follows B,C; G follows D; H follows D,E; I follows E,F; J follows G,H; K follows H,I; L follows J,K. Three workers, no preemption. Find the minimum makespan and a compact optimal schedule."
      : "Synthetic scheduling: durations A=3 B=5 C=2 D=4 E=1. B,C follow A; D follows B,C; E follows D. Two workers, no preemption. Compute the minimum makespan and return only the number.",
    "For a new independent synthetic schedule: A=3 B=5 C=8 F=3 D=4 E=1. B,C,F follow A; D follows B,C,F; E follows D. Two workers, no preemption. Compute the minimum makespan and return only the number.",
    "In the latest schedule, use three workers and add G=6 following B, with E also following G. Compute the minimum makespan and return only the number.",
  ];
  const history: ChatMessage[] = [];
  const historicalSignatures = new Set<string>();
  const conversationId = randomUUID();
  const rows: Array<Record<string, unknown>> = [];
  const report = () => {
    mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
    writeFileSync(
      output,
      `${JSON.stringify({ schema_version: 1, source_readonly: true, refresh_credentials_copied: false, state_in_memory: true, model: "claude-opus-5-5", runtime_protocol: "kiro-runtime", effort: "max", display, requested_turns: turns, generation_request_count: rows.length, rows, pass: rows.length === turns && rows.every((item) => item.ok === true) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  try {
    for (let turn = 0; turn < turns; turn++) {
      const currentMessage: ChatMessage = {
        userInputMessage: {
          content: prompts[turn] as string,
          modelId: "claude-opus-5.5",
          origin: "AI_EDITOR",
        },
      };
      const command = new GenerateAssistantResponseCommand({
        profileArn: auth.profileArn,
        conversationState: {
          chatTriggerType: "MANUAL",
          conversationId,
          currentMessage,
          ...(history.length ? { history } : {}),
        },
        additionalModelRequestFields: {
          thinking: { type: "adaptive", display },
          output_config: { effort: "max" },
        },
      });
      attachKiroRuntimeRequest(command);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error("probe_deadline")), 90_000);
      const start = performance.now();
      let text = "",
        reasoning = "",
        events = 0,
        redactedBytes = 0;
      let visible = false;
      const signatures: string[] = [];
      const observations: Array<Record<string, unknown>> = [];
      const eventCounts: Record<string, number> = {};
      try {
        const response = await client.send(command, { abortSignal: abort.signal });
        for await (const event of response.generateAssistantResponseResponse ?? []) {
          events++;
          for (const key of Object.keys(event)) eventCounts[key] = (eventCounts[key] ?? 0) + 1;
          const material = event.reasoningContentEvent;
          reasoning += material?.text ?? "";
          redactedBytes += material?.redactedContent?.byteLength ?? 0;
          text += event.assistantResponseEvent?.content ?? "";
          if (material?.signature) {
            const signature = material.signature;
            const previous = signatures.at(-1);
            observations.push({
              raw_event_index: events,
              signature_bytes: Buffer.byteLength(signature),
              reasoning_chars: reasoning.length,
              event_reasoning_chars: material.text?.length ?? 0,
              matches_history: historicalSignatures.has(signature),
              signature_relation:
                previous === undefined
                  ? "first"
                  : previous === signature
                    ? "duplicate"
                    : signature.startsWith(previous)
                      ? "extends"
                      : previous.startsWith(signature)
                        ? "shorter-prefix"
                        : "distinct",
              phase: visible ? "after-assistant" : "before-assistant",
            });
            signatures.push(signature);
          }
          visible ||=
            Boolean(event.assistantResponseEvent?.content) || event.toolUseEvent !== undefined;
          if (
            events > 8192 ||
            Buffer.byteLength(reasoning) + Buffer.byteLength(text) > 1 << 20 ||
            signatures.length > 16
          ) {
            abort.abort(new Error("probe_budget"));
            break;
          }
        }
        const distinct = [...new Set(signatures)];
        const ok =
          response.$metadata.httpStatusCode === 200 &&
          !abort.signal.aborted &&
          text.length > 0 &&
          redactedBytes === 0 &&
          distinct.length === 1;
        rows.push({
          turn: turn + 1,
          history_message_count: history.length,
          status: response.$metadata.httpStatusCode,
          duration_ms: Math.round(performance.now() - start),
          reasoning_chars: reasoning.length,
          visible_chars: text.length,
          redacted_bytes: redactedBytes,
          event_counts: eventCounts,
          signature_event_count: signatures.length,
          distinct_signature_count: distinct.length,
          signature_observations: observations,
          clean_eof: !abort.signal.aborted,
          ok,
        });
        report();
        if (!ok) break;
        const signature = distinct[0] as string;
        historicalSignatures.add(signature);
        history.push(currentMessage, {
          assistantResponseMessage: {
            content: text,
            reasoningContent: { reasoningText: { text: reasoning, signature } },
          },
        });
      } catch (error) {
        const status =
          error !== null && typeof error === "object" && "$metadata" in error
            ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
            : undefined;
        rows.push({
          turn: turn + 1,
          status: status ?? null,
          duration_ms: Math.round(performance.now() - start),
          reasoning_chars: reasoning.length,
          signature_observations: observations,
          ok: false,
        });
        report();
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    requireCondition(
      rows.length === turns && rows.every((item) => item.ok === true),
      "signature_probe_incomplete",
    );
    process.stdout.write(
      `${JSON.stringify({ event: "signature_probe_completed", display, generation_request_count: rows.length, pass: true })}\n`,
    );
  } finally {
    clearSdkClientCache();
  }
}
void main().catch((error: unknown) => {
  const codes = new Set([
    "confirmation_required",
    "external_output_required",
    "invalid_display",
    "invalid_turn_count",
    "no_fresh_eligible_account",
    "signature_probe_incomplete",
  ]);
  process.stderr.write(
    `${JSON.stringify({ pass: false, code: error instanceof Error && codes.has(error.message) ? error.message : "signature_probe_failed" })}\n`,
  );
  process.exitCode = 1;
});
