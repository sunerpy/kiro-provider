import { randomUUID } from "node:crypto";
import { auditHash, auditLog } from "../../core/audit-log.js";
import { type CanonicalRequest, isCanonicalRequest } from "../../protocol/canonical.js";
import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
  parseCanonicalCompletion,
} from "../../protocol/output.js";
import type { AccountsDatabase, StoredResponseRecord } from "../../storage/accounts-db.js";
import type { ResponsesRequest } from "../request-schema.js";
import type { ResponseStateObject } from "./state.js";

const RESPONSE_STORE_TTL_MS = 30 * 24 * 60 * 60_000;
const RESPONSE_STORE_MAX_ENTRIES = 10_000;
const BYTE_MARKER = "__kiro_provider_bytes_v1";

interface StoredCanonicalEnvelope {
  readonly version: 1;
  readonly request: CanonicalRequest;
  readonly completion: CanonicalCompletion;
}

export interface StoredResponse {
  readonly response: ResponseStateObject;
  readonly inputItems: readonly unknown[];
  readonly request?: CanonicalRequest;
  readonly completion?: CanonicalCompletion;
}

export interface PipelineResponseStore {
  put(
    tenantId: string,
    response: ResponseStateObject,
    inputItems: readonly unknown[],
    request: CanonicalRequest,
    completion: CanonicalCompletion,
  ): void;
  putNative(tenantId: string, response: ResponseStateObject, inputItems: readonly unknown[]): void;
  get(tenantId: string, responseId: string): StoredResponse | undefined;
  delete(tenantId: string, responseId: string): boolean;
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) =>
    candidate instanceof Uint8Array
      ? { [BYTE_MARKER]: Buffer.from(candidate).toString("base64") }
      : candidate,
  );
}

function jsonParse(value: string): unknown {
  return JSON.parse(value, (_key, candidate) => {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Object.keys(candidate).length === 1 &&
      typeof (candidate as Record<string, unknown>)[BYTE_MARKER] === "string"
    ) {
      return Uint8Array.from(
        Buffer.from((candidate as Record<string, string>)[BYTE_MARKER] as string, "base64"),
      );
    }
    return candidate;
  });
}

function isResponseStateObject(value: unknown, responseId: string): value is ResponseStateObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    value.id === responseId &&
    "object" in value &&
    value.object === "response"
  );
}

function parseCanonicalEnvelope(value: unknown): StoredCanonicalEnvelope | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("request" in value) ||
    !isCanonicalRequest(value.request) ||
    !("completion" in value)
  ) {
    return undefined;
  }
  const completion = parseCanonicalCompletion(value.completion);
  if (!completion) return undefined;
  return { version: 1, request: value.request, completion };
}

export function responseStoreTenant(tenantId: string | undefined): string {
  return tenantId ?? "default";
}

function storedInputItemPrefix(item: Readonly<Record<string, unknown>>): string {
  switch (item.type) {
    case "message":
      return "msg";
    case "reasoning":
      return "rs";
    case "function_call":
      return "fc";
    case "custom_tool_call":
      return "ctc";
    case "function_call_output":
      return "fco";
    case "custom_tool_call_output":
      return "ctco";
    case "agent_message":
      return "am";
    case "additional_tools":
      return "at";
    default:
      return "item";
  }
}

export function responseInputItems(
  input: ResponsesRequest["input"],
): readonly Readonly<Record<string, unknown>>[] {
  if (typeof input === "string") {
    return [
      {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "user",
        status: "completed",
        content: [{ type: "input_text", text: input }],
      },
    ];
  }
  return input.map((item) => {
    const record = item as Readonly<Record<string, unknown>>;
    return {
      ...record,
      ...(typeof record.id === "string"
        ? {}
        : { id: `${storedInputItemPrefix(record)}_${randomUUID()}` }),
      ...(typeof record.status === "string" ? {} : { status: "completed" }),
    };
  });
}

