import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import { normalizeStreamFailure, streamFailure } from "../../core/stream-error.js";
import { type CodeReference, codeReferenceMetadata } from "../../protocol/code-references.js";
import type { CanonicalOutputUsage } from "../../protocol/output.js";
import {
  type CanonicalCompletionV2,
  type CanonicalOutputEventV2,
  parseCanonicalOutputEventV2Line,
} from "../../protocol/output-v2.js";
import { isProviderReplayToken } from "../../reasoning/replay-token.js";
import type { IngressSignals } from "../request-lifecycle.js";
import {
  couldStillBeGpt56ReasoningPlaceholder,
  isGpt56Model,
  isGpt56ReasoningPlaceholder,
} from "../responses/reasoning.js";
import { anthropicError, anthropicStreamError } from "./errors.js";
import {
  type AnthropicCompatibilityOptions,
  type AnthropicTerminalFailure,
  compatibilityHeaders,
  toAnthropicFailure,
  usagePayload,
} from "./response-adapter.js";

/**
 * Anthropic Messages encoding of hosted web search output (canonical v2).
 *
 * One public response can span several Kiro generations. Each generation is a
 * segment with its own reasoning envelope; the server tool blocks and their
 * results separate the segments in the order the provider executed them, and
 * the reasoning rules of an ordinary response apply within each segment. The
 * stream and the JSON body share this encoder: the JSON content is exactly the
 * accumulation of the block events the stream publishes.
 */

export interface HostedBlockSink {
  start(index: number, block: Readonly<Record<string, unknown>>): void;
  delta(index: number, delta: Readonly<Record<string, unknown>>): void;
  stop(index: number): void;
}

export class HostedOutputError extends Error {
  override readonly name = "HostedOutputError";

  constructor(
    message: string,
    readonly code: "invalid_upstream_reasoning" | "upstream_protocol_error",
  ) {
    super(message);
  }
}

export interface HostedEncoderOptions {
  readonly model: string;
  readonly thinkingDisplay?: "omitted" | "summarized";
  /** The pipeline omitted a conflicting reasoning prefix; reasoning must not follow. */
  readonly outputReasoningOmitted?: boolean;
}

export interface HostedTerminal {
  readonly stopReason: "end_turn" | "tool_use" | "pause_turn";
  readonly usage: CanonicalOutputUsage;
  readonly webSearchRequests: number;
  readonly codeReferences?: readonly CodeReference[];
}

interface TextPiece {
  readonly text: string;
  readonly citation?: Readonly<Record<string, unknown>>;
}

/** Reasoning and text state of one generation segment. */
class Segment {
  reasoningIndex: number | undefined;
  reasoningStarted = false;
  reasoningStopped = false;
  reasoningSigned = false;
  pendingText = "";
  // Distinguishes an explicit empty canonical thinking marker from no reasoning.
  pendingSeen = false;
  opaquePlaceholderSeen = false;
  omittedSeen = false;
  hiddenReplayToken: string | undefined;
  // A signature that has not been written into an open thinking block yet.
  pendingSignature: string | undefined;
  // Visible reasoning that arrived after text; it becomes its own block at the
  // segment end so no delta ever targets a stopped block.
  deferredReasoningText = "";
  // Text after omitted reasoning waits for the replay token minted at the end
  // of the generation.
  readonly deferred: TextPiece[] = [];
  readonly deferredRedacted: string[] = [];
  redactedEmitted = false;
  textEmitted = false;
  hasContent = false;
}

function reasoningError(message: string): HostedOutputError {
  return new HostedOutputError(message, "invalid_upstream_reasoning");
}

function protocolError(message: string): HostedOutputError {
  return new HostedOutputError(message, "upstream_protocol_error");
}

