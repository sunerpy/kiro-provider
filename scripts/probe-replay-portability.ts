/** Probe whether an exact signed Kiro reasoning block can cross accounts/conversations. */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import type { Effort, KiroAuthDetails } from "../src/kiro/types.js";
import type { CanonicalRequest, ResolvedReasoningReplay } from "../src/protocol/canonical.js";

type State = NonNullable<GenerateAssistantResponseCommandInput["conversationState"]>;
type Message = NonNullable<State["history"]>[number];
type UserInput = NonNullable<NonNullable<State["currentMessage"]>["userInputMessage"]>;

interface Account {
  readonly id: string;
  readonly auth: KiroAuthDetails;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function hash(value: string): string {
  return createHash("sha256")
    .update("kiro-replay-portability-probe\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function loadAccounts(limit = 6): Account[] {
  const path =
    arg("--accounts-db") ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kiro-provider", "accounts.db");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const now = Date.now();
    const rows = db
      .query<Record<string, unknown>, [number, number, number]>(`
        SELECT * FROM accounts
        WHERE is_healthy = 1 AND expires_at > ? AND rate_limit_reset <= ?
          AND (limit_count = 0 OR used_count < limit_count)
        ORDER BY used_count ASC, expires_at DESC LIMIT ?
      `)
      .all(now + 30 * 60_000, now, limit);
    return rows.map((row) => {
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
    });
  } finally {
    db.close(false);
  }
}

function client(account: Account) {
  return createSdkClient(
    account.auth,
    account.auth.region,
    undefined,
    KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region),
    undefined,
    account.id,
    false,
    "kiro-runtime",
  );
}

async function collect(account: Account, state: State, model: string, effort: Effort) {
  const response = await client(account).send(
    new GenerateAssistantResponseCommand({
      conversationState: state,
      ...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
      additionalModelRequestFields: buildEffortRequestFields(model, effort),
    } as GenerateAssistantResponseCommandInput),
  );
  let text = "";
  let reasoningText = "";
  let signature = "";
  let redacted: Uint8Array | undefined;
  const tools = new Map<string, { toolUseId: string; name: string; input: string }>();
  let metering: number | undefined;
  for await (const event of response.generateAssistantResponseResponse ?? []) {
    if (event.assistantResponseEvent?.content) text += event.assistantResponseEvent.content;
    if (event.reasoningContentEvent?.text) reasoningText += event.reasoningContentEvent.text;
    if (event.reasoningContentEvent?.signature) signature += event.reasoningContentEvent.signature;
    if (event.reasoningContentEvent?.redactedContent)
      redacted = event.reasoningContentEvent.redactedContent;
    if (event.toolUseEvent) {
      const id = event.toolUseEvent.toolUseId ?? "";
      const current = tools.get(id) ?? { toolUseId: id, name: "", input: "" };
      if (event.toolUseEvent.name) current.name = event.toolUseEvent.name;
      if (event.toolUseEvent.input) current.input += event.toolUseEvent.input;
      tools.set(id, current);
    }
    if (typeof event.meteringEvent?.usage === "number") metering = event.meteringEvent.usage;
  }
  return { text, reasoningText, signature, redacted, tools: [...tools.values()], metering };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) throw new Error("live inference requires --confirm");
  const model = arg("--model", "gpt-5.6-sol") as string;
  const effort = arg("--effort", "max") as Effort;
  const accounts = loadAccounts();
  const pair = accounts.find((left, index) =>
    accounts.slice(index + 1).some((right) => right.auth.region === left.auth.region),
  );
  if (!pair) throw new Error("no two healthy accounts in the same region");
  const firstIndex = accounts.indexOf(pair);
  const alternate = accounts
    .slice(firstIndex + 1)
    .find((item) => item.auth.region === pair.auth.region);
  if (!alternate) throw new Error("no second account in the same region");
  const second = process.argv.includes("--same-account") ? pair : alternate;
  const marker = `PORTABILITY_${randomUUID().slice(0, 8)}`;
  const tools: NonNullable<NonNullable<UserInput["userInputMessageContext"]>["tools"]> = [
    {
      toolSpecification: {
        name: "replay_probe",
        description: "Return a synthetic marker unchanged.",
        inputSchema: {
          json: {
            type: "object",
            properties: { marker: { type: "string" } },
            required: ["marker"],
          },
        },
      },
    },
  ];
  const firstUser: Message = {
    userInputMessage: {
      content: `Call replay_probe exactly once with marker ${marker}.`,
      modelId: model,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR as UserInput["origin"],
      userInputMessageContext: { tools },
    },
  };
  const firstConversationId = randomUUID();
  const first = await collect(
    pair,
    {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL as State["chatTriggerType"],
      conversationId: firstConversationId,
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
      currentMessage: firstUser,
    },
    model,
    effort,
  );
  const tool = first.tools[0];
  if (!tool || !tool.toolUseId || !tool.name)
    throw new Error("first turn returned no complete tool");
  if (!first.signature && !first.redacted)
    throw new Error("first turn returned no replayable reasoning");
  const replay: ResolvedReasoningReplay = {
    insertBeforeMessage: 1,
    content: first.redacted
      ? { kind: "redacted_content", bytes: first.redacted }
      : { kind: "reasoning_text", text: first.reasoningText, signature: first.signature },
  };
  const canonical: CanonicalRequest = {
    canonicalVersion: 1,
    protocol: "responses",
    projectionMode: "safe",
    model,
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: firstUser.userInputMessage?.content ?? "", path: "input.0" },
        ],
        toolCalls: [],
        path: "input.0",
      },
      {
        role: "assistant",
        content: first.text ? [{ type: "text", text: first.text, path: "input.1" }] : [],
        toolCalls: first.tools.map((call) => ({
          id: call.toolUseId,
          name: call.name,
          input: JSON.parse(call.input || "{}") as unknown,
          path: "input.1",
        })),
        path: "input.1",
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: tool.toolUseId,
            content: [{ type: "text", text: marker, path: "input.2" }],
            isError: false,
            path: "input.2",
          },
        ],
        toolCalls: [],
        path: "input.2",
      },
    ],
    tools: [
      {
        publicType: "function",
        name: "replay_probe",
        wireName: "replay_probe",
        description: "Return a synthetic marker unchanged.",
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
        },
        path: "tools.0",
      },
    ],
    toolChoice: "auto",
    reasoningReplays: [],
    includeEncryptedReasoning: true,
    reasoningEffort: effort,
    requestedReasoningEffort: effort,
  };
  const secondConversationId = process.argv.includes("--same-conversation")
    ? firstConversationId
    : randomUUID();
  const secondState = buildCodeWhispererRequest(canonical, model, second.auth, {
    conversationId: secondConversationId,
    resolvedReasoningReplays: [replay],
  }).request.conversationState;
  const secondTurn = await collect(second, secondState as State, model, effort);
  const passed = secondTurn.text.includes(marker) && secondTurn.tools.length === 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        model,
        effort,
        region: pair.auth.region,
        source_account_hash: hash(pair.id),
        target_account_hash: hash(second.id),
        replay_kind: first.redacted ? "redacted_content" : "reasoning_text",
        empty_reasoning_text: first.reasoningText.length === 0,
        first_tool_count: first.tools.length,
        second_tool_count: secondTurn.tools.length,
        first_metering: first.metering,
        second_metering: secondTurn.metering,
        passed,
      },
      null,
      2,
    )}\n`,
  );
  if (!passed) process.exitCode = 1;
}

if (import.meta.main) await main();
