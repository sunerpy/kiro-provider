/**
 * Live A/B probes for the two items recorded in docs/audits/pending-probes.zh.md.
 *
 *   p1 — does replaying Kiro's signature-only reasoning envelope
 *        (`reasoningContentEvent{text:"", signature}`) on tool-result turns improve
 *        continuity of a serial multi-tool task? Arms: `replay` vs `omit`.
 *   p2 — does keeping the instruction block as its own user history turn (the shape
 *        the legacy-user-prefix projection emits when a request has no user turn)
 *        raise the turn-2 premature-stop rate versus gluing it into the first user
 *        message? Arms: `glued` vs `split`. Single structural variable; identical text.
 *
 * Usage (from the repository root; every trial is a real Kiro request):
 *   bun run scripts/probe-ab.ts p1 --n 30 --concurrency 4 --confirm [--effort high] [--model claude-sonnet-5]
 *   bun run scripts/probe-ab.ts p2 --n 120 --concurrency 6 --confirm [--effort high] [--model claude-opus-5]
 *   bun run scripts/probe-ab.ts p2 --dry            # print the wire shapes, send nothing
 *
 * Accounts: ~/.config/kiro-provider/accounts.db is opened READ-ONLY; the K least-used
 * healthy accounts whose access token is valid for at least 30 more minutes are used
 * round-robin. The probe never writes to the database, never refreshes tokens, and
 * never prints prompts, credentials, or raw signatures (signatures are SHA-256/16).
 * Throttled (429) or 5xx attempts are retried once on another account; persistent
 * failures are recorded as `error` and excluded from rate denominators, exactly as the
 * plugin's premature-stop methodology does.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
  type ToolUse,
} from "@aws/codewhisperer-streaming-client";
import { createSdkClient } from "../src/core/sdk-client.js";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { KIRO_CONSTANTS } from "../src/kiro/constants.js";
import { resolveModelVariant } from "../src/kiro/models.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

type ConversationState = NonNullable<GenerateAssistantResponseCommandInput["conversationState"]>;
type HistoryEntry = NonNullable<ConversationState["history"]>[number];
type UserInput = NonNullable<NonNullable<ConversationState["currentMessage"]>["userInputMessage"]>;
type ToolSpec = NonNullable<NonNullable<UserInput["userInputMessageContext"]>["tools"]>[number];
type ToolResult = NonNullable<
  NonNullable<UserInput["userInputMessageContext"]>["toolResults"]
>[number];

interface Account {
  readonly id: string;
  readonly auth: KiroAuthDetails;
  cooldownUntil: number;
}

interface TurnResult {
  readonly httpStatus?: number;
  readonly ok: boolean;
  readonly text: string;
  readonly toolUses: Array<{ toolUseId: string; name: string; input: string }>;
  readonly reasoning: { text: string; signature?: string; redacted?: Uint8Array };
  readonly reasoningFrames: number;
  readonly error?: { name: string; message: string; status?: number };
  readonly durationMs: number;
  readonly accountHash: string;
}

interface Options {
  readonly probe: "p1" | "p2";
  readonly n: number;
  readonly concurrency: number;
  readonly model: string;
  readonly effort: string;
  readonly out: string;
  readonly confirm: boolean;
  readonly dry: boolean;
  readonly accounts: number;
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  const value = process.argv[index + 1];
  return index === -1 || value === undefined ? fallback : value;
}

function parseOptions(): Options {
  const probe = process.argv[2];
  if (probe !== "p1" && probe !== "p2") {
    throw new Error(
      "usage: bun run scripts/probe-ab.ts <p1|p2> [--n N] [--concurrency C] [--model M] [--effort E] [--confirm] [--dry]",
    );
  }
  const defaults =
    probe === "p1"
      ? { n: 30, model: "claude-sonnet-5", effort: "" }
      : { n: 120, model: "claude-opus-5", effort: "high" };
  return {
    probe,
    n: Number(arg("--n", String(defaults.n))),
    concurrency: Number(arg("--concurrency", probe === "p1" ? "4" : "6")),
    model: arg("--model", defaults.model),
    effort: arg("--effort", defaults.effort),
    out: arg("--out", `/tmp/kiro-ab-${probe}-${Date.now()}`),
    confirm: process.argv.includes("--confirm"),
    dry: process.argv.includes("--dry"),
    accounts: Number(arg("--accounts", "8")),
  };
}

// ---------------------------------------------------------------------------
// Accounts (read-only)
// ---------------------------------------------------------------------------

function loadAccounts(limit: number): Account[] {
  const path = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "kiro-provider",
    "accounts.db",
  );
  const db = new Database(path, { readonly: true });
  try {
    const now = Date.now();
    const rows = db
      .query(
        `SELECT id, email, auth_method, region, oidc_region, client_id, client_secret, profile_arn,
                refresh_token, access_token, expires_at, rate_limit_reset, used_count, overage_count
           FROM accounts
          WHERE is_healthy = 1 AND expires_at > ? AND COALESCE(rate_limit_reset, 0) < ?
            AND COALESCE(overage_count, 0) = 0
          ORDER BY used_count ASC, expires_at DESC
          LIMIT ?`,
      )
      .all(now + 30 * 60 * 1000, now, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const authMethod = row.auth_method === "idc" ? "idc" : "desktop";
      return {
        id: String(row.id),
        cooldownUntil: 0,
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
          ...(row.client_id ? { clientId: String(row.client_id) } : {}),
          ...(row.client_secret ? { clientSecret: String(row.client_secret) } : {}),
        },
      };
    });
  } finally {
    db.close();
  }
}

class AccountPool {
  private cursor = 0;
  constructor(private readonly accounts: Account[]) {
    if (accounts.length === 0) throw new Error("no usable accounts");
  }
  next(exclude?: string): Account {
    const now = Date.now();
    for (let i = 0; i < this.accounts.length * 2; i += 1) {
      const candidate = this.accounts[this.cursor % this.accounts.length];
      this.cursor += 1;
      if (!candidate) continue;
      if (candidate.id === exclude || candidate.cooldownUntil > now) continue;
      return candidate;
    }
    // Everything cooling down: fall back to the least-recently cooled account.
    const sorted = [...this.accounts].sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    const first = sorted[0];
    if (!first) throw new Error("no accounts");
    return first;
  }
  cool(account: Account, ms: number): void {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
  }
  size(): number {
    return this.accounts.length;
  }
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function userInput(modelId: string, content: string, extra: Partial<UserInput> = {}): UserInput {
  return {
    content,
    modelId,
    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR as UserInput["origin"],
    ...extra,
  };
}

function conversation(current: UserInput, history: HistoryEntry[]): ConversationState {
  return {
    chatTriggerType:
      KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL as ConversationState["chatTriggerType"],
    conversationId: crypto.randomUUID(),
    agentContinuationId: crypto.randomUUID(),
    agentTaskType: "vibe",
    currentMessage: { userInputMessage: current },
    ...(history.length > 0 ? { history } : {}),
  };
}

async function sendTurn(
  account: Account,
  state: ConversationState,
  effort: string,
): Promise<TurnResult> {
  const region = account.auth.region;
  const endpoint = KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", region);
  const client = createSdkClient(
    account.auth,
    region,
    undefined,
    endpoint,
    undefined,
    account.id,
    false,
  );
  const input: GenerateAssistantResponseCommandInput = {
    conversationState: state,
    ...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
    ...(effort ? { additionalModelRequestFields: { output_config: { effort } } } : {}),
  };
  const started = Date.now();
  const toolUses = new Map<string, { toolUseId: string; name: string; input: string }>();
  let text = "";
  let reasoningText = "";
  let signature: string | undefined;
  let redacted: Uint8Array | undefined;
  let reasoningFrames = 0;
  try {
    const output = await client.send(new GenerateAssistantResponseCommand(input));
    for await (const event of output.generateAssistantResponseResponse ?? []) {
      const record = event as unknown as Record<string, unknown>;
      if (record.assistantResponseEvent) {
        text += (record.assistantResponseEvent as { content?: string }).content ?? "";
      } else if (record.toolUseEvent) {
        const tool = record.toolUseEvent as {
          toolUseId?: string;
          name?: string;
          input?: string;
          stop?: boolean;
        };
        const id = tool.toolUseId ?? "?";
        const entry = toolUses.get(id) ?? { toolUseId: id, name: tool.name ?? "", input: "" };
        if (tool.name) entry.name = tool.name;
        if (tool.input !== undefined) entry.input += tool.input;
        toolUses.set(id, entry);
      } else if (record.reasoningContentEvent) {
        const reasoning = record.reasoningContentEvent as {
          text?: string;
          signature?: string;
          redactedContent?: Uint8Array;
        };
        reasoningFrames += 1;
        if (reasoning.text) reasoningText += reasoning.text;
        if (reasoning.signature) signature = (signature ?? "") + reasoning.signature;
        if (reasoning.redactedContent) redacted = reasoning.redactedContent;
      } else if (record.error !== undefined || record.invalidStateEvent !== undefined) {
        throw Object.assign(new Error("embedded stream error"), { name: "EmbeddedStreamError" });
      }
    }
    return {
      httpStatus: output.$metadata.httpStatusCode,
      ok: true,
      text,
      toolUses: [...toolUses.values()],
      reasoning: {
        text: reasoningText,
        ...(signature ? { signature } : {}),
        ...(redacted ? { redacted } : {}),
      },
      reasoningFrames,
      durationMs: Date.now() - started,
      accountHash: hash16(account.id),
    };
  } catch (error) {
    const err = error as Error & { $metadata?: { httpStatusCode?: number } };
    return {
      httpStatus: err.$metadata?.httpStatusCode,
      ok: false,
      text,
      toolUses: [...toolUses.values()],
      reasoning: { text: reasoningText },
      reasoningFrames,
      error: {
        name: err.name,
        message: String(err.message).slice(0, 200),
        status: err.$metadata?.httpStatusCode,
      },
      durationMs: Date.now() - started,
      accountHash: hash16(account.id),
    };
  }
}

/** One turn with a single retry on another account for throttling / 5xx / transport failures. */
async function sendWithRetry(
  pool: AccountPool,
  state: ConversationState,
  effort: string,
): Promise<TurnResult> {
  const first = pool.next();
  const result = await sendTurn(first, state, effort);
  if (result.ok) return result;
  const status = result.error?.status;
  const retryable =
    status === 429 || (status !== undefined && status >= 500) || status === undefined;
  if (!retryable) return result;
  pool.cool(first, status === 429 ? 60_000 : 15_000);
  await Bun.sleep(1_000 + Math.random() * 1_000);
  const second = pool.next(first.id);
  return sendTurn(second, state, effort);
}