function parseToolInput(argumentsText: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

type CallState = { deferred: boolean; resolved: boolean };

export class HostedMessagesEncoder {
  #next = 0;
  #started = false;
  #terminal: HostedTerminal | undefined;
  /** Before any generation content: results here answer calls from history. */
  #prelude = true;
  #phase: "generation" | "group" = "generation";
  #segment = new Segment();
  #textIndex: number | undefined;
  readonly #calls = new Map<string, CallState>();
  #groupClientCalls = 0;
  #groupDeferredCalls = 0;
  readonly #gpt: boolean;
  readonly #omitted: boolean;

  constructor(
    private readonly options: HostedEncoderOptions,
    private readonly sink: HostedBlockSink,
  ) {
    this.#gpt = isGpt56Model(options.model);
    this.#omitted = options.thinkingDisplay === "omitted";
  }

  get terminal(): HostedTerminal | undefined {
    return this.#terminal;
  }

  push(event: CanonicalOutputEventV2): void {
    if (this.#terminal !== undefined) throw protocolError("Malformed upstream event ordering");
    if (event.type === "started") {
      if (this.#started || event.model !== this.options.model) {
        throw protocolError("Malformed upstream stream start");
      }
      this.#started = true;
      return;
    }
    if (!this.#started) throw protocolError("Malformed upstream event ordering");
    if (this.options.outputReasoningOmitted && event.type.startsWith("reasoning_")) {
      throw reasoningError("Pipeline emitted reasoning after omitting its conflict");
    }
    switch (event.type) {
      case "reasoning_delta":
        this.#content();
        this.#reasoningDelta(event.text);
        return;
      case "reasoning_signature":
        this.#content();
        this.#reasoningSignature(event.signature);
        return;
      case "reasoning_redacted":
        this.#content();
        this.#reasoningRedacted(event.data);
        return;
      case "reasoning_encrypted":
        this.#content();
        this.#reasoningEncrypted(event.encryptedContent);
        return;
      case "text_delta":
        this.#content();
        this.#text({ text: event.text });
        return;
      case "citation":
        this.#content();
        if (typeof event.encryptedIndex !== "string" || event.encryptedIndex.length === 0) {
          throw protocolError("Web search citation is missing its encrypted index");
        }
        this.#text({
          text: event.text,
          citation: {
            type: "web_search_result_location",
            url: event.url,
            title: event.title,
            encrypted_index: event.encryptedIndex,
            cited_text: event.citedText,
          },
        });
        return;
      case "tool_call_delta":
        this.#group();
        this.#clientTool(event);
        return;
      case "search_call_started":
        this.#group();
        this.#searchStarted(event.callId, event.query, event.deferred);
        return;
      case "search_result":
        this.#result(event.callId);
        this.#resultBlock(event.callId, {
          content: event.sources.map((source) => {
            if (
              typeof source.encryptedContent !== "string" ||
              source.encryptedContent.length === 0
            ) {
              throw protocolError("Web search result is missing its encrypted content");
            }
            return {
              type: "web_search_result",
              url: source.url,
              title: source.title,
              encrypted_content: source.encryptedContent,
              page_age: source.pageAge,
            };
          }),
        });
        return;
      case "search_call_failed":
        this.#result(event.callId);
        this.#resultBlock(event.callId, {
          content: { type: "web_search_tool_result_error", error_code: event.errorCode },
        });
        return;
      case "search_call_completed": {
        const call = this.#calls.get(event.callId);
        if (call === undefined || !call.resolved) {
          throw protocolError("Web search completion has no result");
        }
        return;
      }
      case "generation_boundary":
        this.#closeSegment();
        this.#requireResolvedGroup();
        this.#phase = "generation";
        this.#groupClientCalls = 0;
        this.#groupDeferredCalls = 0;
        return;
      case "completed":
        this.#closeSegment();
        this.#complete(event);
        return;
    }
  }

  #content(): void {
    if (this.#phase === "group") throw protocolError("Generation output followed its tool group");
    this.#prelude = false;
    this.#segment.hasContent = true;
  }

  #group(): void {
    if (this.#phase === "generation") this.#closeSegment();
    this.#prelude = false;
    this.#phase = "group";
  }

  #result(callId: string): void {
    const call = this.#calls.get(callId);
    if (call === undefined) {
      // A pending call from history executes before the first generation.
      if (!this.#prelude) throw protocolError("Web search result has no published call");
      this.#calls.set(callId, { deferred: false, resolved: true });
      return;
    }
    if (call.deferred || call.resolved || this.#phase !== "group") {
      throw protocolError("Web search result does not match its call");
    }
    call.resolved = true;
  }

  #requireResolvedGroup(): void {
    for (const call of this.#calls.values()) {
      if (!call.deferred && !call.resolved)
        throw protocolError("Web search call ended without a result");
    }
    if (this.#groupClientCalls > 0 || this.#groupDeferredCalls > 0) {
      throw protocolError("A generation boundary followed calls awaiting the client");
    }
  }

  #complete(event: Extract<CanonicalOutputEventV2, { readonly type: "completed" }>): void {
    for (const call of this.#calls.values()) {
      if (!call.deferred && !call.resolved)
        throw protocolError("Web search call ended without a result");
    }
    const lastGroup = this.#phase === "group";
    const clientCalls = lastGroup ? this.#groupClientCalls : 0;
    const deferredCalls = lastGroup ? this.#groupDeferredCalls : 0;
    const stopReason =
      event.finishReason === "tool_calls"
        ? "tool_use"
        : event.finishReason === "pause"
          ? "pause_turn"
          : "end_turn";
    const consistent =
      stopReason === "tool_use"
        ? clientCalls > 0
        : stopReason === "pause_turn"
          ? deferredCalls > 0 && clientCalls === 0
          : clientCalls === 0 && deferredCalls === 0;
    if (!consistent) throw protocolError("Upstream finish reason does not match its output");
    this.#terminal = {
      stopReason,
      usage: event.usage,
      webSearchRequests: event.webSearchRequests,
      ...(event.codeReferences !== undefined ? { codeReferences: event.codeReferences } : {}),
    };
  }

  #clientTool(event: Extract<CanonicalOutputEventV2, { readonly type: "tool_call_delta" }>): void {
    if (event.id === undefined || event.id.length === 0 || !event.name) {
      throw protocolError("Malformed upstream tool call");
    }
    if (parseToolInput(event.arguments) === undefined)
      throw protocolError("Malformed upstream tool call");
    const index = this.#next++;
    this.sink.start(index, { type: "tool_use", id: event.id, name: event.name, input: {} });
    if (event.arguments.length > 0) {
      this.sink.delta(index, { type: "input_json_delta", partial_json: event.arguments });
    }
    this.sink.stop(index);
    this.#groupClientCalls += 1;
  }

  #searchStarted(callId: string, query: string, deferred: boolean): void {
    if (this.#calls.has(callId)) throw protocolError("Web search call identity repeated");
    this.#calls.set(callId, { deferred, resolved: false });
    if (deferred) this.#groupDeferredCalls += 1;
    const index = this.#next++;
    this.sink.start(index, { type: "server_tool_use", id: callId, name: "web_search", input: {} });
    this.sink.delta(index, { type: "input_json_delta", partial_json: JSON.stringify({ query }) });
    this.sink.stop(index);
  }

  #resultBlock(callId: string, body: { readonly content: unknown }): void {
    const index = this.#next++;
    this.sink.start(index, { type: "web_search_tool_result", tool_use_id: callId, ...body });
    this.sink.stop(index);
  }

  // Reasoning within one segment follows the ordinary Messages response rules.

  #reasoningDelta(text: string): void {
    const segment = this.#segment;
    if (segment.redactedEmitted || segment.deferredRedacted.length > 0) {
      throw protocolError("Upstream mixed visible and redacted reasoning payloads");
    }
    if (segment.textEmitted && this.#gpt) {
      throw reasoningError("Upstream emitted GPT reasoning after assistant text");
    }
    if (this.#omitted && this.#gpt) {
      segment.pendingSeen = true;
      segment.pendingText += text;
      if (couldStillBeGpt56ReasoningPlaceholder(this.options.model, segment.pendingText)) return;
      segment.pendingText = "";
      segment.pendingSeen = false;
      segment.omittedSeen = true;
      return;
    }
    if (this.#omitted) {
      segment.omittedSeen = true;
      return;
    }
    if (segment.reasoningStopped || segment.textEmitted) {
      segment.deferredReasoningText += text;
      return;
    }
    if (!segment.reasoningStarted && this.#gpt) {
      segment.pendingSeen = true;
      segment.pendingText += text;
      if (couldStillBeGpt56ReasoningPlaceholder(this.options.model, segment.pendingText)) return;
      this.#flushPendingReasoning();
      return;
    }
    this.#visibleReasoning(text);
  }

  #reasoningSignature(signature: string): void {
    const segment = this.#segment;
    if (segment.opaquePlaceholderSeen) {
      if (!segment.reasoningSigned) this.#opaquePlaceholderSignature(signature);
      return;
    }
    if (segment.pendingSeen) {
      if (isGpt56ReasoningPlaceholder(this.options.model, segment.pendingText)) {
        if (this.#omitted) {
          segment.pendingText = "";
          segment.pendingSeen = false;
          segment.opaquePlaceholderSeen = true;
          segment.omittedSeen = true;
        } else {
          this.#opaquePlaceholderSignature(signature);
        }
        return;
      }
      if (this.#omitted) {
        segment.pendingText = "";
        segment.pendingSeen = false;
        segment.omittedSeen = true;
        return;
      }
      this.#flushPendingReasoning();
    }
    if (this.#omitted) {
      segment.omittedSeen = true;
      return;
    }
    if (
      segment.reasoningStarted &&
      !segment.reasoningStopped &&
      segment.reasoningIndex !== undefined
    ) {
      this.sink.delta(segment.reasoningIndex, { type: "signature_delta", signature });
      segment.reasoningSigned = true;
    } else {
      segment.pendingSignature = signature;
    }
  }

  #reasoningRedacted(data: string): void {
    const segment = this.#segment;
    if (
      segment.reasoningStarted ||
      segment.pendingSeen ||
      segment.opaquePlaceholderSeen ||
      segment.omittedSeen ||
      segment.pendingSignature !== undefined ||
      segment.deferredReasoningText.length > 0
    ) {
      throw protocolError("Upstream mixed visible and redacted reasoning payloads");
    }
    if (segment.textEmitted) {
      segment.deferredRedacted.push(data);
      return;
    }
    this.#redactedBlock(data);
  }

  #reasoningEncrypted(token: string): void {
    const segment = this.#segment;
    if (!this.#omitted) return;
    if (segment.redactedEmitted || segment.deferredRedacted.length > 0) return;
    if (!isProviderReplayToken(token)) {
      throw reasoningError("Upstream returned an invalid provider replay token");
    }
    segment.hiddenReplayToken = token;
  }

  #text(piece: TextPiece): void {
    this.#flushPendingReasoning();
    this.#stopReasoning();
    if (this.#segment.omittedSeen) {
      this.#segment.deferred.push(piece);
      return;
    }
    this.#emitPiece(piece);
  }

  #emitPiece(piece: TextPiece): void {
    if (piece.citation === undefined) {
      if (piece.text.length === 0) return;
      if (this.#textIndex === undefined) {
        this.#textIndex = this.#next++;
        this.sink.start(this.#textIndex, { type: "text", text: "" });
      }
      this.sink.delta(this.#textIndex, { type: "text_delta", text: piece.text });
      this.#segment.textEmitted = true;
      return;
    }
    // Each cited span is its own text block carrying its citation.
    this.#closeText();
    const index = this.#next++;
    this.sink.start(index, { type: "text", text: "" });
    this.sink.delta(index, { type: "citations_delta", citation: piece.citation });
    this.sink.delta(index, { type: "text_delta", text: piece.text });
    this.sink.stop(index);
    this.#segment.textEmitted = true;
  }

  #closeText(): void {
    if (this.#textIndex === undefined) return;
    this.sink.stop(this.#textIndex);
    this.#textIndex = undefined;
  }

  #visibleReasoning(text: string): void {
    const segment = this.#segment;
    if (!segment.reasoningStarted) {
      segment.reasoningIndex = this.#next++;
      segment.reasoningStarted = true;
      this.sink.start(segment.reasoningIndex, { type: "thinking", thinking: "", signature: "" });
    }
    if (text.length === 0 || segment.reasoningIndex === undefined) return;
    this.sink.delta(segment.reasoningIndex, { type: "thinking_delta", thinking: text });
  }

  #opaquePlaceholderSignature(signature: string): void {
    const segment = this.#segment;
    segment.opaquePlaceholderSeen = true;
    segment.pendingText = "";
    segment.pendingSeen = false;
    this.#visibleReasoning("");
    if (segment.reasoningIndex === undefined) {
      throw reasoningError("Upstream placeholder thinking could not allocate a block");
    }
    this.sink.delta(segment.reasoningIndex, { type: "signature_delta", signature });
    segment.reasoningSigned = true;
  }

  #flushPendingReasoning(): void {
    const segment = this.#segment;
    if (!segment.pendingSeen) return;
    const text = segment.pendingText;
    segment.pendingText = "";
    segment.pendingSeen = false;
    if (isGpt56ReasoningPlaceholder(this.options.model, text)) {
      throw reasoningError("Upstream placeholder thinking is missing its native signature");
    }
    this.#visibleReasoning(text);
  }

  #stopReasoning(): void {
    const segment = this.#segment;
    if (
      !segment.reasoningStarted ||
      segment.reasoningStopped ||
      segment.reasoningIndex === undefined
    )
      return;
    if (segment.pendingSignature !== undefined) {
      this.sink.delta(segment.reasoningIndex, {
        type: "signature_delta",
        signature: segment.pendingSignature,
      });
      segment.pendingSignature = undefined;
      segment.reasoningSigned = true;
    }
    segment.reasoningStopped = true;
    this.sink.stop(segment.reasoningIndex);
  }

  /** Returns false when a deferred thinking block had no signature to carry. */
  #flushDeferredReasoning(): boolean {
    const segment = this.#segment;
    if (segment.deferredReasoningText.length === 0) return true;
    const index = this.#next++;
    this.sink.start(index, { type: "thinking", thinking: "", signature: "" });
    this.sink.delta(index, { type: "thinking_delta", thinking: segment.deferredReasoningText });
    segment.deferredReasoningText = "";
    const signed = segment.pendingSignature !== undefined;
    if (segment.pendingSignature !== undefined) {
      this.sink.delta(index, { type: "signature_delta", signature: segment.pendingSignature });
      segment.pendingSignature = undefined;
    }
    this.sink.stop(index);
    return signed;
  }

  #redactedBlock(data: string): void {
    const index = this.#next++;
    this.sink.start(index, { type: "redacted_thinking", data });
    this.sink.stop(index);
    this.#segment.redactedEmitted = true;
  }

  #hiddenReplayBlock(token: string): void {
    const index = this.#next++;
    this.sink.start(index, { type: "thinking", thinking: "", signature: "" });
    this.sink.delta(index, { type: "signature_delta", signature: token });
    this.sink.stop(index);
  }

  #closeSegment(): void {
    const segment = this.#segment;
    if (!segment.hasContent) return;
    this.#flushPendingReasoning();
    this.#closeText();
    this.#stopReasoning();
    const deferredSigned = this.#flushDeferredReasoning();
    const hidden = segment.omittedSeen;
    if (
      (hidden && segment.hiddenReplayToken === undefined) ||
      (hidden && segment.textEmitted) ||
      (segment.reasoningStarted && !segment.reasoningSigned) ||
      !deferredSigned ||
      segment.pendingSignature !== undefined
    ) {
      throw reasoningError("Upstream returned incomplete signed reasoning metadata");
    }
    if (hidden && segment.hiddenReplayToken !== undefined) {
      this.#hiddenReplayBlock(segment.hiddenReplayToken);
    }
    for (const piece of segment.deferred) this.#emitPiece(piece);
    this.#closeText();
    for (const data of segment.deferredRedacted) this.#redactedBlock(data);
    this.#segment = new Segment();
  }
}