export function canonicalCompletionFromResponse(
  response: ResponseStateObject,
): CanonicalCompletion {
  const text = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .map((part) => part.text)
    .join("");
  const reasoningItem = response.output.find((item) => item.type === "reasoning");
  const reasoningText =
    reasoningItem?.type === "reasoning"
      ? reasoningItem.summary.map((part) => part.text).join("")
      : undefined;
  const encryptedContent =
    reasoningItem?.type === "reasoning" ? reasoningItem.encrypted_content : undefined;
  const toolCalls = response.output.flatMap((item) => {
    if (item.type === "function_call") {
      return [
        {
          id: item.call_id,
          name: item.name,
          input: item.arguments,
        },
      ];
    }
    if (item.type === "custom_tool_call") {
      return [{ id: item.call_id, name: item.name, input: item.input }];
    }
    return [];
  });
  const usage = response.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId: response.id,
    model: response.model,
    createdAt: response.created_at * 1_000,
    text,
    ...(reasoningText !== undefined || encryptedContent !== undefined
      ? {
          reasoning: {
            ...(reasoningText !== undefined ? { text: reasoningText } : {}),
            ...(encryptedContent !== undefined ? { encryptedContent } : {}),
          },
        }
      : {}),
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

export class SqliteResponseStore implements PipelineResponseStore {
  constructor(
    private readonly database: Pick<
      AccountsDatabase,
      "putStoredResponse" | "getStoredResponse" | "deleteStoredResponse"
    >,
    private readonly ttlMs = RESPONSE_STORE_TTL_MS,
    private readonly maxEntries = RESPONSE_STORE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  put(
    tenantId: string,
    response: ResponseStateObject,
    inputItems: readonly unknown[],
    request: CanonicalRequest,
    completion: CanonicalCompletion,
  ): void {
    const now = this.now();
    const record: StoredResponseRecord = {
      id: response.id,
      tenantId,
      model: response.model,
      responseJson: jsonStringify(response),
      inputItemsJson: jsonStringify(inputItems),
      canonicalJson: jsonStringify({
        version: 1,
        request,
        completion,
      } satisfies StoredCanonicalEnvelope),
      createdAt: response.created_at * 1_000,
      lastSeen: now,
      expiresAt: now + this.ttlMs,
    };
    this.database.putStoredResponse(record, this.maxEntries, now);
    auditLog("debug", "response_state_stored", {
      response_hash: auditHash(response.id),
      tenant_hash: auditHash(tenantId),
      model: response.model,
      input_item_count: inputItems.length,
      output_item_count: response.output.length,
      expires_in_ms: this.ttlMs,
    });
  }

  putNative(tenantId: string, response: ResponseStateObject, inputItems: readonly unknown[]): void {
    const now = this.now();
    this.database.putStoredResponse(
      {
        id: response.id,
        tenantId,
        model: response.model,
        responseJson: jsonStringify(response),
        inputItemsJson: jsonStringify(inputItems),
        canonicalJson: jsonStringify({ version: 2, transport: "kiro-native-responses" }),
        createdAt: response.created_at * 1_000,
        lastSeen: now,
        expiresAt: now + this.ttlMs,
      },
      this.maxEntries,
      now,
    );
    auditLog("debug", "native_response_state_mirrored", {
      response_hash: auditHash(response.id),
      tenant_hash: auditHash(tenantId),
      model: response.model,
      input_item_count: inputItems.length,
      output_item_count: response.output.length,
      expires_in_ms: this.ttlMs,
    });
  }

  get(tenantId: string, responseId: string): StoredResponse | undefined {
    const record = this.database.getStoredResponse(responseId, tenantId, this.now());
    if (!record) return undefined;
    try {
      const response = jsonParse(record.responseJson);
      const inputItems = jsonParse(record.inputItemsJson);
      const canonical = parseCanonicalEnvelope(jsonParse(record.canonicalJson));
      if (!isResponseStateObject(response, responseId) || !Array.isArray(inputItems)) {
        throw new TypeError("Stored response state has an invalid shape");
      }
      return {
        response,
        inputItems,
        ...(canonical === undefined
          ? {}
          : { request: canonical.request, completion: canonical.completion }),
      };
    } catch (error) {
      this.database.deleteStoredResponse(responseId, tenantId);
      auditLog("error", "response_state_corrupt", {
        response_hash: auditHash(responseId),
        tenant_hash: auditHash(tenantId),
        error_type: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  }

  delete(tenantId: string, responseId: string): boolean {
    const deleted = this.database.deleteStoredResponse(responseId, tenantId);
    auditLog("debug", "response_state_deleted", {
      response_hash: auditHash(responseId),
      tenant_hash: auditHash(tenantId),
      deleted,
    });
    return deleted;
  }
}