// ---------------------------------------------------------------------------
// Shared fixture: a chained ledger read through one tool
// ---------------------------------------------------------------------------

type LedgerOp = "seed" | "add" | "multiply" | "subtract";
interface LedgerEntry {
  readonly value: number;
  readonly op: LedgerOp;
  readonly next: string | null;
}

/** Deterministic chain: every intermediate total stays a small positive integer. */
function buildLedger(hops: number): { ledger: Record<string, LedgerEntry>; total: number } {
  const pattern: Array<{ op: LedgerOp; value: number }> = [
    { op: "multiply", value: 6 },
    { op: "add", value: 5 },
    { op: "subtract", value: 11 },
    { op: "multiply", value: 2 },
    { op: "add", value: 9 },
    { op: "subtract", value: 20 },
    { op: "multiply", value: 3 },
    { op: "add", value: 14 },
    { op: "subtract", value: 7 },
  ];
  const ledger: Record<string, LedgerEntry> = {};
  const name = (index: number) => `ledger-${String(index).padStart(2, "0")}`;
  let total = 7;
  ledger[name(1)] = { value: 7, op: "seed", next: hops > 1 ? name(2) : null };
  for (let hop = 2; hop <= hops; hop += 1) {
    const step = pattern[(hop - 2) % pattern.length] ?? { op: "add", value: 1 };
    total =
      step.op === "add"
        ? total + step.value
        : step.op === "multiply"
          ? total * step.value
          : total - step.value;
    ledger[name(hop)] = { value: step.value, op: step.op, next: hop < hops ? name(hop + 1) : null };
  }
  return { ledger, total };
}