/** Accumulates block events into complete content blocks (the JSON body). */
class ContentCollector implements HostedBlockSink {
  readonly blocks: Record<string, unknown>[] = [];
  readonly #json = new Map<number, string>();

  start(index: number, block: Readonly<Record<string, unknown>>): void {
    this.blocks[index] = { ...block };
  }

  delta(index: number, delta: Readonly<Record<string, unknown>>): void {
    const block = this.blocks[index];
    if (block === undefined) throw protocolError("Content delta has no block");
    switch (delta.type) {
      case "text_delta":
        block.text = `${String(block.text ?? "")}${String(delta.text)}`;
        return;
      case "thinking_delta":
        block.thinking = `${String(block.thinking ?? "")}${String(delta.thinking)}`;
        return;
      case "signature_delta":
        block.signature = delta.signature;
        return;
      case "input_json_delta":
        this.#json.set(index, `${this.#json.get(index) ?? ""}${String(delta.partial_json)}`);
        return;
      case "citations_delta":
        block.citations = [...((block.citations as unknown[] | undefined) ?? []), delta.citation];
        return;
    }
  }

  stop(index: number): void {
    const json = this.#json.get(index);
    const block = this.blocks[index];
    if (json === undefined || block === undefined) return;
    block.input = JSON.parse(json) as unknown;
    this.#json.delete(index);
  }
}

