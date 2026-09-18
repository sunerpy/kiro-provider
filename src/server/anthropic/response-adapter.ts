import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  normalizeStreamFailure,
  type StreamFailure,
  streamFailure,
} from "../../core/stream-error.js";
import { type CodeReference, codeReferenceMetadata } from "../../protocol/code-references.js";
import {
  type CanonicalCompletion,
  type CanonicalOutputEvent,
  type CanonicalOutputUsage,
  parseCanonicalOutputEventLine,
} from "../../protocol/output.js";
import { isProviderReplayToken } from "../../reasoning/replay-token.js";
import type { IngressSignals } from "../request-lifecycle.js";
import {
  couldStillBeGpt56ReasoningPlaceholder,
  isGpt56Model,
  isGpt56ReasoningPlaceholder,
} from "../responses/reasoning.js";
import { anthropicError, anthropicStreamError } from "./errors.js";

export type AnthropicCompatibilityOptions = {
  readonly thinkingDisplay?: "omitted" | "summarized";
  readonly contextManagementRequested?: boolean;
  readonly cacheControlObserved?: boolean;
  readonly promptCacheMode?: "server-auto" | "explicit-checkpoints" | "off";
  readonly outputTokenLimitMode?: "advisory";
  readonly reasoningReplayMode?: "conflict-omitted";
  readonly toolResultImageMode?: "multiple-lifted";
};

type AdapterOptions = AnthropicCompatibilityOptions & {
  readonly model: string;
  readonly inputTokens: number;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
  readonly pingIntervalMs?: number;
};

type AdapterOutcome =
  | "normal-complete"
  | "deadline"
  | "client-abort"
  | "consumer-cancel"
  | "upstream-error"
  | "upstream-protocol-error";

type ToolAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

type AnthropicTerminalFailure = {
  readonly message: string;
  readonly type: "api_error" | "overloaded_error";
};

function toAnthropicFailure(
  failure: StreamFailure,
  message = failure.message,
): AnthropicTerminalFailure {
  return {
    message,
    type: failure.disposition === "retryable" ? "overloaded_error" : "api_error",
  };
}

function formatEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function usagePayload(usage: CanonicalOutputUsage): Readonly<Record<string, number | null>> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.reported?.cacheWriteInputTokens ?? null,
    cache_read_input_tokens: usage.reported?.cacheReadInputTokens ?? null,
  };
}

function compatibilityHeaders(
  options: AnthropicCompatibilityOptions,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (options.cacheControlObserved) {
    headers["x-kiro-prompt-cache-mode"] = options.promptCacheMode ?? "server-auto";
  }
  if (options.outputTokenLimitMode === "advisory") {
    headers["x-kiro-output-token-limit-mode"] = "advisory-unenforced";
  }
  if (options.reasoningReplayMode === "conflict-omitted") {
    headers["x-kiro-reasoning-replay-mode"] = "conflict-omitted";
  }
  if (options.toolResultImageMode === "multiple-lifted") {
    headers["x-kiro-tool-result-image-mode"] = "multiple-lifted";
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
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

function zeroBufferedStream(source: Bun.UnderlyingSource<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(source, { highWaterMark: 0 });
}

export function anthropicMessageResponse(
  completion: CanonicalCompletion,
  model: string,
  options: AnthropicCompatibilityOptions = {},
): Response {
  const content: Array<Readonly<Record<string, unknown>>> = [];
  const reasoning = completion.reasoning;
  if (
    reasoning?.redactedContent !== undefined &&
    (reasoning.text !== undefined || reasoning.signature !== undefined)
  ) {
    return anthropicError(
      502,
      "Upstream mixed visible and redacted reasoning payloads",
      "api_error",
    );
  }
  if (reasoning?.redactedContent !== undefined) {
    content.push({
      type: "redacted_thinking",
      data: reasoning.redactedContent,
    });
  } else if (reasoning?.text !== undefined || reasoning?.signature !== undefined) {
    const opaquePlaceholder =
      reasoning.text !== undefined && isGpt56ReasoningPlaceholder(model, reasoning.text);
    if (opaquePlaceholder) {
      const replaySignature =
        options.thinkingDisplay === "omitted" &&
        reasoning.encryptedContent &&
        isProviderReplayToken(reasoning.encryptedContent)
          ? reasoning.encryptedContent
          : reasoning.signature;
      if (!replaySignature) {
        return anthropicError(
          502,
          "Upstream placeholder thinking is missing its native signature",
          "api_error",
        );
      }
      content.push({ type: "thinking", thinking: "", signature: replaySignature });
    } else if (options.thinkingDisplay === "omitted") {
      if (
        !reasoning.signature ||
        !reasoning.encryptedContent ||
        !isProviderReplayToken(reasoning.encryptedContent)
      ) {
        return anthropicError(
          502,
          "Upstream omitted thinking cannot be replayed without a provider token",
          "api_error",
        );
      }
      content.push({
        type: "thinking",
        thinking: "",
        signature: reasoning.encryptedContent,
      });
    } else {
      if (reasoning.text === undefined || !reasoning.signature) {
        return anthropicError(
          502,
          "Upstream returned incomplete signed reasoning metadata",
          "api_error",
        );
      }
      content.push({
        type: "thinking",
        thinking: reasoning.text,
        signature: reasoning.signature,
      });
    }
  }
  if (completion.text.length > 0) {
    content.push({ type: "text", text: completion.text });
  }
  for (const toolCall of completion.toolCalls) {
    const input = parseToolInput(toolCall.input);
    if (!input) {
      return anthropicError(
        502,
        `Upstream returned invalid JSON arguments for tool ${toolCall.name}`,
        "api_error",
      );
    }
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input,
    });
  }
  return Response.json(
    {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: completion.finishReason === "tool_calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: usagePayload(completion.usage),
      ...codeReferenceMetadata(completion.codeReferences),
      ...(options.contextManagementRequested ? { context_management: { applied_edits: [] } } : {}),
    },
    { headers: compatibilityHeaders(options) },
  );
}