const HOPS = Number(arg("--hops", "4"));
const { ledger: LEDGER, total: EXPECTED_TOTAL } = buildLedger(HOPS);
const CHAIN_LENGTH = HOPS;

const READ_LEDGER_TOOL: ToolSpec = {
  toolSpecification: {
    name: "read_ledger",
    description: "Reads one ledger entry by name and returns its JSON content.",
    inputSchema: {
      json: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
};

const PREAMBLE = [
  "You are auditing a chained ledger. Rules, follow them exactly:",
  "1. Read EXACTLY ONE ledger entry per assistant turn with the read_ledger tool. Never read two in one turn, never guess contents.",
  '2. Each entry is JSON {"value": <int>, "op": "<op>", "next": "<name or null>"}.',
  "3. Maintain a running total: seed -> total becomes value; add -> total + value; multiply -> total * value; subtract -> total - value.",
  "4. After each read, restate the whole fold from the first hop (hop N: name -> op value -> total).",
  process.env.PROBE_AB_RULE5 ??
    "5. Then read `next` on your NEXT turn. When next is null the chain is over.",
  "Your final message MUST end with exactly this line and nothing after it: FINAL_TOTAL=<integer>",
].join("\n");
const TASK = "Start at ledger-01 and audit the whole chain.";

function ledgerResult(toolUseId: string, name: string): ToolResult {
  const entry = LEDGER[name];
  const text = entry
    ? JSON.stringify({ value: entry.value, op: entry.op, next: entry.next })
    : JSON.stringify({ error: `no ledger entry named ${name}` });
  return { toolUseId, content: [{ text }], status: entry ? "success" : "error" };
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function announcesNextStep(text: string): boolean {
  return (
    /\b(next|then|now|i will|i'll|let me|reading|read)\b[^\n]*ledger-0[1-9]/i.test(text) ||
    /\bNext:/i.test(text)
  );
}

// ---------------------------------------------------------------------------
// p1 — signature-only reasoning replay across a stateless tool loop
// ---------------------------------------------------------------------------

type P1Arm = "replay" | "omit";

interface P1Trial {
  readonly arm: P1Arm;
  readonly index: number;
  readonly outcome:
    | "completed_correct"
    | "completed_wrong"
    | "stopped_early"
    | "no_progress"
    | "error";
  readonly turns: number;
  readonly toolCalls: number;
  readonly duplicateToolCalls: number;
  readonly announcedThenStopped: number;
  readonly signatureOnlyTurns: number;
  readonly signedTextTurns: number;
  readonly unsignedTurns: number;
  readonly finalTextChars: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly accounts: string[];
}

async function runP1Trial(
  pool: AccountPool,
  arm: P1Arm,
  index: number,
  options: Options,
): Promise<P1Trial> {
  const wire = resolveModelVariant(options.model).wireId;
  const started = Date.now();
  const history: HistoryEntry[] = [];
  let current = userInput(wire, `${PREAMBLE}\n\n${TASK}`, {
    userInputMessageContext: { tools: [READ_LEDGER_TOOL] },
  });
  const seen = new Set<string>();
  const accounts: string[] = [];
  let toolCalls = 0;
  let duplicates = 0;
  let signatureOnly = 0;
  let signedText = 0;
  let unsigned = 0;
  let announcedThenStopped = 0;
  let readCount = 0;
  let finalText = "";
  for (let turn = 1; turn <= CHAIN_LENGTH + 3; turn += 1) {
    const result = await sendWithRetry(pool, conversation(current, history), options.effort);
    accounts.push(result.accountHash);
    if (!result.ok) {
      return {
        arm,
        index,
        outcome: "error",
        turns: turn,
        toolCalls,
        duplicateToolCalls: duplicates,
        announcedThenStopped,
        signatureOnlyTurns: signatureOnly,
        signedTextTurns: signedText,
        unsignedTurns: unsigned,
        finalTextChars: 0,
        durationMs: Date.now() - started,
        error: `${result.error?.name}: ${result.error?.message}`,
        accounts,
      };
    }
    if (result.reasoning.signature) {
      if (result.reasoning.text.length === 0) signatureOnly += 1;
      else signedText += 1;
    } else {
      unsigned += 1;
    }
    const calls = result.toolUses.filter((call) => call.name === "read_ledger");
    if (calls.length === 0) {
      finalText = result.text;
      const done = readCount >= CHAIN_LENGTH;
      if (done) {
        const match = /FINAL_TOTAL=(-?\d+)/.exec(result.text);
        return {
          arm,
          index,
          outcome:
            match && Number(match[1]) === EXPECTED_TOTAL ? "completed_correct" : "completed_wrong",
          turns: turn,
          toolCalls,
          duplicateToolCalls: duplicates,
          announcedThenStopped,
          signatureOnlyTurns: signatureOnly,
          signedTextTurns: signedText,
          unsignedTurns: unsigned,
          finalTextChars: result.text.length,
          durationMs: Date.now() - started,
          accounts,
        };
      }
      if (announcesNextStep(result.text)) announcedThenStopped += 1;
      return {
        arm,
        index,
        outcome:
          result.text.length === 0 && result.reasoningFrames === 0
            ? "no_progress"
            : "stopped_early",
        turns: turn,
        toolCalls,
        duplicateToolCalls: duplicates,
        announcedThenStopped,
        signatureOnlyTurns: signatureOnly,
        signedTextTurns: signedText,
        unsignedTurns: unsigned,
        finalTextChars: result.text.length,
        durationMs: Date.now() - started,
        accounts,
      };
    }
    // Execute the tool calls (the fixture is deterministic) and build the next turn.
    const toolUses: ToolUse[] = [];
    const results: ToolResult[] = [];
    for (const call of calls) {
      toolCalls += 1;
      const input = parseToolInput(call.input);
      const name = String(input.name ?? "");
      const key = `${call.name}:${name}`;
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
      if (LEDGER[name]) readCount = Math.max(readCount, Number(name.slice(-2)));
      toolUses.push({
        toolUseId: call.toolUseId,
        name: call.name,
        input: input as ToolUse["input"],
      });
      results.push(ledgerResult(call.toolUseId, name));
    }
    const assistant: NonNullable<HistoryEntry["assistantResponseMessage"]> = {
      content: result.text,
      toolUses,
    };
    if (arm === "replay" && (result.reasoning.signature || result.reasoning.redacted)) {
      assistant.reasoningContent = result.reasoning.redacted
        ? { redactedContent: result.reasoning.redacted }
        : { reasoningText: { text: result.reasoning.text, signature: result.reasoning.signature } };
    }
    history.push({ userInputMessage: { ...current } });
    history.push({ assistantResponseMessage: assistant });
    current = userInput(wire, "", {
      userInputMessageContext: { tools: [READ_LEDGER_TOOL], toolResults: results },
    });
  }
  return {
    arm,
    index,
    outcome: "stopped_early",
    turns: CHAIN_LENGTH + 3,
    toolCalls,
    duplicateToolCalls: duplicates,
    announcedThenStopped,
    signatureOnlyTurns: signatureOnly,
    signedTextTurns: signedText,
    unsignedTurns: unsigned,
    finalTextChars: finalText.length,
    durationMs: Date.now() - started,
    error: "turn budget exhausted",
    accounts,
  };
}

// ---------------------------------------------------------------------------
// p2 — instruction block glued into the first user turn vs its own history turn
// ---------------------------------------------------------------------------

type P2Arm = "glued" | "split";

interface P2Trial {
  readonly arm: P2Arm;
  readonly index: number;
  readonly outcome: "continued" | "stopped" | "empty200" | "error";
  readonly textChars: number;
  readonly reasoningFrames: number;
  readonly announcedNext: boolean;
  readonly durationMs: number;
  readonly error?: string;
  readonly account: string;
}

const P2_FIRST_TOOL_USE_ID = "tooluse_probe_ab_ledger01";
const P2_ASSISTANT_TEXT = "I'll start by reading ledger-01.";

function p2State(arm: P2Arm, wire: string): ConversationState {
  const instructionTurns: HistoryEntry[] =
    arm === "glued"
      ? [{ userInputMessage: userInput(wire, `${PREAMBLE}\n\n${TASK}`) }]
      : [
          { userInputMessage: userInput(wire, PREAMBLE) },
          { userInputMessage: userInput(wire, TASK) },
        ];
  const history: HistoryEntry[] = [
    ...instructionTurns,
    {
      assistantResponseMessage: {
        content: P2_ASSISTANT_TEXT,
        toolUses: [
          { toolUseId: P2_FIRST_TOOL_USE_ID, name: "read_ledger", input: { name: "ledger-01" } },
        ],
      },
    },
  ];
  const current = userInput(wire, "", {
    userInputMessageContext: {
      tools: [READ_LEDGER_TOOL],
      toolResults: [ledgerResult(P2_FIRST_TOOL_USE_ID, "ledger-01")],
    },
  });
  return conversation(current, history);
}

async function runP2Trial(
  pool: AccountPool,
  arm: P2Arm,
  index: number,
  options: Options,
): Promise<P2Trial> {
  const wire = resolveModelVariant(options.model).wireId;
  const result = await sendWithRetry(pool, p2State(arm, wire), options.effort);
  if (!result.ok) {
    return {
      arm,
      index,
      outcome: "error",
      textChars: result.text.length,
      reasoningFrames: result.reasoningFrames,
      announcedNext: false,
      durationMs: result.durationMs,
      error: `${result.error?.name}: ${result.error?.message}`,
      account: result.accountHash,
    };
  }
  const outcome: P2Trial["outcome"] =
    result.toolUses.length > 0
      ? "continued"
      : result.text.length === 0 && result.reasoningFrames === 0
        ? "empty200"
        : "stopped";
  if (process.env.PROBE_AB_DEBUG === "1") {
    // Fixture-only content: the probe's own prompt and the model's reply to it.
    console.log(
      `[debug ${arm}#${index}] ${outcome} tools=${result.toolUses.length} reasoningFrames=${result.reasoningFrames} ${result.durationMs}ms\n${result.text.slice(0, 500)}\n---`,
    );
  }
  return {
    arm,
    index,
    outcome,
    textChars: result.text.length,
    reasoningFrames: result.reasoningFrames,
    announcedNext: outcome === "stopped" && announcesNextStep(result.text),
    durationMs: result.durationMs,
    account: result.accountHash,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function logFactorial(n: number): number {
  let total = 0;
  for (let i = 2; i <= n; i += 1) total += Math.log(i);
  return total;
}

function tableProbability(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  return Math.exp(
    logFactorial(a + b) +
      logFactorial(c + d) +
      logFactorial(a + c) +
      logFactorial(b + d) -
      logFactorial(n) -
      logFactorial(a) -
      logFactorial(b) -
      logFactorial(c) -
      logFactorial(d),
  );
}

/** Two-sided Fisher exact test: sum of all tables no more probable than the observed one. */
function fisherExact(a: number, b: number, c: number, d: number): number {
  const observed = tableProbability(a, b, c, d);
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  let p = 0;
  for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x += 1) {
    const probability = tableProbability(x, row1 - x, col1 - x, n - row1 - col1 + x);
    if (probability <= observed * (1 + 1e-9)) p += probability;
  }
  return Math.min(1, p);
}

function wilson(hits: number, total: number): string {
  if (total === 0) return "n/a";
  const z = 1.96;
  const phat = hits / total;
  const denominator = 1 + (z * z) / total;
  const center = (phat + (z * z) / (2 * total)) / denominator;
  const half =
    (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denominator;
  return `${(Math.max(0, center - half) * 100).toFixed(1)}–${(Math.min(1, center + half) * 100).toFixed(1)}%`;
}

function pct(hits: number, total: number): string {
  return total === 0 ? "n/a" : `${((hits / total) * 100).toFixed(1)}%`;
}

/** Mann–Whitney U with normal approximation (ties handled by average ranks). */
function mannWhitney(a: readonly number[], b: readonly number[]): { u: number; p: number } {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]?.v === all[i]?.v) j += 1;
    const rank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[k] = rank;
    i = j + 1;
  }
  let rankSumA = 0;
  all.forEach((item, i) => {
    if (item.g === 0) rankSumA += ranks[i] ?? 0;
  });
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { u: Number.NaN, p: 1 };
  const u = rankSumA - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  if (sd === 0) return { u, p: 1 };
  const z = Math.abs((u - mean) / sd);
  const p = 2 * (1 - normalCdf(z));
  return { u, p };
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * poly;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runPool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onDone: (t: T, i: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const task = tasks[index];
      if (!task) return;
      const result = await task();
      results[index] = result;
      onDone(result, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

function summarizeP1(trials: P1Trial[]): string {
  const arms: P1Arm[] = ["replay", "omit"];
  const lines: string[] = [
    "| arm | n | error | completed_correct | completed_wrong | stopped_early | no_progress | completion rate (errors excluded) | 95% CI | median turns | announced-then-stopped turns | duplicate calls | signature-only turns |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const counts: Record<P1Arm, { ok: number; total: number; turns: number[] }> = {
    replay: { ok: 0, total: 0, turns: [] },
    omit: { ok: 0, total: 0, turns: [] },
  };
  for (const arm of arms) {
    const rows = trials.filter((t) => t.arm === arm);
    const valid = rows.filter((t) => t.outcome !== "error");
    const by = (o: P1Trial["outcome"]) => rows.filter((t) => t.outcome === o).length;
    const turns = valid.map((t) => t.turns).sort((x, y) => x - y);
    const median = turns.length ? turns[Math.floor(turns.length / 2)] : Number.NaN;
    counts[arm] = {
      ok: by("completed_correct"),
      total: valid.length,
      turns: valid.map((t) => t.turns),
    };
    lines.push(
      `| ${arm} | ${rows.length} | ${by("error")} | ${by("completed_correct")} | ${by("completed_wrong")} | ${by("stopped_early")} | ${by("no_progress")} | ${pct(by("completed_correct"), valid.length)} | ${wilson(by("completed_correct"), valid.length)} | ${median} | ${valid.reduce((s, t) => s + t.announcedThenStopped, 0)} | ${valid.reduce((s, t) => s + t.duplicateToolCalls, 0)} | ${valid.reduce((s, t) => s + t.signatureOnlyTurns, 0)} |`,
    );
  }
  const r = counts.replay;
  const o = counts.omit;
  const fisher = fisherExact(r.ok, r.total - r.ok, o.ok, o.total - o.ok);
  const mw = mannWhitney(r.turns, o.turns);
  lines.push(
    "",
    `Fisher exact (completion, two-sided) p = ${fisher.toFixed(4)}; Mann–Whitney on turns p = ${mw.p.toFixed(4)}`,
  );
  const stoppedR = trials.filter((t) => t.arm === "replay" && t.outcome === "stopped_early").length;
  const stoppedO = trials.filter((t) => t.arm === "omit" && t.outcome === "stopped_early").length;
  lines.push(
    `Fisher exact (stopped_early, two-sided) p = ${fisherExact(stoppedR, r.total - stoppedR, stoppedO, o.total - stoppedO).toFixed(4)}`,
  );
  return lines.join("\n");
}

function summarizeP2(trials: P2Trial[]): string {
  const arms: P2Arm[] = ["glued", "split"];
  const lines: string[] = [
    "| arm | n | error | continued | stopped | empty200 | stopped rate (errors excluded) | 95% CI | announced-next among stopped |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const stopped: Record<P2Arm, [number, number]> = { glued: [0, 0], split: [0, 0] };
  for (const arm of arms) {
    const rows = trials.filter((t) => t.arm === arm);
    const valid = rows.filter((t) => t.outcome !== "error");
    const by = (o: P2Trial["outcome"]) => rows.filter((t) => t.outcome === o).length;
    stopped[arm] = [by("stopped"), valid.length];
    lines.push(
      `| ${arm} | ${rows.length} | ${by("error")} | ${by("continued")} | ${by("stopped")} | ${by("empty200")} | ${pct(by("stopped"), valid.length)} | ${wilson(by("stopped"), valid.length)} | ${rows.filter((t) => t.announcedNext).length} |`,
    );
  }
  const [gs, gn] = stopped.glued;
  const [ss, sn] = stopped.split;
  lines.push(
    "",
    `Fisher exact (stopped, two-sided) p = ${fisherExact(gs, gn - gs, ss, sn - ss).toFixed(4)}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions();
  const wire = resolveModelVariant(options.model).wireId;
  console.log(
    `probe=${options.probe} model=${options.model} wire=${wire} effort=${options.effort || "(none)"} n/arm=${options.n} concurrency=${options.concurrency}`,
  );
  if (options.dry) {
    if (options.probe === "p2") {
      for (const arm of ["glued", "split"] as const) {
        const state = p2State(arm, wire);
        console.log(
          `\n[${arm}] history roles: ${(state.history ?? []).map((h) => (h.userInputMessage ? "U" : "A")).join(",")} | current content="${state.currentMessage?.userInputMessage?.content}" toolResults=${state.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.length}`,
        );
        console.log(JSON.stringify(state.history, null, 1).slice(0, 1200));
      }
    } else {
      console.log(
        `p1 chain length ${CHAIN_LENGTH}, expected FINAL_TOTAL=${EXPECTED_TOTAL}; arms replay/omit; turn budget ${CHAIN_LENGTH + 3}`,
      );
    }
    return;
  }
  if (!options.confirm) throw new Error("live run requires --confirm (spends real Kiro quota)");
  const pool = new AccountPool(loadAccounts(options.accounts));
  console.log(`accounts in pool: ${pool.size()}`);
  mkdirSync(dirname(`${options.out}.jsonl`), { recursive: true });
  const trialsPath = `${options.out}.jsonl`;
  writeFileSync(trialsPath, "");
  let done = 0;
  const startedAt = Date.now();
  const log = (t: unknown) => {
    done += 1;
    writeFileSync(trialsPath, `${JSON.stringify(t)}\n`, { flag: "a" });
    if (done % 10 === 0 || done === options.n * 2) {
      console.log(
        `  ${done}/${options.n * 2} trials done (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    }
  };
  if (options.probe === "p1") {
    const tasks: Array<() => Promise<P1Trial>> = [];
    for (let i = 0; i < options.n; i += 1) {
      // Alternate arms so time-of-day effects fall on both equally.
      tasks.push(() => runP1Trial(pool, "replay", i, options));
      tasks.push(() => runP1Trial(pool, "omit", i, options));
    }
    const trials = await runPool(tasks, options.concurrency, log);
    const summary = summarizeP1(trials);
    console.log(`\n${summary}`);
    writeFileSync(`${options.out}.summary.md`, `${summary}\n`);
  } else {
    const tasks: Array<() => Promise<P2Trial>> = [];
    for (let i = 0; i < options.n; i += 1) {
      tasks.push(() => runP2Trial(pool, "glued", i, options));
      tasks.push(() => runP2Trial(pool, "split", i, options));
    }
    const trials = await runPool(tasks, options.concurrency, log);
    const summary = summarizeP2(trials);
    console.log(`\n${summary}`);
    writeFileSync(`${options.out}.summary.md`, `${summary}\n`);
  }
  console.log(`\ntrials: ${trialsPath}\nsummary: ${options.out}.summary.md`);
}

await main();