function hostedUsage(terminal: HostedTerminal): Readonly<Record<string, unknown>> {
  return {
    ...usagePayload(terminal.usage),
    server_tool_use: { web_search_requests: terminal.webSearchRequests },
  };
}

export function anthropicHostedMessageResponse(
  completion: CanonicalCompletionV2,
  model: string,
  options: AnthropicCompatibilityOptions = {},
): Response {
  const collector = new ContentCollector();
  const encoder = new HostedMessagesEncoder(
    {
      model,
      ...(options.thinkingDisplay !== undefined
        ? { thinkingDisplay: options.thinkingDisplay }
        : {}),
      ...(options.outputReasoningOmitted ? { outputReasoningOmitted: true } : {}),
    },
    collector,
  );
  try {
    for (const event of completion.events) encoder.push(event);
  } catch (error) {
    if (error instanceof HostedOutputError) return anthropicError(502, error.message, "api_error");
    throw error;
  }
  const terminal = encoder.terminal;
  if (terminal === undefined) {
    return anthropicError(502, "Pipeline returned an incomplete web search response", "api_error");
  }
  return Response.json(
    {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: collector.blocks,
      stop_reason: terminal.stopReason,
      stop_sequence: null,
      usage: hostedUsage(terminal),
      ...codeReferenceMetadata(terminal.codeReferences),
      ...(options.contextManagementRequested ? { context_management: { applied_edits: [] } } : {}),
    },
    { headers: compatibilityHeaders(options) },
  );
}

