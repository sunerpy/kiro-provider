import { auditHash, auditLog, getAuditLogLevel } from "../core/audit-log.js";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalProtocol,
  CanonicalRequest,
} from "../protocol/canonical.js";

/**
 * Structural summary of a `CanonicalRequest` for the `request_shape` audit
 * event. Every field is a count, boolean, hash, or enumerated label; no
 * message text, tool argument, tool name, or instruction text is ever
 * present, so the event is safe to emit at `debug` level in production.
 *
 * Declared as a type alias (not an interface) so it stays assignable to the
 * `auditLog` field record.
 */
export type RequestShape = {
  readonly protocol: CanonicalProtocol;
  readonly model: string;
  readonly message_count: number;
  readonly user_message_count: number;
  readonly assistant_message_count: number;
  readonly tool_message_count: number;
  /** `system` plus `developer` role messages. */
  readonly instruction_message_count: number;
  readonly tool_declaration_count: number;
  /** Tool calls in history: `toolCalls` entries plus `tool_use` parts, unique by id per message. */
  readonly tool_call_count: number;
  readonly tool_result_count: number;
  /** Tool results whose `toolCallId` matches no call in an earlier message. */
  readonly orphan_tool_result_count: number;
  readonly image_count: number;
  readonly document_count: number;
  readonly has_reasoning_replay: boolean;
  readonly reasoning_replay_count: number;
  /** `instructions` is set or at least one system/developer message exists. */
  readonly system_instruction_present: boolean;
  /** Sum of text lengths over message text parts, tool-result text, and `instructions`. */
  readonly input_text_chars: number;
  /** `auditHash` of the sorted, newline-joined public tool names (hash of `""` when there are none). */
  readonly tool_set_hash: string;
};

export const REQUEST_SHAPE_EVENT = "request_shape";

function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

interface MessageTally {
  textChars: number;
  images: number;
  documents: number;
  results: number;
  orphanResults: number;
  calls: number;
  /** Call ids introduced by this message; merged into the history after the tally. */
  readonly callIds: string[];
}

function tallyToolCalls(message: CanonicalMessage, tally: MessageTally): void {
  const ids = new Set<string>();
  let anonymous = 0;
  const record = (id: unknown): void => {
    if (typeof id === "string") ids.add(id);
    else anonymous += 1;
  };
  for (const call of asArray(message.toolCalls)) record(call?.id);
  for (const part of asArray(message.content)) {
    if (part?.type === "tool_use") record(part.id);
  }
  tally.calls += ids.size + anonymous;
  tally.callIds.push(...ids);
}

function tallyContentPart(
  part: CanonicalContentPart | undefined,
  knownCallIds: ReadonlySet<string>,
  tally: MessageTally,
): void {
  switch (part?.type) {
    case "text":
      tally.textChars += textLength(part.text);
      return;
    case "image":
      tally.images += 1;
      return;
    case "document":
      tally.documents += 1;
      return;
    case "tool_result":
      tally.results += 1;
      if (typeof part.toolCallId !== "string" || !knownCallIds.has(part.toolCallId)) {
        tally.orphanResults += 1;
      }
      for (const inner of asArray(part.content)) tally.textChars += textLength(inner?.text);
      return;
    default:
      return;
  }
}

/**
 * Pure structural description of a canonical request. Never throws for a
 * shape that merely deviates from the canonical contract (missing arrays,
 * non-string ids): unknown parts are skipped and unmatched results count as
 * orphans. Tool results are matched only against calls from *earlier*
 * messages, mirroring the tool-history validator.
 */
export function describeRequestShape(canonical: CanonicalRequest): RequestShape {
  const messages = asArray(canonical.messages);
  const tools = asArray(canonical.tools);
  const replays = asArray(canonical.reasoningReplays);
  const roles = { user: 0, assistant: 0, tool: 0, instruction: 0 };
  const tally: MessageTally = {
    textChars: textLength(canonical.instructions?.text),
    images: 0,
    documents: 0,
    results: 0,
    orphanResults: 0,
    calls: 0,
    callIds: [],
  };
  const knownCallIds = new Set<string>();

  for (const message of messages) {
    switch (message?.role) {
      case "user":
        roles.user += 1;
        break;
      case "assistant":
        roles.assistant += 1;
        break;
      case "tool":
        roles.tool += 1;
        break;
      case "system":
      case "developer":
        roles.instruction += 1;
        break;
      default:
        break;
    }
    if (message === undefined || message === null) continue;
    for (const part of asArray(message.content)) tallyContentPart(part, knownCallIds, tally);
    tallyToolCalls(message, tally);
    for (const id of tally.callIds.splice(0)) knownCallIds.add(id);
  }

  const toolNames = tools
    .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    protocol: canonical.protocol,
    model: canonical.model,
    message_count: messages.length,
    user_message_count: roles.user,
    assistant_message_count: roles.assistant,
    tool_message_count: roles.tool,
    instruction_message_count: roles.instruction,
    tool_declaration_count: tools.length,
    tool_call_count: tally.calls,
    tool_result_count: tally.results,
    orphan_tool_result_count: tally.orphanResults,
    image_count: tally.images,
    document_count: tally.documents,
    has_reasoning_replay: replays.length > 0,
    reasoning_replay_count: replays.length,
    system_instruction_present: canonical.instructions !== undefined || roles.instruction > 0,
    input_text_chars: tally.textChars,
    tool_set_hash: auditHash(toolNames.join("\n")),
  };
}

/**
 * Emits the `request_shape` diagnostic once per request at `debug` level. The
 * default `log_level` is `info`, so operators opt in by lowering the level;
 * the summary is not even computed otherwise. Diagnostics never fail a
 * request: any unexpected error is swallowed.
 */
export function auditRequestShape(canonical: CanonicalRequest): void {
  if (getAuditLogLevel() !== "debug") return;
  try {
    auditLog("debug", REQUEST_SHAPE_EVENT, describeRequestShape(canonical));
  } catch {
    // A diagnostic must never turn into a request failure.
  }
}
