import {
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
  type CanonicalOutputEvent,
  type CanonicalOutputReasoning,
  type CanonicalOutputToolCall,
} from "../../protocol/output.js";
import {
  type TransformSdkOutputOptions,
  transformSdkOutputStream,
} from "./streaming/sdk-output-transformer.js";
import {
  SdkStreamProtocolError,
  type SdkStreamResponse,
  SemanticStreamTruncationError,
} from "./streaming/sdk-stream-runtime.js";

/**
 * Options for the non-stream collector. They are the transformer's options:
 * reasoning capture, output fingerprint, and lineage callbacks fire from the
 * transformer exactly as on the streaming path, and `onRawEvent` /
 * `onCompletionWitness` expose the same raw-stream audit hooks.
 */
export type CollectSdkResponseOptions = TransformSdkOutputOptions & {
  /** Observes every canonical event as it is folded into the completion. */
  readonly onCanonicalEvent?: (event: CanonicalOutputEvent) => void;
};

export class MissingSdkEventStreamError extends Error {
  readonly name = "MissingSdkEventStreamError";
  readonly code = "missing_upstream_stream";

  constructor() {
    super("SDK response has no event stream");
  }
}

type CompletedEvent = Extract<CanonicalOutputEvent, { readonly type: "completed" }>;

interface ToolCallAccumulator {
  id: string | undefined;
  name: string | undefined;
  arguments: string;
}

/**
 * Drain the canonical output stream for one SDK response and fold it into a
 * single completion. Every validation (completion witness, tool structure,
 * reasoning metadata) lives in the transformer, so non-stream and stream
 * requests fail with the same typed errors.
 */
export async function collectSdkResponse(
  sdkResponse: SdkStreamResponse,
  model: string,
  conversationId: string,
  signal?: AbortSignal,
  options: CollectSdkResponseOptions = {},
): Promise<CanonicalCompletion> {
  if (!sdkResponse.generateAssistantResponseResponse) throw new MissingSdkEventStreamError();

  let createdAt: number | undefined;
  let text = "";
  let reasoningText = "";
  let signature: string | undefined;
  let redactedContent: string | undefined;
  let encryptedContent: string | undefined;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let completed: CompletedEvent | undefined;
  const { onCanonicalEvent, ...transformOptions } = options;

  try {
    for await (const event of transformSdkOutputStream(
      sdkResponse,
      model,
      conversationId,
      signal,
      transformOptions,
    )) {
      onCanonicalEvent?.(event);
      switch (event.type) {
        case "started":
          createdAt = event.createdAt;
          break;
        case "reasoning_delta":
          reasoningText += event.text;
          break;
        case "reasoning_signature":
          signature = event.signature;
          break;
        case "reasoning_redacted":
          redactedContent = event.data;
          break;
        case "reasoning_encrypted":
          encryptedContent = event.encryptedContent;
          break;
        case "text_delta":
          text += event.text;
          break;
        case "tool_call_delta": {
          const existing = toolCalls.get(event.index);
          if (existing) {
            existing.arguments += event.arguments;
            if (event.id !== undefined) existing.id = event.id;
            if (event.name !== undefined) existing.name = event.name;
          } else {
            toolCalls.set(event.index, {
              id: event.id,
              name: event.name,
              arguments: event.arguments,
            });
          }
          break;
        }
        case "completed":
          completed = event;
          break;
      }
    }
  } catch (error) {
    // A client abort that races clean EOF is reported as the abort, not as an
    // upstream truncation, matching the pipeline's own precedence.
    if (error instanceof SemanticStreamTruncationError && signal?.aborted) throw signal.reason;
    throw error;
  }

  // The transformer returns early on abort without a completion event.
  if (signal?.aborted) throw signal.reason;
  if (completed === undefined) throw new SemanticStreamTruncationError();

  const outputToolCalls: CanonicalOutputToolCall[] = [];
  for (const call of toolCalls.values()) {
    if (call.id === undefined || call.name === undefined) {
      throw new SdkStreamProtocolError(
        "Canonical tool call completed without an id and name",
        "upstream_protocol_error",
      );
    }
    outputToolCalls.push({ id: call.id, name: call.name, input: call.arguments });
  }

  const reasoning: CanonicalOutputReasoning = {
    ...(reasoningText ? { text: reasoningText } : {}),
    ...(signature !== undefined ? { signature } : {}),
    ...(redactedContent !== undefined ? { redactedContent } : {}),
    ...(encryptedContent !== undefined ? { encryptedContent } : {}),
  };

  return {
    canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
    conversationId,
    model,
    createdAt: createdAt ?? Math.floor(Date.now() / 1000),
    text,
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    toolCalls: outputToolCalls,
    finishReason: completed.finishReason,
    usage: completed.usage,
  };
}
