import {
  isCompletionMetadataEvent,
  type NextSdkEvent,
  type SdkStreamEvent,
  SdkStreamProtocolError,
  SemanticStreamTruncationError,
} from "./sdk-stream-runtime.js";

export const REASONING_PREFIX_MAX_EVENTS = 128;
export const REASONING_PREFIX_MAX_BYTES = 1 << 20;

/** Owned by one accepted attempt, shared with its response-header construction. */
export interface ReasoningReplayDecision {
  mode?: "conflict-omitted";
}

interface ReasoningPrefix {
  readonly events: SdkStreamEvent[];
  readonly done: boolean;
  readonly aborted: boolean;
  readonly omitted: boolean;
  readonly reasoningEvents: number;
  readonly prefixEvents: number;
  readonly prefixBytes: number;
}

function invalidPrefix(message: string): never {
  throw new SdkStreamProtocolError(message, "invalid_upstream_reasoning");
}

/**
 * Classify the entire bounded prefix before publishing any canonical event.
 * Conflicting signatures are never retained, selected, concatenated or hashed.
 * The first assistant/tool event is the boundary, not part of the prefix budget.
 */
export async function readReasoningPrefix(
  read: () => Promise<NextSdkEvent>,
): Promise<ReasoningPrefix> {
  let events: SdkStreamEvent[] = [];
  let signature: string | undefined;
  let omitted = false;
  let signatureOnly = true;
  let reasoningEvents = 0;
  let prefixEvents = 0;
  let prefixBytes = 0;
  const result = (done = false, aborted = false): ReasoningPrefix => ({
    events,
    done,
    aborted,
    omitted,
    reasoningEvents,
    prefixEvents,
    prefixBytes,
  });
  while (true) {
    const next = await read();
    if (next.kind === "aborted") return result(false, true);
    if (next.result.done) {
      if (omitted) throw new SemanticStreamTruncationError();
      return result(true);
    }
    const event = next.result.value;
    const visible =
      Boolean(event.assistantResponseEvent?.content) || event.toolUseEvent !== undefined;
    const completed = isCompletionMetadataEvent(event);
    if (visible || completed) {
      if (event.reasoningContentEvent !== undefined) {
        invalidPrefix("Kiro mixed reasoning and assistant/completion event payloads");
      }
      if (omitted && !visible) {
        invalidPrefix("Kiro completed a conflicting reasoning prefix without assistant output");
      }
      events.push(event);
      return result();
    }
    // Reserve the count before serializing an event, and the bytes before retaining it.
    if (++prefixEvents > REASONING_PREFIX_MAX_EVENTS) {
      invalidPrefix("Kiro reasoning prefix exceeded its event budget");
    }
    const material = event.reasoningContentEvent;
    const materialBytes =
      (typeof material?.signature === "string"
        ? Buffer.byteLength(material.signature, "utf8")
        : 0) +
      (typeof material?.text === "string" ? Buffer.byteLength(material.text, "utf8") : 0) +
      (material?.redactedContent?.byteLength ?? 0);
    if (materialBytes > REASONING_PREFIX_MAX_BYTES - prefixBytes) {
      invalidPrefix("Kiro reasoning prefix exceeded its byte budget");
    }
    prefixBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    if (prefixBytes > REASONING_PREFIX_MAX_BYTES) {
      invalidPrefix("Kiro reasoning prefix exceeded its byte budget");
    }
    const reasoning = event.reasoningContentEvent;
    if (reasoning !== undefined) {
      reasoningEvents++;
      const nextSignature = reasoning.signature;
      const hasSignature = typeof nextSignature === "string" && nextSignature.length > 0;
      signatureOnly &&=
        hasSignature &&
        (reasoning.text === undefined || reasoning.text === "") &&
        reasoning.redactedContent === undefined;
      if (hasSignature && signature !== undefined && signature !== nextSignature) {
        omitted = true;
        signature = undefined;
        events = events.filter((pending) => pending.reasoningContentEvent === undefined);
      }
      if (omitted && !signatureOnly) {
        invalidPrefix("Kiro emitted conflicting reasoning outside the empty-signature prefix");
      }
      if (omitted) continue;
      if (hasSignature) signature = nextSignature;
    }
    events.push(event);
  }
}