// allow: SIZE_OK — this state machine owns Anthropic SSE ordering and exactly-once cleanup.
export function anthropicSseAdapter(pipelineResponse: Response, options: AdapterOptions): Response {
  const upstream =
    pipelineResponse.body ??
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    });
  const reader = upstream.getReader();
  type UpstreamReadOutcome =
    | { readonly kind: "value"; readonly next: Awaited<ReturnType<typeof reader.read>> }
    | { readonly kind: "error"; readonly error: unknown };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_${randomUUID()}`;
  const tools = new Map<number, ToolAccumulator>();
  const pendingFrames: Uint8Array[] = [];
  let buffer = "";
  let nextContentIndex = 0;
  let textIndex: number | undefined;
  let reasoningIndex: number | undefined;
  let reasoningStarted = false;
  let reasoningStopped = false;
  let reasoningSigned = false;
  let pendingReasoningText = "";
  // Distinguishes an explicit empty canonical thinking marker from no reasoning.
  let pendingReasoningSeen = false;
  let opaquePlaceholderSeen = false;
  let omittedReasoningSeen = false;
  let hiddenReplayToken: string | undefined;
  // A signature that has not been written into an open thinking block yet.
  let pendingSignature: string | undefined;
  // Visible reasoning that arrived after text started; it becomes a new block
  // in complete() so no delta ever targets a stopped block.
  let deferredReasoningText = "";
  // Omitted-thinking replay tokens arrive only after the assistant output is
  // complete, so text is buffered once omitted reasoning is known.
  let deferredText = "";
  // Redacted envelopes that arrived while a text block was open.
  const deferredRedacted: string[] = [];
  let redactedEmitted = false;
  let textStarted = false;
  let textStopped = false;
  let canonicalStarted = false;
  let canonicalCompleted = false;
  let terminalOutcome: AdapterOutcome | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pullInProgress = false;
  let upstreamReadInProgress = false;
  let upstreamReadOutcome: UpstreamReadOutcome | undefined;
  let pendingPullWake: "upstream" | "ping" | undefined;
  let wakePendingPull: (() => void) | undefined;

  const emit = (event: string, payload: unknown): void => {
    pendingFrames.push(encoder.encode(formatEvent(event, payload)));
  };
  const closeIfDrained = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (
      streamClosed ||
      terminalOutcome === undefined ||
      terminalOutcome === "consumer-cancel" ||
      pendingFrames.length > 0
    ) {
      return;
    }
    streamClosed = true;
    controller.close();
  };
  // One frame per pull. With a zero high-water mark, an active pull is the
  // demand signal even though desiredSize is 0; a negative size is exhausted.
  const flushOne = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (streamClosed) return false;
    const desiredSize = controller.desiredSize;
    if (
      pendingFrames.length > 0 &&
      desiredSize !== null &&
      (desiredSize > 0 || (pullInProgress && desiredSize === 0))
    ) {
      const frame = pendingFrames.shift();
      if (!frame) return false;
      controller.enqueue(frame);
      closeIfDrained(controller);
      return true;
    }
    closeIfDrained(controller);
    return false;
  };
  const wakePull = (reason: "upstream" | "ping"): void => {
    if (!pullInProgress || wakePendingPull === undefined) return;
    pendingPullWake = reason;
    const wake = wakePendingPull;
    wakePendingPull = undefined;
    wake();
  };
  const startUpstreamRead = (): void => {
    if (upstreamReadInProgress || upstreamReadOutcome !== undefined) return;
    upstreamReadInProgress = true;
    void reader.read().then(
      (next) => {
        upstreamReadInProgress = false;
        upstreamReadOutcome = { kind: "value", next };
        wakePull("upstream");
      },
      (error: unknown) => {
        upstreamReadInProgress = false;
        upstreamReadOutcome = { kind: "error", error };
        wakePull("upstream");
      },
    );
  };
  const claimTerminal = (outcome: AdapterOutcome): boolean => {
    if (terminalOutcome !== undefined) return false;
    terminalOutcome = outcome;
    return true;
  };
  const removeDeadlineListener = (): void => {
    options.signals.deadline.removeEventListener("abort", onDeadlineAbort);
  };
  const removeClientListener = (): void => {
    options.signals.client.removeEventListener("abort", onClientAbort);
  };
  const clearPingTimer = (): void => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  };
  const beginTerminal = (
    outcome: AdapterOutcome,
    reason?: unknown,
    failure?: AnthropicTerminalFailure,
  ): void => {
    if (!claimTerminal(outcome)) return;
    if (outcome === "consumer-cancel") pendingFrames.length = 0;
    runCleanupSteps(
      clearPingTimer,
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (!failure) return;
        pendingFrames.push(
          encoder.encode(anthropicStreamError(failure.message, failure.type ?? "api_error")),
        );
      },
      options.finalize,
      () => {
        if (streamController) flushOne(streamController);
      },
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const failProtocol = (message: string): void => {
    beginTerminal(
      "upstream-protocol-error",
      undefined,
      toAnthropicFailure(streamFailure("upstream_protocol_error"), message),
    );
  };
  // Same disposition as the non-stream 502: a thinking block that completes
  // without a signature cannot be replayed and must not be handed to clients.
  const failReasoning = (message: string): void => {
    beginTerminal(
      "upstream-protocol-error",
      undefined,
      toAnthropicFailure(streamFailure("invalid_upstream_reasoning"), message),
    );
  };
  const failIncomplete = (): void => {
    beginTerminal(
      "upstream-error",
      undefined,
      toAnthropicFailure(streamFailure("upstream_stream_incomplete")),
    );
  };
  const onDeadlineAbort = (): void => {
    const reason =
      options.signals.deadline.reason instanceof Error
        ? options.signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError");
    beginTerminal(
      "deadline",
      reason,
      toAnthropicFailure(streamFailure("request_deadline_exceeded")),
    );
  };
  const onClientAbort = (): void => {
    const reason =
      options.signals.client.reason instanceof Error
        ? options.signals.client.reason
        : new DOMException("Client closed request", "AbortError");
    beginTerminal("client-abort", reason);
  };
  const stopText = (): void => {
    if (!textStarted || textStopped || textIndex === undefined) return;
    textStopped = true;
    emit("content_block_stop", {
      type: "content_block_stop",
      index: textIndex,
    });
  };
  const emitText = (text: string): void => {
    if (!textStarted) {
      textIndex = nextContentIndex;
      nextContentIndex += 1;
      textStarted = true;
      emit("content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      });
    }
    if (textIndex === undefined || text.length === 0) return;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: textIndex,
      delta: { type: "text_delta", text },
    });
  };
  const stopReasoning = (): void => {
    if (!reasoningStarted || reasoningStopped || reasoningIndex === undefined) return;
    if (pendingSignature !== undefined) {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: reasoningIndex,
        delta: {
          type: "signature_delta",
          signature: pendingSignature,
        },
      });
      pendingSignature = undefined;
      reasoningSigned = true;
    }
    reasoningStopped = true;
    emit("content_block_stop", {
      type: "content_block_stop",
      index: reasoningIndex,
    });
  };
  const emitVisibleReasoning = (text: string): void => {
    if (!reasoningStarted) {
      reasoningIndex = nextContentIndex;
      nextContentIndex += 1;
      reasoningStarted = true;
      emit("content_block_start", {
        type: "content_block_start",
        index: reasoningIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    }
    if (text.length === 0 || reasoningIndex === undefined) return;
    emit("content_block_delta", {
      type: "content_block_delta",
      index: reasoningIndex,
      delta: { type: "thinking_delta", thinking: text },
    });
  };
  const emitOpaquePlaceholderSignature = (signature: string): void => {
    opaquePlaceholderSeen = true;
    pendingReasoningText = "";
    pendingReasoningSeen = false;
    emitVisibleReasoning("");
    if (reasoningIndex === undefined) {
      failReasoning("Upstream placeholder thinking could not allocate a block");
      return;
    }
    emit("content_block_delta", {
      type: "content_block_delta",
      index: reasoningIndex,
      delta: { type: "signature_delta", signature },
    });
    reasoningSigned = true;
  };
  const flushPendingReasoning = (): boolean => {
    if (!pendingReasoningSeen) return true;
    if (isGpt56ReasoningPlaceholder(options.model, pendingReasoningText)) {
      pendingReasoningText = "";
      pendingReasoningSeen = false;
      failReasoning("Upstream placeholder thinking is missing its native signature");
      return false;
    }
    const text = pendingReasoningText;
    pendingReasoningText = "";
    pendingReasoningSeen = false;
    emitVisibleReasoning(text);
    return true;
  };
  const emitHiddenReplayBlock = (token: string): void => {
    const index = nextContentIndex;
    nextContentIndex += 1;
    emit("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    emit("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "signature_delta", signature: token },
    });
    emit("content_block_stop", { type: "content_block_stop", index });
  };
  const visibleReasoningSeen = (): boolean =>
    reasoningStarted ||
    pendingReasoningSeen ||
    opaquePlaceholderSeen ||
    omittedReasoningSeen ||
    pendingSignature !== undefined ||
    deferredReasoningText.length > 0;
  const emitRedactedBlock = (data: string): void => {
    const index = nextContentIndex;
    nextContentIndex += 1;
    emit("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "redacted_thinking", data },
    });
    emit("content_block_stop", { type: "content_block_stop", index });
    redactedEmitted = true;
  };
  const addEvent = (event: CanonicalOutputEvent): void => {
    switch (event.type) {
      case "started":
      case "completed":
        return;
      case "reasoning_delta": {
        if (redactedEmitted || deferredRedacted.length > 0) {
          failProtocol("Upstream mixed visible and redacted reasoning payloads");
          return;
        }
        if (textStarted && isGpt56Model(options.model)) {
          stopText();
          failReasoning("Upstream emitted GPT reasoning after assistant text");
          return;
        }
        if (options.thinkingDisplay === "omitted" && isGpt56Model(options.model)) {
          pendingReasoningSeen = true;
          pendingReasoningText += event.text;
          if (couldStillBeGpt56ReasoningPlaceholder(options.model, pendingReasoningText)) return;
          pendingReasoningText = "";
          pendingReasoningSeen = false;
          omittedReasoningSeen = true;
          return;
        }
        if (options.thinkingDisplay === "omitted") {
          omittedReasoningSeen = true;
          return;
        }
        if (reasoningStopped || textStarted) {
          deferredReasoningText += event.text;
          return;
        }
        if (!reasoningStarted && isGpt56Model(options.model)) {
          pendingReasoningSeen = true;
          pendingReasoningText += event.text;
          if (couldStillBeGpt56ReasoningPlaceholder(options.model, pendingReasoningText)) return;
          if (!flushPendingReasoning()) return;
          return;
        }
        emitVisibleReasoning(event.text);
        return;
      }
      case "reasoning_signature":
        if (opaquePlaceholderSeen) {
          if (!reasoningSigned) emitOpaquePlaceholderSignature(event.signature);
          return;
        }
        if (pendingReasoningSeen) {
          if (isGpt56ReasoningPlaceholder(options.model, pendingReasoningText)) {
            if (options.thinkingDisplay === "omitted") {
              pendingReasoningText = "";
              pendingReasoningSeen = false;
              opaquePlaceholderSeen = true;
              omittedReasoningSeen = true;
            } else {
              emitOpaquePlaceholderSignature(event.signature);
            }
            return;
          }
          if (options.thinkingDisplay === "omitted") {
            pendingReasoningText = "";
            pendingReasoningSeen = false;
            omittedReasoningSeen = true;
            return;
          }
          if (!flushPendingReasoning()) return;
        }
        if (options.thinkingDisplay === "omitted") {
          omittedReasoningSeen = true;
          return;
        }
        if (reasoningStarted && !reasoningStopped && reasoningIndex !== undefined) {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: reasoningIndex,
            delta: { type: "signature_delta", signature: event.signature },
          });
          reasoningSigned = true;
        } else {
          pendingSignature = event.signature;
        }
        return;
      case "reasoning_redacted": {
        if (visibleReasoningSeen()) {
          failProtocol("Upstream mixed visible and redacted reasoning payloads");
          return;
        }
        if (textStarted) {
          deferredRedacted.push(event.data);
          return;
        }
        emitRedactedBlock(event.data);
        return;
      }
      case "reasoning_encrypted":
        if (options.thinkingDisplay !== "omitted") return;
        if (redactedEmitted || deferredRedacted.length > 0) return;
        if (!isProviderReplayToken(event.encryptedContent)) {
          failReasoning("Upstream returned an invalid provider replay token");
          return;
        }
        hiddenReplayToken = event.encryptedContent;
        return;
      case "text_delta": {
        if (!flushPendingReasoning()) return;
        stopReasoning();
        if (omittedReasoningSeen) {
          deferredText += event.text;
          return;
        }
        emitText(event.text);
        return;
      }
      case "tool_call_delta": {
        const tool = tools.get(event.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (tool.id.length === 0 && event.id !== undefined) tool.id = event.id;
        if (tool.name.length === 0 && event.name !== undefined) tool.name = event.name;
        tool.arguments += event.arguments;
        tools.set(event.index, tool);
        return;
      }
    }
  };
  // Returns false when the deferred block had no signature to carry.
  const flushDeferredReasoning = (): boolean => {
    if (deferredReasoningText.length === 0) return true;
    const index = nextContentIndex;
    nextContentIndex += 1;
    emit("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    emit("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: deferredReasoningText },
    });
    deferredReasoningText = "";
    const signed = pendingSignature !== undefined;
    if (pendingSignature !== undefined) {
      emit("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: pendingSignature },
      });
      pendingSignature = undefined;
    }
    emit("content_block_stop", { type: "content_block_stop", index });
    return signed;
  };
  const complete = (
    usage: CanonicalOutputUsage,
    finishReason: "stop" | "tool_calls",
    codeReferences?: readonly CodeReference[],
  ): void => {
    const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
    const expectedFinishReason = orderedTools.length > 0 ? "tool_calls" : "stop";
    if (finishReason !== expectedFinishReason) {
      failProtocol("Upstream finish reason does not match its output");
      return;
    }
    const invalidTool = orderedTools.some(([, tool]) => {
      return tool.id.length === 0 || tool.name.length === 0 || !parseToolInput(tool.arguments);
    });
    if (invalidTool) {
      failProtocol("Malformed upstream tool call");
      return;
    }
    if (!flushPendingReasoning()) return;
    stopText();
    stopReasoning();
    const deferredSigned = flushDeferredReasoning();
    const hiddenReasoningSeen = omittedReasoningSeen;
    if (
      (hiddenReasoningSeen && hiddenReplayToken === undefined) ||
      (hiddenReasoningSeen && textStarted) ||
      (reasoningStarted && !reasoningSigned) ||
      !deferredSigned ||
      pendingSignature !== undefined
    ) {
      failReasoning("Upstream returned incomplete signed reasoning metadata");
      return;
    }
    if (hiddenReasoningSeen && hiddenReplayToken !== undefined) {
      emitHiddenReplayBlock(hiddenReplayToken);
    }
    if (deferredText.length > 0) {
      emitText(deferredText);
      deferredText = "";
      stopText();
    }
    for (const data of deferredRedacted) emitRedactedBlock(data);
    deferredRedacted.length = 0;
    for (const [, tool] of orderedTools) {
      const contentIndex = nextContentIndex;
      nextContentIndex += 1;
      emit("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: {
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: {},
        },
      });
      if (tool.arguments.length > 0) {
        emit("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: {
            type: "input_json_delta",
            partial_json: tool.arguments,
          },
        });
      }
      emit("content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
    }
    emit("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: orderedTools.length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: usagePayload(usage),
      ...codeReferenceMetadata(codeReferences),
      ...(options.contextManagementRequested ? { context_management: { applied_edits: [] } } : {}),
    });
    emit("message_stop", { type: "message_stop" });
    beginTerminal("normal-complete");
  };

  return new Response(
    zeroBufferedStream({
      start(controller) {
        streamController = controller;
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
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
        options.signals.deadline.addEventListener("abort", onDeadlineAbort, {
          once: true,
        });
        options.signals.client.addEventListener("abort", onClientAbort, {
          once: true,
        });
        const pingIntervalMs = options.pingIntervalMs ?? 15_000;
        pingTimer = setInterval(() => {
          if (
            terminalOutcome !== undefined ||
            pendingFrames.length > 0 ||
            !pullInProgress ||
            wakePendingPull === undefined
          )
            return;
          emit("ping", { type: "ping" });
          if (streamController && flushOne(streamController)) {
            wakePull("ping");
          } else {
            pendingFrames.pop();
          }
        }, pingIntervalMs);
        // Production keep-alives must not keep the process alive by themselves.
        // An explicit interval is a test clock, however: Bun on Windows may
        // starve an unref'ed timer when the only consumer is a pending stream
        // read, turning the keep-alive assertion into a job-wide hang.
        if (options.pingIntervalMs === undefined) pingTimer.unref?.();
        if (options.signals.deadline.aborted) onDeadlineAbort();
        else if (options.signals.client.aborted) onClientAbort();
        flushOne(controller);
      },
      async pull(controller) {
        pullInProgress = true;
        try {
          if (flushOne(controller)) return;
          if (terminalOutcome !== undefined) return;
          while (terminalOutcome === undefined) {
            const desiredSize = controller.desiredSize;
            if (desiredSize === null || desiredSize < 0) return;
            const newline = buffer.indexOf("\n");
            if (newline >= 0) {
              const line = buffer.slice(0, newline).trimEnd();
              buffer = buffer.slice(newline + 1);
              if (line.length === 0) continue;
              const event = parseCanonicalOutputEventLine(line);
              if (!event) {
                failProtocol("Malformed upstream stream");
                return;
              }
              if (event.type === "started") {
                if (canonicalStarted || canonicalCompleted || event.model !== options.model) {
                  failProtocol("Malformed upstream stream start");
                  return;
                }
                canonicalStarted = true;
                continue;
              }
              if (!canonicalStarted || canonicalCompleted) {
                failProtocol("Malformed upstream event ordering");
                return;
              }
              if (event.type === "completed") {
                canonicalCompleted = true;
                complete(event.usage, event.finishReason, event.codeReferences);
                return;
              }
              addEvent(event);
              if (terminalOutcome !== undefined) return;
              if (flushOne(controller)) return;
              continue;
            }
            if (upstreamReadOutcome === undefined) {
              startUpstreamRead();
              await new Promise<void>((resolve) => {
                wakePendingPull = resolve;
              });
              wakePendingPull = undefined;
              if (pendingPullWake === "ping") {
                pendingPullWake = undefined;
                return;
              }
              pendingPullWake = undefined;
            }
            const outcome = upstreamReadOutcome;
            upstreamReadOutcome = undefined;
            if (outcome === undefined) continue;
            if (outcome.kind === "error") throw outcome.error;
            const next = outcome.next;
            if (terminalOutcome !== undefined) return;
            if (!next.done) {
              buffer += decoder.decode(next.value, { stream: true });
              continue;
            }
            buffer += decoder.decode();
            const finalLine = buffer.trim();
            buffer = "";
            if (finalLine.length > 0) {
              const event = parseCanonicalOutputEventLine(finalLine);
              if (!event) {
                failProtocol("Malformed upstream stream");
                return;
              }
              if (event.type === "started") {
                if (canonicalStarted || canonicalCompleted || event.model !== options.model) {
                  failProtocol("Malformed upstream stream start");
                  return;
                }
                canonicalStarted = true;
              } else if (!canonicalStarted || canonicalCompleted) {
                failProtocol("Malformed upstream event ordering");
                return;
              } else if (event.type === "completed") {
                canonicalCompleted = true;
                complete(event.usage, event.finishReason, event.codeReferences);
                return;
              } else {
                addEvent(event);
                if (terminalOutcome !== undefined) return;
              }
            }
            failIncomplete();
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          const failure = normalizeStreamFailure(error);
          beginTerminal(
            failure.disposition === "fatal" ? "upstream-protocol-error" : "upstream-error",
            error,
            toAnthropicFailure(failure),
          );
        } finally {
          wakePendingPull = undefined;
          pendingPullWake = undefined;
          pullInProgress = false;
        }
      },
      cancel(reason) {
        beginTerminal("consumer-cancel", reason);
      },
    }),
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
