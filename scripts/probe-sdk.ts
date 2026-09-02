/**
 * Kiro SDK architecture smoke probe. Run from the repository root.
 *
 * Source probe (three real requests):
 *   bun run scripts/probe-sdk.ts
 *
 * Compile and then execute the compiled probe once (three real requests):
 *   bun run scripts/probe-sdk.ts --compile-check
 *
 * Equivalent explicit commands:
 *   bun build --compile scripts/probe-sdk.ts --outfile /tmp/probe-bin
 *   /tmp/probe-bin
 *
 * This script reads and, only when refresh is required, updates the selected
 * account in ~/.config/opencode/kiro.db. It never prints tokens or client secrets.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
// allow: SIZE_OK — this architecture probe must remain one self-contained compilable artifact.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatMessage,
  type ChatResponseStream,
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
  type GenerateAssistantResponseCommandOutput,
  type ReasoningContent,
  type Tool,
  type ToolUse,
  type UserInputMessageContext,
} from "@aws/codewhisperer-streaming-client";
import { z } from "zod";
import { platformConfigRoot } from "../src/config/paths.js";
import { createSdkClient } from "../src/core/sdk-client.js";
import { extractRegionFromArn, isValidRegion, MODEL_MAPPING } from "../src/kiro/constants.js";
import type { Effort, KiroAuthDetails } from "../src/kiro/types.js";

const TOKEN_EXPIRY_BUFFER_MS = 120_000;
const COMPILED_PROBE_PATH = "/tmp/probe-bin";
const PROMPT = "Say hi in 3 words.";
const WEB_SEARCH_PROMPT =
  "Use web search to find the current published version of @aws/codewhisperer-streaming-client on npm. Return the version and cite the source URL.";
const OUTPUT_TOKEN_LIMIT_PROMPT =
  "Output the word alpha exactly 40 times, separated by one space. Do not abbreviate, count, explain, or stop early.";
const OUTPUT_TOKEN_LIMIT = 1024;
const OUTPUT_TOKEN_CONTROL_MINIMUM = 24;
const EFFORT = "medium";
const PROTOCOL_CONTEXT_TOKEN = "KIRO_CONTEXT_7C8A1E42";
const PROTOCOL_USER_TOKEN = "KIRO_USER_3D19B670";
const PROTOCOL_CONTROL_TOKEN = "KIRO_CONTROL_5F24A9C1";
const PROTOCOL_SEQUENCE_TOKEN = "KIRO_SEQUENCE_8B2D4E61";
const PROTOCOL_SYSTEM_TOKEN = "KIRO_SYSTEM_61F94D2B";
const PROTOCOL_DEVELOPER_TOKEN = "KIRO_DEVELOPER_A284C73E";
const PROTOCOL_MULTI_FIRST = "KIRO_MULTI_42B8";
const PROTOCOL_MULTI_SECOND = "9D31F6AC";

const AccountRowSchema = z.object({
  id: z.string().min(1),
  refresh_token: z.string().min(1),
  access_token: z.string().min(1),
  expires_at: z.number().int().positive(),
  client_id: z.string().min(1).nullable(),
  client_secret: z.string().min(1).nullable(),
  profile_arn: z.string().min(1),
  region: z.string().min(1),
  oidc_region: z.string().min(1).nullable(),
  auth_method: z.enum(["desktop", "idc"]),
});

const RefreshResponseSchema = z
  .object({
    access_token: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    expires_in: z.number().positive().optional(),
    expiresIn: z.number().positive().optional(),
  })
  .passthrough()
  .refine((value) => value.access_token !== undefined || value.accessToken !== undefined, {
    message: "refresh response has no access token",
  });

const SdkErrorSchema = z
  .object({
    name: z.string().optional(),
    message: z.string().optional(),
    $metadata: z
      .object({
        httpStatusCode: z.number().int().optional(),
      })
      .optional(),
  })
  .passthrough();

type AccountRow = z.infer<typeof AccountRowSchema>;
type AuthMethod = AccountRow["auth_method"];

type ProbeSpec = {
  readonly label: string;
  readonly modelId: string;
  readonly effort?: typeof EFFORT;
  readonly prompt?: string;
  readonly additionalModelRequestFields?: GenerateAssistantResponseCommandInput["additionalModelRequestFields"];
  readonly requestTools?: Tool[];
  readonly expectWebSearch?: boolean;
  readonly expectToolUse?: boolean;
  readonly outputTokensAtMost?: number;
  readonly outputTokensAtLeast?: number;
  readonly expectAcceptedModelFields?: boolean;
  readonly expectSchemaRejection?: boolean;
};

type ProbeResult = {
  readonly label: string;
  readonly pass: boolean;
  readonly httpStatus?: number;
  readonly content: string;
  readonly reasoningSeen: boolean;
  readonly toolUseSeen: boolean;
  readonly completionEventSeen: boolean;
  readonly eventTypes: readonly string[];
  readonly citationCount: number;
  readonly documentCitationCount: number;
  readonly supplementaryWebLinkCount: number;
  readonly webSearchEvidenceSeen: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly alphaCount: number;
  readonly cleanEof: boolean;
  readonly conclusiveFailure: boolean;
  readonly error?: string;
};

type EventSummary = {
  content: string;
  reasoningSeen: boolean;
  reasoningText: string;
  reasoningSignature?: string;
  reasoningRedactedChunks: Uint8Array[];
  toolUseSeen: boolean;
  toolUses: Map<
    string,
    {
      toolUseId: string;
      name: string;
      input: string;
      stop: boolean;
    }
  >;
  completionEventSeen: boolean;
  eventTypes: Set<string>;
  citationCount: number;
  documentCitationCount: number;
  supplementaryWebLinkCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cleanEof: boolean;
  streamError?: string;
};

type ProtocolSendResult = {
  readonly httpStatus?: number;
  readonly summary: EventSummary;
  readonly error?: string;
};

type ProbeFetchInit = RequestInit & {
  readonly proxy?: string;
};

class ProbeConfigurationError extends Error {
  readonly name = "ProbeConfigurationError";
}

class TokenRefreshError extends Error {
  readonly name = "TokenRefreshError";

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function assertNever(value: never): never {
  throw new ProbeConfigurationError(`Unsupported auth method: ${String(value)}`);
}

function databasePath(): string {
  return join(platformConfigRoot(), "opencode", "kiro.db");
}

export function resolveProbeProxy(
  env: Record<string, string | undefined>,
  argv: string[],
): string | undefined {
  const proxyFlagIndex = argv.indexOf("--proxy");
  if (proxyFlagIndex === -1) return env.KIRO_PROVIDER_PROXY_URL;
  const proxyUrl = argv[proxyFlagIndex + 1];
  if (proxyUrl === undefined || proxyUrl.startsWith("--")) {
    throw new ProbeConfigurationError("--proxy requires a value");
  }
  return proxyUrl;
}

export function buildCompileCheckArgs(proxyUrl: string | undefined): string[] {
  return proxyUrl === undefined
    ? [COMPILED_PROBE_PATH]
    : [COMPILED_PROBE_PATH, "--proxy", proxyUrl];
}

function readAccount(db: Database): AccountRow | undefined {
  const now = Date.now();
  const row = db
    .query(
      `SELECT id, refresh_token, access_token, expires_at, client_id, client_secret,
	              profile_arn, region, oidc_region, auth_method
         FROM accounts
        WHERE auth_method IN ('desktop', 'idc')
          AND refresh_token <> ''
          AND access_token <> ''
          AND profile_arn IS NOT NULL
          AND profile_arn <> ''
          AND region <> ''
	          AND COALESCE(is_healthy, 1) = 1
	          AND (auth_method = 'desktop'
	               OR (client_id IS NOT NULL AND client_id <> ''
	                   AND client_secret IS NOT NULL AND client_secret <> ''))
	        ORDER BY CASE WHEN expires_at > ? THEN 0 ELSE 1 END,
	                 CASE WHEN rate_limit_reset > ? THEN 1 ELSE 0 END,
	                 CASE
	                   WHEN limit_count > 0 THEN (1.0 * used_count / limit_count)
	                   ELSE 0
	                 END ASC,
	                 last_used ASC,
	                 expires_at DESC
	        LIMIT 1`,
    )
    .get(now + TOKEN_EXPIRY_BUFFER_MS, now);

  if (row === null) return undefined;
  return AccountRowSchema.parse(row);
}

function refreshUrl(account: AccountRow): string {
  switch (account.auth_method) {
    case "desktop":
      return `https://prod.${account.region}.auth.desktop.kiro.dev/refreshToken`;
    case "idc":
      return `https://oidc.${account.oidc_region ?? account.region}.amazonaws.com/token`;
    default:
      return assertNever(account.auth_method);
  }
}

function refreshUserAgent(authMethod: AuthMethod): string {
  switch (authMethod) {
    case "desktop":
      return "aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/macos lang/js md/nodejs/18.0.0";
    case "idc":
      return "aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE";
    default:
      return assertNever(authMethod);
  }
}

function refreshBody(account: AccountRow): Record<string, string> {
  switch (account.auth_method) {
    case "desktop":
      return { refreshToken: account.refresh_token };
    case "idc": {
      if (account.client_id === null || account.client_secret === null) {
        throw new ProbeConfigurationError("IDC account is missing client_id or client_secret");
      }
      return {
        refreshToken: account.refresh_token,
        clientId: account.client_id,
        clientSecret: account.client_secret,
        grantType: "refresh_token",
      };
    }
    default:
      return assertNever(account.auth_method);
  }
}

export function buildProbeRefreshRequestInit(
  account: AccountRow,
  proxyUrl: string | undefined,
): ProbeFetchInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "amz-sdk-request": "attempt=1; max=1",
      "x-amzn-kiro-agent-mode": "vibe",
      "user-agent": refreshUserAgent(account.auth_method),
      Connection: "close",
    },
    body: JSON.stringify(refreshBody(account)),
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  };
}

async function refreshAccessToken(
  account: AccountRow,
  proxyUrl: string | undefined,
): Promise<AccountRow> {
  const response = await fetch(
    refreshUrl(account),
    buildProbeRefreshRequestInit(account, proxyUrl),
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new TokenRefreshError(
      `Token refresh returned HTTP ${response.status}: ${responseText.slice(0, 300)}`,
      response.status,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(responseText);
  } catch (error) {
    throw new TokenRefreshError("Token refresh returned invalid JSON", response.status, {
      cause: error,
    });
  }

  const parsed = RefreshResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new TokenRefreshError(`Invalid token refresh response: ${parsed.error.message}`);
  }

  const accessToken = parsed.data.access_token ?? parsed.data.accessToken;
  if (accessToken === undefined) {
    throw new TokenRefreshError("Token refresh response has no access token");
  }

  return {
    ...account,
    access_token: accessToken,
    refresh_token: parsed.data.refresh_token ?? parsed.data.refreshToken ?? account.refresh_token,
    expires_at: Date.now() + (parsed.data.expires_in ?? parsed.data.expiresIn ?? 3600) * 1000,
  };
}

function persistRefreshedAccount(db: Database, previous: AccountRow, refreshed: AccountRow): void {
  const result = db
    .query(
      `UPDATE accounts
          SET refresh_token = ?, access_token = ?, expires_at = ?
        WHERE id = ? AND refresh_token = ?`,
    )
    .run(
      refreshed.refresh_token,
      refreshed.access_token,
      refreshed.expires_at,
      previous.id,
      previous.refresh_token,
    );

  if (result.changes !== 1) {
    throw new ProbeConfigurationError(
      "The selected account changed concurrently; refreshed credentials were not persisted",
    );
  }
}

function conversationState(modelId: string, prompt: string = PROMPT, tools?: Tool[]) {
  return {
    chatTriggerType: "MANUAL" as const,
    conversationId: crypto.randomUUID(),
    currentMessage: {
      userInputMessage: {
        content: prompt,
        modelId,
        origin: "AI_EDITOR" as const,
        ...(tools === undefined ? {} : { userInputMessageContext: { tools } }),
      },
    },
  };
}

function emptyEventSummary(): EventSummary {
  return {
    content: "",
    reasoningSeen: false,
    reasoningText: "",
    reasoningRedactedChunks: [],
    toolUseSeen: false,
    toolUses: new Map(),
    completionEventSeen: false,
    eventTypes: new Set<string>(),
    citationCount: 0,
    documentCitationCount: 0,
    supplementaryWebLinkCount: 0,
    cleanEof: false,
  };
}

async function consumeEvents(
  response: GenerateAssistantResponseCommandOutput,
): Promise<EventSummary> {
  const stream = response.generateAssistantResponseResponse;
  if (stream === undefined) {
    return {
      ...emptyEventSummary(),
      streamError: "SDK response did not contain an event stream",
    };
  }

  const summary = emptyEventSummary();

  for await (const event of stream) {
    collectEvent(summary, event);
    if (summary.streamError !== undefined) break;
  }
  summary.cleanEof = summary.streamError === undefined;
  return summary;
}

function collectEvent(summary: EventSummary, event: ChatResponseStream): void {
  for (const key of Object.keys(event)) summary.eventTypes.add(key);
  if (event.assistantResponseEvent?.content !== undefined) {
    summary.content += event.assistantResponseEvent.content;
  }
  if (event.codeEvent?.content !== undefined) {
    summary.content += event.codeEvent.content;
  }
  if (event.reasoningContentEvent !== undefined) {
    summary.reasoningSeen = true;
    if (event.reasoningContentEvent.text !== undefined) {
      summary.reasoningText += event.reasoningContentEvent.text;
    }
    if (event.reasoningContentEvent.signature !== undefined) {
      summary.reasoningSignature = event.reasoningContentEvent.signature;
    }
    if (event.reasoningContentEvent.redactedContent !== undefined) {
      summary.reasoningRedactedChunks.push(event.reasoningContentEvent.redactedContent);
    }
  }
  if (event.toolUseEvent !== undefined) {
    summary.toolUseSeen = true;
    const id = event.toolUseEvent.toolUseId ?? "__missing_tool_use_id__";
    const existing = summary.toolUses.get(id);
    summary.toolUses.set(id, {
      toolUseId: id,
      name: event.toolUseEvent.name ?? existing?.name ?? "",
      input: `${existing?.input ?? ""}${event.toolUseEvent.input ?? ""}`,
      stop: event.toolUseEvent.stop ?? existing?.stop ?? false,
    });
  }
  if (event.citationEvent !== undefined) summary.citationCount += 1;
  if (event.documentCitationEvent !== undefined) {
    summary.documentCitationCount += 1;
  }
  const tokenUsage = event.metadataEvent?.tokenUsage;
  if (tokenUsage !== undefined) {
    if (tokenUsage.uncachedInputTokens !== undefined) {
      summary.inputTokens =
        tokenUsage.uncachedInputTokens +
        (tokenUsage.cacheReadInputTokens ?? 0) +
        (tokenUsage.cacheWriteInputTokens ?? 0);
    }
    if (tokenUsage.outputTokens !== undefined) {
      summary.outputTokens = tokenUsage.outputTokens;
    }
    if (tokenUsage.totalTokens !== undefined) {
      summary.totalTokens = tokenUsage.totalTokens;
    }
  }
  summary.supplementaryWebLinkCount +=
    event.supplementaryWebLinksEvent?.supplementaryWebLinks?.length ?? 0;
  if (Object.keys(event).some((key) => key.toLowerCase().includes("completion"))) {
    summary.completionEventSeen = true;
  }
  if (event.error !== undefined) {
    summary.streamError = `stream error: ${event.error.message}`;
  } else if (event.invalidStateEvent !== undefined) {
    summary.streamError = `invalid state: ${event.invalidStateEvent.message}`;
  }
}

function protocolUserMessage(
  modelId: string,
  content: string,
  context?: UserInputMessageContext,
): ChatMessage {
  return {
    userInputMessage: {
      content,
      modelId,
      origin: "AI_EDITOR",
      ...(context === undefined ? {} : { userInputMessageContext: context }),
    },
  };
}

function protocolAssistantMessage(
  content: string,
  toolUses?: ToolUse[],
  reasoningContent?: ReasoningContent,
): ChatMessage {
  return {
    assistantResponseMessage: {
      content,
      ...(toolUses === undefined ? {} : { toolUses }),
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
    },
  };
}

function protocolConversationState(
  conversationId: string,
  currentMessage: ChatMessage,
  history: ChatMessage[] = [],
): NonNullable<GenerateAssistantResponseCommandInput["conversationState"]> {
  return {
    chatTriggerType: "MANUAL",
    conversationId,
    ...(history.length === 0 ? {} : { history }),
    currentMessage,
  };
}

async function sendProtocolRequest(
  client: ReturnType<typeof createSdkClient>,
  auth: KiroAuthDetails,
  conversationState: NonNullable<GenerateAssistantResponseCommandInput["conversationState"]>,
): Promise<ProtocolSendResult> {
  try {
    const response = await client.send(
      new GenerateAssistantResponseCommand({
        conversationState,
        profileArn: auth.profileArn,
      }),
    );
    return {
      httpStatus: response.$metadata.httpStatusCode,
      summary: await consumeEvents(response),
    };
  } catch (error) {
    const details = errorDetails(error);
    return {
      httpStatus: details.status,
      summary: emptyEventSummary(),
      error: details.message,
    };
  }
}

function isSuccessfulProtocolResult(result: ProtocolSendResult): boolean {
  return (
    result.httpStatus !== undefined &&
    result.httpStatus >= 200 &&
    result.httpStatus < 300 &&
    result.summary.cleanEof &&
    result.error === undefined
  );
}

function isRejectedProtocolResult(result: ProtocolSendResult): boolean {
  return (
    result.httpStatus === 400 ||
    result.httpStatus === 405 ||
    result.httpStatus === 415 ||
    result.httpStatus === 422
  );
}

function concatenatedBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function reasoningContentFromSummary(summary: EventSummary): ReasoningContent | undefined {
  if (summary.reasoningRedactedChunks.length > 0) {
    return { redactedContent: concatenatedBytes(summary.reasoningRedactedChunks) };
  }
  if (summary.reasoningText.length > 0 && summary.reasoningSignature !== undefined) {
    return {
      reasoningText: {
        text: summary.reasoningText,
        signature: summary.reasoningSignature,
      },
    };
  }
  return undefined;
}

function tamperReasoningContent(content: ReasoningContent): ReasoningContent {
  if (content.reasoningText !== undefined) {
    return {
      reasoningText: {
        text: content.reasoningText.text,
        signature: `${content.reasoningText.signature ?? ""}x`,
      },
    };
  }
  if (content.redactedContent !== undefined) {
    const bytes = new Uint8Array(content.redactedContent);
    const first = bytes[0];
    if (first !== undefined) bytes[0] = first ^ 1;
    return { redactedContent: bytes };
  }
  return content;
}

function capturedToolUses(summary: EventSummary): ToolUse[] {
  return [...summary.toolUses.values()]
    .filter((toolUse) => toolUse.toolUseId !== "__missing_tool_use_id__")
    .map((toolUse) => {
      let input: ToolUse["input"] = {};
      try {
        input = JSON.parse(toolUse.input || "{}") as ToolUse["input"];
      } catch {
        input = toolUse.input;
      }
      return {
        toolUseId: toolUse.toolUseId,
        name: toolUse.name,
        input,
      };
    });
}

function toolUseContainsValue(toolUse: ToolUse | undefined, value: string): boolean {
  if (toolUse === undefined) return false;
  if (typeof toolUse.input === "string") return toolUse.input.includes(value);
  if (typeof toolUse.input !== "object" || toolUse.input === null) return false;
  return (toolUse.input as Readonly<Record<string, unknown>>).value === value;
}

function shortHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function alphaWordCount(content: string): number {
  return content
    .trim()
    .split(/\s+/u)
    .filter((word) => word === "alpha").length;
}

function printProtocolRequestResult(label: string, result: ProtocolSendResult): void {
  const redactedBytes = result.summary.reasoningRedactedChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  console.log(`\n--- ${label} ---`);
  console.log(`HTTP status: ${result.httpStatus ?? "unknown"}`);
  console.log(`Content (first 200 chars): ${result.summary.content.slice(0, 200) || "(none)"}`);
  console.log(`Clean EOF: ${result.summary.cleanEof ? "yes" : "no"}`);
  console.log(`Reasoning text bytes: ${Buffer.byteLength(result.summary.reasoningText)}`);
  console.log(
    `Reasoning signature hash: ${
      result.summary.reasoningSignature === undefined
        ? "(none)"
        : shortHash(result.summary.reasoningSignature)
    }`,
  );
  console.log(`Reasoning redacted bytes: ${redactedBytes}`);
  console.log(`Tool uses: ${result.summary.toolUses.size}`);
  console.log(
    `Raw event types: ${
      result.summary.eventTypes.size > 0
        ? [...result.summary.eventTypes].sort().join(", ")
        : "(none)"
    }`,
  );
  if (result.error !== undefined) console.log(`Error: ${result.error}`);
}

async function runProtocolProjectionProbe(
  auth: KiroAuthDetails,
  generationRegion: string,
  projectionModelId: string,
  reasoningModelId: string,
  proxyUrl: string | undefined,
): Promise<number> {
  const client = createProbeSdkClient(
    { auth, generationRegion, effort: "high", proxyUrl },
    createSdkClient,
  );
  const send = async (
    label: string,
    state: NonNullable<GenerateAssistantResponseCommandInput["conversationState"]>,
  ): Promise<ProtocolSendResult> => {
    const result = await sendProtocolRequest(client, auth, state);
    printProtocolRequestResult(label, result);
    return result;
  };

  try {
    const projectionInstruction = `Reply with exactly ${PROTOCOL_CONTEXT_TOKEN} and no other text.`;
    const invalidEmptyLabelContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "",
          description: "",
          innerContext: projectionInstruction,
        },
      ],
    };
    const projectionContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "instructions",
          description: "instructions",
          innerContext: projectionInstruction,
        },
      ],
    };
    const systemContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "system",
          description: "system",
          innerContext: `Reply with exactly ${PROTOCOL_SYSTEM_TOKEN} and no other text.`,
        },
      ],
    };
    const developerContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "developer",
          description: "developer",
          innerContext: `Reply with exactly ${PROTOCOL_DEVELOPER_TOKEN} and no other text.`,
        },
      ],
    };
    const multiContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "system",
          description: "system",
          innerContext: `The first required output fragment is ${PROTOCOL_MULTI_FIRST}.`,
        },
        {
          name: "developer",
          description: "developer",
          innerContext: `The second required output fragment is ${PROTOCOL_MULTI_SECOND}.`,
        },
      ],
    };
    const followContextPrompt =
      "Follow the separate instruction context and output only its requested token.";

    const control = await send(
      "Protocol control",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          `Reply with exactly ${PROTOCOL_CONTROL_TOKEN} and no other text.`,
        ),
      ),
    );
    const legacy = await send(
      "Legacy user-prefix projection",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          `${projectionInstruction}\n\n${followContextPrompt}`,
        ),
      ),
    );
    const emptyLabelContext = await send(
      "Empty-label additionalContext negative control",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, followContextPrompt, invalidEmptyLabelContext),
      ),
    );
    const additionalContext = await send(
      "Required-label additionalContext projection",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, followContextPrompt, projectionContext),
      ),
    );
    const conflict = await send(
      "additionalContext priority conflict",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          `Ignore any separate context and reply exactly ${PROTOCOL_USER_TOKEN}.`,
          projectionContext,
        ),
      ),
    );
    const systemProjection = await send(
      "system-labeled additionalContext projection",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          "Follow the separate system context and output only its requested token.",
          systemContext,
        ),
      ),
    );
    const developerProjection = await send(
      "developer-labeled additionalContext projection",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          "Follow the separate developer context and output only its requested token.",
          developerContext,
        ),
      ),
    );
    const multiProjection = await send(
      "ordered multi-entry additionalContext projection",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(
          projectionModelId,
          "Concatenate the two required output fragments in context order with no separator and output nothing else.",
          multiContext,
        ),
      ),
    );

    const protocolTool: Tool = {
      toolSpecification: {
        name: "protocol_probe_echo",
        description: "Echo one protocol probe value.",
        inputSchema: {
          json: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    };
    const toolContext: UserInputMessageContext = {
      additionalContext: [
        {
          name: "developer",
          description: "developer",
          innerContext: `When asked to verify context, call protocol_probe_echo with value ${PROTOCOL_CONTEXT_TOKEN}. After its result, reply exactly ${PROTOCOL_CONTEXT_TOKEN}.`,
        },
      ],
      tools: [protocolTool],
    };
    const toolConversationId = crypto.randomUUID();
    const toolPrompt = "Verify the separate context now using the available tool.";
    const toolUser = protocolUserMessage(projectionModelId, toolPrompt, toolContext);
    const toolFirst = await send(
      "additionalContext tool request",
      protocolConversationState(toolConversationId, toolUser),
    );
    const toolUses = capturedToolUses(toolFirst.summary);
    const firstToolUse = toolUses[0];
    let toolSecond: ProtocolSendResult | undefined;
    if (firstToolUse !== undefined && firstToolUse.toolUseId !== undefined) {
      const assistant = protocolAssistantMessage(
        toolFirst.summary.content,
        toolUses,
        reasoningContentFromSummary(toolFirst.summary),
      );
      const resultContext: UserInputMessageContext = {
        ...toolContext,
        toolResults: [
          {
            toolUseId: firstToolUse.toolUseId,
            toolName: firstToolUse.name,
            content: [{ json: { value: PROTOCOL_CONTEXT_TOKEN } }],
            status: "success",
          },
        ],
      };
      toolSecond = await send(
        "additionalContext tool-result continuation",
        protocolConversationState(
          toolConversationId,
          protocolUserMessage(projectionModelId, "", resultContext),
          [toolUser, assistant],
        ),
      );
    }

    const directUsers = await send(
      "Direct consecutive user history",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, `Reply exactly ${PROTOCOL_SEQUENCE_TOKEN}.`),
        [
          protocolUserMessage(projectionModelId, "First user history entry."),
          protocolUserMessage(projectionModelId, "Second user history entry."),
        ],
      ),
    );
    const separatedUsers = await send(
      "Empty assistant separator for consecutive users",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, `Reply exactly ${PROTOCOL_SEQUENCE_TOKEN}.`),
        [
          protocolUserMessage(projectionModelId, "First user history entry."),
          protocolAssistantMessage(""),
          protocolUserMessage(projectionModelId, "Second user history entry."),
        ],
      ),
    );
    const directAssistants = await send(
      "Direct consecutive assistant history",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, `Reply exactly ${PROTOCOL_SEQUENCE_TOKEN}.`),
        [
          protocolUserMessage(projectionModelId, "Start assistant history test."),
          protocolAssistantMessage("First assistant history entry."),
          protocolAssistantMessage("Second assistant history entry."),
        ],
      ),
    );
    const separatedAssistants = await send(
      "Empty user separator for consecutive assistants",
      protocolConversationState(
        crypto.randomUUID(),
        protocolUserMessage(projectionModelId, `Reply exactly ${PROTOCOL_SEQUENCE_TOKEN}.`),
        [
          protocolUserMessage(projectionModelId, "Start assistant history test."),
          protocolAssistantMessage("First assistant history entry."),
          protocolUserMessage(projectionModelId, ""),
          protocolAssistantMessage("Second assistant history entry."),
        ],
      ),
    );

    const reasoningConversationId = crypto.randomUUID();
    const reasoningPrompt =
      "Compute 127 multiplied by 389. Use internal reasoning, then answer with only the integer.";
    const reasoningUser = protocolUserMessage(reasoningModelId, reasoningPrompt);
    const reasoningFirst = await send(
      "Signed reasoning capture (Claude Sonnet 5)",
      protocolConversationState(reasoningConversationId, reasoningUser),
    );
    const reasoningContent = reasoningContentFromSummary(reasoningFirst.summary);
    let reasoningReplay: ProtocolSendResult | undefined;
    let wrongConversationReplay: ProtocolSendResult | undefined;
    let tamperedReplay: ProtocolSendResult | undefined;
    if (reasoningContent !== undefined) {
      const reasoningAssistant = protocolAssistantMessage(
        reasoningFirst.summary.content,
        undefined,
        reasoningContent,
      );
      const reasoningHistory = [reasoningUser, reasoningAssistant];
      reasoningReplay = await send(
        "Signed reasoning replay in same conversation",
        protocolConversationState(
          reasoningConversationId,
          protocolUserMessage(
            reasoningModelId,
            "Add one to the prior answer. Return only the integer.",
          ),
          reasoningHistory,
        ),
      );
      wrongConversationReplay = await send(
        "Signed reasoning replay in different conversation",
        protocolConversationState(
          crypto.randomUUID(),
          protocolUserMessage(
            reasoningModelId,
            "Add one to the prior answer. Return only the integer.",
          ),
          reasoningHistory,
        ),
      );
      tamperedReplay = await send(
        "Tampered reasoning replay",
        protocolConversationState(
          reasoningConversationId,
          protocolUserMessage(
            reasoningModelId,
            "Add one to the prior answer. Return only the integer.",
          ),
          [
            reasoningUser,
            protocolAssistantMessage(
              reasoningFirst.summary.content,
              undefined,
              tamperReasoningContent(reasoningContent),
            ),
          ],
        ),
      );
    }

    const controlPass =
      isSuccessfulProtocolResult(control) &&
      control.summary.content.trim() === PROTOCOL_CONTROL_TOKEN;
    const legacyPass =
      isSuccessfulProtocolResult(legacy) &&
      legacy.summary.content.trim() === PROTOCOL_CONTEXT_TOKEN;
    const contextPass =
      isSuccessfulProtocolResult(additionalContext) &&
      additionalContext.summary.content.trim() === PROTOCOL_CONTEXT_TOKEN;
    const emptyLabelsRejected = isRejectedProtocolResult(emptyLabelContext);
    const conflictPass =
      isSuccessfulProtocolResult(conflict) &&
      conflict.summary.content.trim() === PROTOCOL_CONTEXT_TOKEN;
    const systemPass =
      isSuccessfulProtocolResult(systemProjection) &&
      systemProjection.summary.content.trim() === PROTOCOL_SYSTEM_TOKEN;
    const developerPass =
      isSuccessfulProtocolResult(developerProjection) &&
      developerProjection.summary.content.trim() === PROTOCOL_DEVELOPER_TOKEN;
    const multiPass =
      isSuccessfulProtocolResult(multiProjection) &&
      multiProjection.summary.content.trim() === `${PROTOCOL_MULTI_FIRST}${PROTOCOL_MULTI_SECOND}`;
    const toolRequestPass = toolUseContainsValue(firstToolUse, PROTOCOL_CONTEXT_TOKEN);
    const toolContinuationPass =
      toolSecond !== undefined &&
      isSuccessfulProtocolResult(toolSecond) &&
      toolSecond.summary.content.includes(PROTOCOL_CONTEXT_TOKEN);
    const directSequencePass =
      isSuccessfulProtocolResult(directUsers) && isSuccessfulProtocolResult(directAssistants);
    const emptySequencePass =
      isSuccessfulProtocolResult(separatedUsers) && isSuccessfulProtocolResult(separatedAssistants);
    const reasoningCapturePass = reasoningContent !== undefined;
    const reasoningReplayPass =
      reasoningReplay !== undefined && isSuccessfulProtocolResult(reasoningReplay);
    const wrongConversationRejected =
      wrongConversationReplay !== undefined && isRejectedProtocolResult(wrongConversationReplay);
    const tamperedRejected =
      tamperedReplay !== undefined && isRejectedProtocolResult(tamperedReplay);

    console.log("\n--- Protocol decision matrix ---");
    console.log(`Control exact token: ${controlPass ? "PASS" : "FAIL"}`);
    console.log(`Legacy prefix exact token: ${legacyPass ? "PASS" : "FAIL"}`);
    console.log(`Empty required labels rejected: ${emptyLabelsRejected ? "PASS" : "NO"}`);
    console.log(`additionalContext exact token: ${contextPass ? "PASS" : "FAIL"}`);
    console.log(`additionalContext priority: ${conflictPass ? "PASS" : "FAIL"}`);
    console.log(`system-labeled context: ${systemPass ? "PASS" : "FAIL"}`);
    console.log(`developer-labeled context: ${developerPass ? "PASS" : "FAIL"}`);
    console.log(`Ordered multi-entry context: ${multiPass ? "PASS" : "FAIL"}`);
    console.log(`additionalContext tool request: ${toolRequestPass ? "PASS" : "FAIL"}`);
    console.log(`Tool-result continuation: ${toolContinuationPass ? "PASS" : "FAIL"}`);
    console.log(`Direct same-role history: ${directSequencePass ? "PASS" : "FAIL"}`);
    console.log(`Empty structural separators: ${emptySequencePass ? "PASS" : "FAIL"}`);
    console.log(`Signed reasoning captured: ${reasoningCapturePass ? "PASS" : "FAIL"}`);
    console.log(`Signed reasoning replayed: ${reasoningReplayPass ? "PASS" : "FAIL"}`);
    console.log(
      `Different-conversation replay rejected upstream: ${
        wrongConversationRejected ? "PASS" : "NO"
      }`,
    );
    console.log(`Tampered reasoning rejected upstream: ${tamperedRejected ? "PASS" : "NO"}`);

    if (!controlPass || !legacyPass) {
      printVerdict(
        "INCONCLUSIVE",
        "The control or legacy projection did not establish a stable comparison.",
      );
      return 2;
    }
    if (
      contextPass &&
      conflictPass &&
      systemPass &&
      developerPass &&
      multiPass &&
      toolRequestPass &&
      toolContinuationPass
    ) {
      printVerdict(
        "PROTOCOL-PROJECTION-SUPPORTED",
        "Kiro preserved required-label additionalContext across role labels, ordering, priority, and tool-loop probes.",
      );
      return 0;
    }
    printVerdict(
      "PROTOCOL-PROJECTION-UNSUPPORTED",
      "Kiro accepted required-label additionalContext structurally but did not preserve instruction content or instruction-over-user priority; safe mode must reject instruction projection.",
    );
    return 1;
  } finally {
    client.destroy();
  }
}

function errorDetails(error: unknown): {
  readonly status?: number;
  readonly message: string;
} {
  const parsed = SdkErrorSchema.safeParse(error);
  if (parsed.success) {
    return {
      status: parsed.data.$metadata?.httpStatusCode,
      message: `${parsed.data.name ?? "SDK error"}: ${parsed.data.message ?? "unknown error"}`,
    };
  }
  if (error instanceof Error) return { message: `${error.name}: ${error.message}` };
  return { message: String(error) };
}

function isConclusiveSdkFailure(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status >= 200 && status < 300) return true;
  return status === 400 || status === 405 || status === 415 || status === 422;
}

type ProbeSdkClientOptions = {
  readonly auth: KiroAuthDetails;
  readonly generationRegion: string;
  readonly effort: Effort | undefined;
  readonly proxyUrl: string | undefined;
};

export function createProbeSdkClient<T>(
  options: ProbeSdkClientOptions,
  factory: (...args: Parameters<typeof createSdkClient>) => T,
): T {
  return factory(
    options.auth,
    options.generationRegion,
    options.effort,
    undefined,
    options.proxyUrl,
  );
}

async function runRequest(
  auth: KiroAuthDetails,
  generationRegion: string,
  spec: ProbeSpec,
  proxyUrl: string | undefined,
): Promise<ProbeResult> {
  const client = createProbeSdkClient(
    { auth, generationRegion, effort: spec.effort, proxyUrl },
    createSdkClient,
  );
  try {
    const response = await client.send(
      new GenerateAssistantResponseCommand({
        conversationState: conversationState(
          spec.modelId,
          spec.prompt ?? PROMPT,
          spec.requestTools,
        ),
        profileArn: auth.profileArn,
        ...(spec.additionalModelRequestFields === undefined
          ? {}
          : {
              additionalModelRequestFields: spec.additionalModelRequestFields,
            }),
      }),
    );
    const summary = await consumeEvents(response);
    const status = response.$metadata.httpStatusCode;
    const statusOk = status !== undefined && status >= 200 && status < 300;
    const webSearchEvidenceSeen =
      summary.citationCount > 0 ||
      summary.documentCitationCount > 0 ||
      summary.supplementaryWebLinkCount > 0;
    const pass =
      statusOk &&
      summary.cleanEof &&
      (spec.expectAcceptedModelFields === true
        ? summary.content.trim().length > 0
        : spec.outputTokensAtMost !== undefined
          ? (summary.outputTokens ?? alphaWordCount(summary.content)) > 0 &&
            (summary.outputTokens ?? alphaWordCount(summary.content)) <= spec.outputTokensAtMost
          : spec.outputTokensAtLeast !== undefined
            ? (summary.outputTokens ?? alphaWordCount(summary.content)) >= spec.outputTokensAtLeast
            : spec.expectWebSearch === true
              ? webSearchEvidenceSeen
              : spec.expectToolUse === true
                ? summary.toolUseSeen
                : summary.content.trim().length > 0);
    return {
      label: spec.label,
      pass,
      httpStatus: status,
      content: summary.content,
      reasoningSeen: summary.reasoningSeen,
      toolUseSeen: summary.toolUseSeen,
      completionEventSeen: summary.completionEventSeen,
      eventTypes: [...summary.eventTypes].sort(),
      citationCount: summary.citationCount,
      documentCitationCount: summary.documentCitationCount,
      supplementaryWebLinkCount: summary.supplementaryWebLinkCount,
      webSearchEvidenceSeen,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens,
      alphaCount: alphaWordCount(summary.content),
      cleanEof: summary.cleanEof,
      conclusiveFailure: !pass && isConclusiveSdkFailure(status),
      error:
        summary.streamError ??
        (spec.expectWebSearch === true && !webSearchEvidenceSeen
          ? "response contained no citation or supplementary web-link events"
          : undefined) ??
        (spec.expectToolUse === true && !summary.toolUseSeen
          ? "response contained no tool-use event"
          : undefined) ??
        (spec.expectToolUse !== true &&
        spec.outputTokensAtMost === undefined &&
        spec.outputTokensAtLeast === undefined &&
        summary.content.trim().length === 0
          ? "clean response contained no content events"
          : undefined),
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const details = errorDetails(error);
    return {
      label: spec.label,
      pass: spec.expectSchemaRejection === true && isConclusiveSdkFailure(details.status),
      httpStatus: details.status,
      content: "",
      reasoningSeen: false,
      toolUseSeen: false,
      completionEventSeen: false,
      eventTypes: [],
      citationCount: 0,
      documentCitationCount: 0,
      supplementaryWebLinkCount: 0,
      webSearchEvidenceSeen: false,
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      alphaCount: 0,
      cleanEof: false,
      conclusiveFailure: isConclusiveSdkFailure(details.status),
      error: details.message,
    };
  } finally {
    client.destroy();
  }
}

function printRequestResult(result: ProbeResult): void {
  console.log(`\n--- ${result.label} ---`);
  console.log(`HTTP status: ${result.httpStatus ?? "unknown"}`);
  console.log(`Content (first 200 chars): ${result.content.slice(0, 200) || "(none)"}`);
  console.log(`Reasoning event: ${result.reasoningSeen ? "yes" : "no"}`);
  console.log(`Tool-use event: ${result.toolUseSeen ? "yes" : "no"}`);
  console.log(`Completion event: ${result.completionEventSeen ? "yes" : "no"}`);
  console.log(
    `Raw event types: ${result.eventTypes.length > 0 ? result.eventTypes.join(", ") : "(none)"}`,
  );
  console.log(`Citation events: ${result.citationCount}`);
  console.log(`Document citation events: ${result.documentCitationCount}`);
  console.log(`Supplementary web links: ${result.supplementaryWebLinkCount}`);
  console.log(`Web-search evidence: ${result.webSearchEvidenceSeen ? "yes" : "no"}`);
  console.log(`Input tokens: ${result.inputTokens ?? "unknown"}`);
  console.log(`Output tokens: ${result.outputTokens ?? "unknown"}`);
  console.log(`Total tokens: ${result.totalTokens ?? "unknown"}`);
  console.log(`Exact alpha words: ${result.alphaCount}`);
  console.log(`Clean EOF: ${result.cleanEof ? "yes" : "no"}`);
  if (result.error !== undefined) console.log(`Error: ${result.error}`);
  console.log(`Result: ${result.pass ? "PASS" : "FAIL"}`);
}

function printVerdict(
  verdict:
    | "SDK-OK"
    | "SDK-FAIL"
    | "WEB-SEARCH-SUPPORTED"
    | "WEB-SEARCH-UNSUPPORTED"
    | "OUTPUT-TOKEN-LIMIT-SUPPORTED"
    | "OUTPUT-TOKEN-LIMIT-UNSUPPORTED"
    | "PROTOCOL-PROJECTION-SUPPORTED"
    | "PROTOCOL-PROJECTION-UNSUPPORTED"
    | "INCONCLUSIVE",
  guidance: string,
): void {
  console.log("\n================ FINAL VERDICT ================");
  console.log("RAW-N/A (SDK-locked)");
  console.log(verdict);
  console.log(guidance);
  console.log("================================================");
}

async function runLiveProbe(
  proxyUrl: string | undefined,
  webSearchMode = false,
  protocolProjectionMode = false,
  outputTokenLimitMode = false,
  protocolProjectionClaude = false,
): Promise<number> {
  const path = databasePath();
  if (!existsSync(path)) {
    printVerdict(
      "INCONCLUSIVE",
      `No Kiro database found at ${path}. Sign in through opencode-kiro-auth, then rerun.`,
    );
    return 2;
  }

  const db = new Database(path, { readwrite: true, create: false });
  try {
    const selected = readAccount(db);
    if (selected === undefined) {
      printVerdict(
        "INCONCLUSIVE",
        `No usable desktop/IDC account found in ${path}. Re-authenticate and verify profile ARN, region, and IDC client credentials.`,
      );
      return 2;
    }
    if (!isValidRegion(selected.region)) {
      printVerdict("INCONCLUSIVE", `Account has unsupported region: ${selected.region}`);
      return 2;
    }
    if (selected.oidc_region !== null && !isValidRegion(selected.oidc_region)) {
      printVerdict("INCONCLUSIVE", `Account has unsupported OIDC region: ${selected.oidc_region}`);
      return 2;
    }

    let account = selected;
    if (Date.now() >= selected.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
      console.log("Access token is expired or near expiry; refreshing it now...");
      account = await refreshAccessToken(selected, proxyUrl);
      persistRefreshedAccount(db, selected, account);
      console.log("Token refresh succeeded and the rotated credentials were persisted.");
    } else {
      console.log("Access token is still valid; refresh skipped.");
    }

    const generationRegion = extractRegionFromArn(account.profile_arn) ?? account.region;
    const auth: KiroAuthDetails = {
      refresh: account.refresh_token,
      access: account.access_token,
      expires: account.expires_at,
      authMethod: account.auth_method,
      region: selected.region,
      profileArn: account.profile_arn,
      ...(account.oidc_region !== null && isValidRegion(account.oidc_region)
        ? { oidcRegion: account.oidc_region }
        : {}),
      ...(account.client_id === null ? {} : { clientId: account.client_id }),
      ...(account.client_secret === null ? {} : { clientSecret: account.client_secret }),
    };
    console.log(`Database: ${path}`);
    console.log(`Auth method: ${account.auth_method}`);
    console.log(`Generation region: ${generationRegion}`);

    const claudeModel = MODEL_MAPPING["claude-opus-5"];
    const claudeOutputLimitModel = MODEL_MAPPING["claude-sonnet-5"];
    const claudeOpusOutputLimitModel = MODEL_MAPPING["claude-opus-5"];
    const gptModel = MODEL_MAPPING["gpt-5.6-sol"];
    if (
      claudeModel === undefined ||
      claudeOutputLimitModel === undefined ||
      claudeOpusOutputLimitModel === undefined ||
      gptModel === undefined
    ) {
      throw new ProbeConfigurationError("Required probe model mappings are missing");
    }
    if (protocolProjectionMode) {
      const projectionModel = protocolProjectionClaude ? claudeModel : gptModel;
      console.log(
        `Protocol projection model: ${protocolProjectionClaude ? "Claude Opus 5" : "GPT 5.6 Sol"} (${projectionModel})`,
      );
      return await runProtocolProjectionProbe(
        auth,
        generationRegion,
        projectionModel,
        claudeOutputLimitModel,
        proxyUrl,
      );
    }

    const specs: readonly ProbeSpec[] = outputTokenLimitMode
      ? [
          {
            label: "Claude Sonnet 5 control without output limit",
            modelId: claudeOutputLimitModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            outputTokensAtLeast: OUTPUT_TOKEN_CONTROL_MINIMUM,
          },
          {
            label: "Claude Sonnet 5 native max_tokens",
            modelId: claudeOutputLimitModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              max_tokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
          {
            label: "Claude Sonnet 5 oversized max_tokens boundary",
            modelId: claudeOutputLimitModel,
            prompt: "Say ok.",
            additionalModelRequestFields: {
              max_tokens: 2_147_483_647,
            },
            expectSchemaRejection: true,
          },
          {
            label: "Claude Opus 5 native max_tokens",
            modelId: claudeOpusOutputLimitModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              max_tokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
          {
            label: "Claude Opus 5 oversized max_tokens boundary",
            modelId: claudeOpusOutputLimitModel,
            prompt: "Say ok.",
            additionalModelRequestFields: {
              max_tokens: 128_001,
            },
            expectSchemaRejection: true,
          },
          {
            label: "GPT control without output limit",
            modelId: gptModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            outputTokensAtLeast: OUTPUT_TOKEN_CONTROL_MINIMUM,
          },
          {
            label: "GPT candidate max_output_tokens",
            modelId: gptModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              max_output_tokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
          {
            label: "GPT candidate max_tokens",
            modelId: gptModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              max_tokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
          {
            label: "GPT candidate max_completion_tokens",
            modelId: gptModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              max_completion_tokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
          {
            label: "GPT candidate maxTokens",
            modelId: gptModel,
            prompt: OUTPUT_TOKEN_LIMIT_PROMPT,
            additionalModelRequestFields: {
              maxTokens: OUTPUT_TOKEN_LIMIT,
            },
            expectAcceptedModelFields: true,
          },
        ]
      : webSearchMode
        ? [
            {
              label: "GPT control without Web Search",
              modelId: gptModel,
              prompt: WEB_SEARCH_PROMPT,
            },
            {
              label: "GPT native Web Search",
              modelId: gptModel,
              prompt: WEB_SEARCH_PROMPT,
              additionalModelRequestFields: {
                tools: [{ type: "web_search" }],
              },
              expectWebSearch: true,
            },
            {
              label: "GPT native Web Search without external fetch",
              modelId: gptModel,
              prompt: WEB_SEARCH_PROMPT,
              additionalModelRequestFields: {
                tools: [
                  {
                    type: "web_search",
                    external_web_access: false,
                  },
                ],
              },
              expectWebSearch: true,
            },
            {
              label: "Kiro harness-style web_search tool",
              modelId: gptModel,
              prompt: WEB_SEARCH_PROMPT,
              requestTools: [
                {
                  toolSpecification: {
                    name: "web_search",
                    description: "Search the public web for current information.",
                    inputSchema: {
                      json: {
                        type: "object",
                        properties: {
                          query: { type: "string" },
                        },
                        required: ["query"],
                      },
                    },
                  },
                },
              ],
              expectToolUse: true,
            },
          ]
        : [
            { label: "Plain Claude", modelId: claudeModel },
            {
              label: "Claude output_config.effort",
              modelId: claudeModel,
              effort: EFFORT,
            },
            {
              label: "GPT reasoning.effort",
              modelId: gptModel,
              effort: EFFORT,
            },
          ];
    const results: ProbeResult[] = [];
    for (const spec of specs) {
      const result = await runRequest(auth, generationRegion, spec, proxyUrl);
      results.push(result);
      printRequestResult(result);
    }

    if (webSearchMode) {
      const control = results[0];
      const experiments = results.slice(1, 3);
      if (experiments.some((result) => result.webSearchEvidenceSeen)) {
        printVerdict(
          "WEB-SEARCH-SUPPORTED",
          "Kiro returned citation or supplementary web-link events for a native Web Search request.",
        );
        return 0;
      }
      if (
        control?.pass === true &&
        experiments.every(
          (result) =>
            result.conclusiveFailure || (result.cleanEof && !result.webSearchEvidenceSeen),
        )
      ) {
        printVerdict(
          "WEB-SEARCH-UNSUPPORTED",
          "The control request succeeded, but native Web Search was rejected or completed without search evidence.",
        );
        return 1;
      }
      printVerdict(
        "INCONCLUSIVE",
        "The credentials or control request did not establish a valid comparison.",
      );
      return 2;
    }

    if (outputTokenLimitMode) {
      const claudeControl = results[0];
      const claudeLimited = results[1];
      const claudeUpperBoundary = results[2];
      const gptControl = results[3];
      const gptCandidates = results.slice(4);
      const acceptedGptFields = gptCandidates.filter((result) => result.pass);
      const controlsPass = claudeControl?.pass === true && gptControl?.pass === true;
      if (
        controlsPass &&
        claudeLimited?.pass === true &&
        claudeUpperBoundary?.pass === true &&
        acceptedGptFields.length === 1
      ) {
        const accepted = acceptedGptFields[0];
        printVerdict(
          "OUTPUT-TOKEN-LIMIT-SUPPORTED",
          `Kiro accepted Claude max_tokens and the GPT field exercised by ${accepted?.label ?? "the passing candidate"} at the schema minimum of 1024.`,
        );
        return 0;
      }
      if (
        controlsPass &&
        claudeLimited !== undefined &&
        (claudeLimited.pass || claudeLimited.conclusiveFailure) &&
        claudeUpperBoundary?.pass === true &&
        gptCandidates.every((result) => result.conclusiveFailure || result.pass)
      ) {
        printVerdict(
          "OUTPUT-TOKEN-LIMIT-UNSUPPORTED",
          "Claude max_tokens was characterized, but every tested GPT output-token field was rejected by Kiro's model schema.",
        );
        return 1;
      }
      printVerdict(
        "INCONCLUSIVE",
        "The output-token controls or usage metadata did not establish a valid comparison.",
      );
      return 2;
    }

    if (results.every((result) => result.pass)) {
      printVerdict("SDK-OK", "All three SDK requests reached clean EOF with content events.");
      return 0;
    }
    if (results.some((result) => result.pass || result.conclusiveFailure)) {
      printVerdict(
        "SDK-FAIL",
        "At least one request proved the credentials/wire path but one or more SDK probes failed.",
      );
      return 1;
    }
    printVerdict(
      "INCONCLUSIVE",
      "No request established valid credentials. Check token, profile ARN, account quota, and regions, then rerun.",
    );
    return 2;
  } finally {
    db.close();
  }
}

function runCompileCheck(proxyUrl: string | undefined): number {
  console.log(`Compiling SDK probe to ${COMPILED_PROBE_PATH}...`);
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      "--compile",
      "scripts/probe-sdk.ts",
      "--outfile",
      COMPILED_PROBE_PATH,
    ],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) {
    printVerdict("SDK-FAIL", `bun build --compile failed with exit code ${build.exitCode}.`);
    return 1;
  }

  console.log(`Compile succeeded. Executing ${COMPILED_PROBE_PATH} once...`);
  const execution = Bun.spawnSync({
    cmd: buildCompileCheckArgs(proxyUrl),
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  return execution.exitCode;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun run scripts/probe-sdk.ts [options]

Options:
  --compile-check  Compile the probe and execute the compiled binary once
  --web-search    Compare a GPT control request with native Web Search fields
  --output-token-limit  Probe Claude max_tokens and GPT max_output_tokens enforcement
  --protocol-projection  Probe additionalContext, same-role history, tools, and reasoning replay
  --protocol-projection-claude  Use Claude Opus 5 instead of GPT 5.6 Sol for protocol projection
  --proxy <url>   Route token refresh and SDK requests through an HTTP(S) proxy
  --help          Show this help

Environment:
  KIRO_PROVIDER_PROXY_URL  Default proxy URL when --proxy is not provided`);
    return;
  }

  const proxyUrl = resolveProbeProxy(process.env, process.argv);
  if (process.argv.includes("--compile-check")) {
    process.exitCode = runCompileCheck(proxyUrl);
    return;
  }

  try {
    process.exitCode = await runLiveProbe(
      proxyUrl,
      process.argv.includes("--web-search"),
      process.argv.includes("--protocol-projection"),
      process.argv.includes("--output-token-limit"),
      process.argv.includes("--protocol-projection-claude"),
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const details = errorDetails(error);
    printVerdict(
      "INCONCLUSIVE",
      `${details.message}. Verify the database schema, credentials, profile ARN, and regions, then rerun.`,
    );
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
