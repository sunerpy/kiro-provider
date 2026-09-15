/** Controlled Kiro server-auto versus explicit cachePoint A/B probe. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { createSdkClient } from "../src/core/sdk-client.js";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { KIRO_CONSTANTS } from "../src/kiro/constants.js";
import { buildEffortRequestFields } from "../src/kiro/effort.js";
import type { Effort, KiroAuthDetails } from "../src/kiro/types.js";

type State = NonNullable<GenerateAssistantResponseCommandInput["conversationState"]>;
type Message = NonNullable<State["history"]>[number];
type User = NonNullable<NonNullable<State["currentMessage"]>["userInputMessage"]>;

type Arm = "server-auto" | "explicit-checkpoints";
interface Result {
  readonly arm: Arm;
  readonly trial: number;
  readonly firstCredits?: number;
  readonly secondCredits?: number;
  readonly firstCacheRead?: number;
  readonly firstCacheWrite?: number;
  readonly secondCacheRead?: number;
  readonly secondCacheWrite?: number;
  readonly firstMs: number;
  readonly secondMs: number;
  readonly passed: boolean;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function loadAccount(): { id: string; auth: KiroAuthDetails } {
  const path = arg(
    "--accounts-db",
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kiro-provider", "accounts.db"),
  );
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const now = Date.now();
    const row = db
      .query<Record<string, unknown>, [number, number]>(`
        SELECT * FROM accounts WHERE is_healthy = 1 AND expires_at > ?
          AND rate_limit_reset <= ? AND (limit_count = 0 OR used_count < limit_count)
        ORDER BY used_count ASC, expires_at DESC LIMIT 1
      `)
      .get(now + 30 * 60_000, now);
    if (!row) throw new Error("no healthy account with a long-lived access token");
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
        ...(row.profile_arn ? { profileArn: String(row.profile_arn) } : {}),
      },
    };
  } finally {
    db.close(false);
  }
}

async function send(
  account: ReturnType<typeof loadAccount>,
  state: State,
  model: string,
  effort: Effort,
) {
  const started = performance.now();
  const output = await createSdkClient(
    account.auth,
    account.auth.region,
    undefined,
    KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region),
    undefined,
    account.id,
    false,
    "kiro-runtime",
  ).send(
    new GenerateAssistantResponseCommand({
      conversationState: state,
      ...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
      additionalModelRequestFields: buildEffortRequestFields(model, effort),
    } as GenerateAssistantResponseCommandInput),
  );
  let text = "";
  let credits: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  for await (const event of output.generateAssistantResponseResponse ?? []) {
    text += event.assistantResponseEvent?.content ?? "";
    if (typeof event.meteringEvent?.usage === "number") credits = event.meteringEvent.usage;
    if (typeof event.metadataEvent?.tokenUsage?.cacheReadInputTokens === "number")
      cacheRead = event.metadataEvent.tokenUsage.cacheReadInputTokens;
    if (typeof event.metadataEvent?.tokenUsage?.cacheWriteInputTokens === "number")
      cacheWrite = event.metadataEvent.tokenUsage.cacheWriteInputTokens;
  }
  return { text, credits, cacheRead, cacheWrite, ms: Math.round(performance.now() - started) };
}

function user(content: string, model: string, cache: boolean): User {
  return {
    content,
    modelId: model,
    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR as User["origin"],
    ...(cache ? { cachePoint: { type: "default" } } : {}),
  };
}

async function trial(
  account: ReturnType<typeof loadAccount>,
  arm: Arm,
  index: number,
  model: string,
  effort: Effort,
): Promise<Result> {
  const cache = arm === "explicit-checkpoints";
  const conversationId = randomUUID();
  const marker = `CACHE_${randomUUID().slice(0, 8)}`;
  const prefix =
    `Stable policy ${marker}: preserve exact bytes and answer the final request.\n`.repeat(
      Number(arg("--prefix-lines", "1200")),
    );
  const firstContent = `${prefix}\nReply only FIRST.`;
  const first = await send(
    account,
    {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL as State["chatTriggerType"],
      conversationId,
      currentMessage: { userInputMessage: user(firstContent, model, cache) },
    },
    model,
    effort,
  );
  const history: Message[] = [
    { userInputMessage: user(firstContent, model, cache) },
    {
      assistantResponseMessage: {
        content: first.text,
        ...(cache ? { cachePoint: { type: "default" } } : {}),
      },
    },
  ];
  const second = await send(
    account,
    {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL as State["chatTriggerType"],
      conversationId,
      history,
      currentMessage: { userInputMessage: user("Reply only SECOND.", model, false) },
    },
    model,
    effort,
  );
  return {
    arm,
    trial: index,
    firstCredits: first.credits,
    secondCredits: second.credits,
    firstCacheRead: first.cacheRead,
    firstCacheWrite: first.cacheWrite,
    secondCacheRead: second.cacheRead,
    secondCacheWrite: second.cacheWrite,
    firstMs: first.ms,
    secondMs: second.ms,
    passed: first.text.includes("FIRST") && second.text.includes("SECOND"),
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) throw new Error("live inference requires --confirm");
  const account = loadAccount();
  const model = arg("--model", "gpt-5.6-sol");
  const effort = arg("--effort", "max") as Effort;
  const count = Number(arg("--n", "3"));
  const results: Result[] = [];
  for (let index = 1; index <= count; index += 1) {
    for (const arm of index % 2 === 0
      ? (["explicit-checkpoints", "server-auto"] as const)
      : (["server-auto", "explicit-checkpoints"] as const)) {
      results.push(await trial(account, arm, index, model, effort));
    }
  }
  process.stdout.write(
    `${JSON.stringify({ schema_version: 1, model, effort, results }, null, 2)}\n`,
  );
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

if (import.meta.main) await main();
