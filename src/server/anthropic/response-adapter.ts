import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  type CanonicalCompletion,
  type CanonicalOutputEvent,
  type CanonicalOutputUsage,
  parseCanonicalOutputEventLine,
} from "../../protocol/output.js";
import type { IngressSignals } from "../request-lifecycle.js";
import { anthropicError, anthropicStreamError } from "./errors.js";

type AdapterOptions = {
  readonly model: string;
  readonly inputTokens: number;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
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

function formatEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function usagePayload(usage: CanonicalOutputUsage): Readonly<Record<string, number>> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
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

export function anthropicMessageResponse(
  completion: CanonicalCompletion,
  model: string,
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
    if (!reasoning.text || !reasoning.signature) {
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
  return Response.json({
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: completion.finishReason === "tool_calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usagePayload(completion.usage),
  });
}

// allow: SIZE_OK — this state machine owns Anthropic SSE ordering and exactly-once cleanup.
export function anthropicSseAdapter(
  pipelineResponse: Response,
  options: AdapterOptions,
): Response {
  const upstream =
    pipelineResponse.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_${randomUUID()}`;
  const tools = new Map<number, ToolAccumulator>();
  let buffer = "";
  let nextContentIndex = 0;
  let textIndex: number | undefined;
  let reasoningIndex: number | undefined;
  let reasoningStarted = false;
  let reasoningStopped = false;
  let deferredReasoningSignature: string | undefined;
  let textStarted = false;
  let canonicalStarted = false;
  let canonicalCompleted = false;
  let textStopped = false;
  let terminalOutcome: AdapterOutcome | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const emit = (event: string, payload: unknown): void => {
    streamController?.enqueue(encoder.encode(formatEvent(event, payload)));
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
  const beginTerminal = (
    outcome: AdapterOutcome,
    reason?: unknown,
    failure?: { readonly message: string; readonly type?: "api_error" | "overloaded_error" },
  ): void => {
    if (!claimTerminal(outcome)) return;
    runCleanupSteps(
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (!failure || !streamController) return;
        streamController.enqueue(
          encoder.encode(
            anthropicStreamError(failure.message, failure.type ?? "api_error"),
          ),
        );
      },
      () => {
        if (outcome !== "consumer-cancel") streamController?.close();
      },
      options.finalize,
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const failProtocol = (message: string): void => {
    beginTerminal("upstream-protocol-error", undefined, { message });
  };
  const onDeadlineAbort = (): void => {
    const reason =
      options.signals.deadline.reason instanceof Error
        ? options.signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError");
    beginTerminal("deadline", reason, { message: "Request deadline exceeded" });
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
  const stopReasoning = (): void => {
    if (!reasoningStarted || reasoningStopped || reasoningIndex === undefined) return;
    if (deferredReasoningSignature !== undefined) {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: reasoningIndex,
        delta: {
          type: "signature_delta",
          signature: deferredReasoningSignature,
        },
      });
      deferredReasoningSignature = undefined;
    }
    reasoningStopped = true;
    emit("content_block_stop", {
      type: "content_block_stop",
      index: reasoningIndex,
    });
  };
  const addEvent = (event: CanonicalOutputEvent): boolean => {
    switch (event.type) {
      case "started":
      case "completed":
        return false;
      case "reasoning_delta": {
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
        emit("content_block_delta", {
          type: "content_block_delta",
          index: reasoningIndex,
          delta: { type: "thinking_delta", thinking: event.text },
        });
        return true;
      }
      case "reasoning_signature":
        if (reasoningStarted && !reasoningStopped && reasoningIndex !== undefined) {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: reasoningIndex,
            delta: { type: "signature_delta", signature: event.signature },
          });
        } else {
          deferredReasoningSignature = event.signature;
        }
        return false;
      case "reasoning_redacted": {
        if (reasoningStarted || deferredReasoningSignature !== undefined) {
          failProtocol("Upstream mixed visible and redacted reasoning payloads");
          return false;
        }
        const index = nextContentIndex;
        nextContentIndex += 1;
        emit("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "redacted_thinking", data: event.data },
        });
        emit("content_block_stop", { type: "content_block_stop", index });
        return true;
      }
      case "reasoning_encrypted":
        return false;
      case "text_delta": {
        stopReasoning();
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
        emit("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: event.text },
        });
        return true;
      }
      case "tool_call_delta": {
        stopReasoning();
        const tool = tools.get(event.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (tool.id.length === 0 && event.id !== undefined) tool.id = event.id;
        if (tool.name.length === 0 && event.name !== undefined) tool.name = event.name;
        tool.arguments += event.arguments;
        tools.set(event.index, tool);
        return false;
      }
    }
  };
  const complete = (
    usage: CanonicalOutputUsage,
    finishReason: "stop" | "tool_calls",
  ): void => {
    const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
    const expectedFinishReason = orderedTools.length > 0 ? "tool_calls" : "stop";
    if (finishReason !== expectedFinishReason) {
      failProtocol("Upstream finish reason does not match its output");
      return;
    }
    const invalidTool = orderedTools.some(([, tool]) => {
      return (
        tool.id.length === 0 ||
        tool.name.length === 0 ||
        !parseToolInput(tool.arguments)
      );
    });
    if (invalidTool) {
      failProtocol("Malformed upstream tool call");
      return;
    }
    stopText();
    stopReasoning();
    for (const [, tool] of orderedTools) {
      const contentIndex = nextContentIndex;
      nextContentIndex += 1;
      const input = parseToolInput(tool.arguments);
      if (
        !input ||
        tool.id.length === 0 ||
        tool.name.length === 0
      ) {
        failProtocol("Malformed upstream tool call");
        return;
      }
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
      usage: { output_tokens: usage.outputTokens },
    });
    emit("message_stop", { type: "message_stop" });
    beginTerminal("normal-complete");
  };

  return new Response(
    new ReadableStream<Uint8Array>({
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
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });
        options.signals.deadline.addEventListener("abort", onDeadlineAbort, {
          once: true,
        });
        options.signals.client.addEventListener("abort", onClientAbort, {
          once: true,
        });
        if (options.signals.deadline.aborted) onDeadlineAbort();
        else if (options.signals.client.aborted) onClientAbort();
      },
      async pull() {
        if (terminalOutcome !== undefined) return;
        try {
          while (terminalOutcome === undefined) {
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
                if (
                  canonicalStarted ||
                  canonicalCompleted ||
                  event.model !== options.model
                ) {
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
                complete(event.usage, event.finishReason);
                return;
              }
              const emitted = addEvent(event);
              if (terminalOutcome !== undefined) return;
              if (emitted) return;
              continue;
            }
            const next = await reader.read();
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
                if (
                  canonicalStarted ||
                  canonicalCompleted ||
                  event.model !== options.model
                ) {
                  failProtocol("Malformed upstream stream start");
                  return;
                }
                canonicalStarted = true;
              } else if (!canonicalStarted || canonicalCompleted) {
                failProtocol("Malformed upstream event ordering");
                return;
              } else if (event.type === "completed") {
                canonicalCompleted = true;
                complete(event.usage, event.finishReason);
                return;
              } else {
                addEvent(event);
                if (terminalOutcome !== undefined) return;
              }
            }
            failProtocol("Upstream stream ended before completion");
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          beginTerminal("upstream-error", error, {
            message: "Upstream stream error",
          });
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
      },
    },
  );
}