type HostedSseOptions = AnthropicCompatibilityOptions & {
  readonly model: string;
  readonly inputTokens: number;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
  readonly pingIntervalMs?: number;
};

function formatEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Streams hosted search output as Anthropic SSE. The pipeline owns execution
 * and its cleanup; this adapter owns the public event order, exactly one
 * terminal, keep-alives while a search or generation is pending, and releasing
 * the route resources once.
 */
export function anthropicHostedSseAdapter(
  pipelineResponse: Response,
  options: HostedSseOptions,
): Response {
  const upstream =
    pipelineResponse.body ??
    new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = upstream.getReader();
  const textEncoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frames: Uint8Array[] = [];
  const emit = (event: string, payload: unknown): void => {
    frames.push(textEncoder.encode(formatEvent(event, payload)));
  };
  const encoder = new HostedMessagesEncoder(
    {
      model: options.model,
      ...(options.thinkingDisplay !== undefined
        ? { thinkingDisplay: options.thinkingDisplay }
        : {}),
      ...(options.outputReasoningOmitted ? { outputReasoningOmitted: true } : {}),
    },
    {
      start: (index, block) =>
        emit("content_block_start", { type: "content_block_start", index, content_block: block }),
      delta: (index, delta) =>
        emit("content_block_delta", { type: "content_block_delta", index, delta }),
      stop: (index) => emit("content_block_stop", { type: "content_block_stop", index }),
    },
  );
  let buffer = "";
  let terminal = false;
  // The client left (signal) or the consumer cancelled the body: publish nothing more.
  let dropFrames = false;
  let consumerCancelled = false;
  let closed = false;
  let waiting = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const end = (failure?: AnthropicTerminalFailure, reason?: unknown): void => {
    if (terminal) return;
    terminal = true;
    runCleanupSteps(
      () => {
        if (pingTimer !== undefined) clearInterval(pingTimer);
        pingTimer = undefined;
      },
      () => options.signals.deadline.removeEventListener("abort", onDeadline),
      () => options.signals.client.removeEventListener("abort", onClient),
      () => {
        if (dropFrames) frames.length = 0;
        else if (failure !== undefined) {
          frames.push(textEncoder.encode(anthropicStreamError(failure.message, failure.type)));
        }
      },
      options.finalize,
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const onDeadline = (): void => {
    end(
      toAnthropicFailure(streamFailure("request_deadline_exceeded")),
      options.signals.deadline.reason,
    );
  };
  const onClient = (): void => {
    dropFrames = true;
    end(undefined, options.signals.client.reason);
    if (!waiting && controllerRef !== undefined) flush(controllerRef);
  };
  const accept = (line: string): void => {
    const event = parseCanonicalOutputEventV2Line(line);
    if (event === undefined) throw protocolError("Malformed upstream stream");
    encoder.push(event);
    const done = encoder.terminal;
    if (done === undefined) return;
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: done.stopReason, stop_sequence: null },
      usage: hostedUsage(done),
      ...codeReferenceMetadata(done.codeReferences),
      ...(options.contextManagementRequested ? { context_management: { applied_edits: [] } } : {}),
    });
    emit("message_stop", { type: "message_stop" });
    end();
  };
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (consumerCancelled || closed) return;
    for (const frame of frames.splice(0)) controller.enqueue(frame);
    if (!terminal) return;
    closed = true;
    controller.close();
  };

  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controllerRef = controller;
          emit("message_start", {
            type: "message_start",
            message: {
              id: `msg_${randomUUID()}`,
              type: "message",
              role: "assistant",
              model: options.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: options.inputTokens,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          });
          options.signals.deadline.addEventListener("abort", onDeadline, { once: true });
          options.signals.client.addEventListener("abort", onClient, { once: true });
          // A search or a later generation can take a while; keep the client
          // connection alive only while the stream waits on the pipeline.
          pingTimer = setInterval(() => {
            if (terminal || !waiting || controllerRef === undefined || consumerCancelled) return;
            controllerRef.enqueue(textEncoder.encode(formatEvent("ping", { type: "ping" })));
          }, options.pingIntervalMs ?? 15_000);
          if (options.pingIntervalMs === undefined) pingTimer.unref?.();
          if (options.signals.deadline.aborted) onDeadline();
          else if (options.signals.client.aborted) onClient();
        },
        async pull(controller) {
          try {
            while (frames.length === 0 && !terminal) {
              const newline = buffer.indexOf("\n");
              if (newline >= 0) {
                const line = buffer.slice(0, newline).trimEnd();
                buffer = buffer.slice(newline + 1);
                if (line.length > 0) accept(line);
                continue;
              }
              waiting = true;
              const next = await reader.read();
              waiting = false;
              if (terminal) break;
              if (!next.done) {
                buffer += decoder.decode(next.value, { stream: true });
                continue;
              }
              buffer += decoder.decode();
              const finalLine = buffer.trim();
              buffer = "";
              if (finalLine.length > 0) accept(finalLine);
              if (!terminal) end(toAnthropicFailure(streamFailure("upstream_stream_incomplete")));
            }
          } catch (error) {
            waiting = false;
            if (!terminal) {
              const failure =
                error instanceof HostedOutputError
                  ? streamFailure(error.code, error.message)
                  : normalizeStreamFailure(error);
              end(toAnthropicFailure(failure), error);
            }
          }
          flush(controller);
        },
        cancel(reason) {
          consumerCancelled = true;
          dropFrames = true;
          end(undefined, reason);
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream; charset=utf-8",
        "x-kiro-token-count-mode": "estimate",
        ...compatibilityHeaders(options),
      },
    },
  );
}
