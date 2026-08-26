import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  type ChatWireCompletion,
  type ChatWireDelta,
  type ChatWireUsage,
  parseChatWireChunk,
} from "../chat-wire.js";
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

function usagePayload(usage: ChatWireUsage): Readonly<Record<string, number>> {
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
  completion: ChatWireCompletion,
  model: string,
): Response {
  const content: Array<Readonly<Record<string, unknown>>> = [];
  if (completion.message.reasoningRedactedContent) {
    content.push({
      type: "redacted_thinking",
      data: completion.message.reasoningRedactedContent,
    });
  } else if (
    completion.message.reasoningContent &&
    completion.message.reasoningSignature
  ) {
    content.push({
      type: "thinking",
      thinking: completion.message.reasoningContent,
      signature: completion.message.reasoningSignature,
    });
  }
  if (completion.message.content.length > 0) {
    content.push({ type: "text", text: completion.message.content });
  }
  for (const toolCall of completion.message.toolCalls) {
    const input = parseToolInput(toolCall.arguments);
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
    stop_reason: completion.message.toolCalls.length > 0 ? "tool_use" : "end_turn",
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
  const addDelta = (delta: ChatWireDelta): boolean => {
    switch (delta.kind) {
      case "empty":
        return false;
      case "reasoning": {
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
          delta: { type: "thinking_delta", thinking: delta.text },
        });
        return true;
      }
      case "reasoning_signature":
        if (reasoningStarted && !reasoningStopped && reasoningIndex !== undefined) {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: reasoningIndex,
            delta: { type: "signature_delta", signature: delta.signature },
          });
        } else {
          deferredReasoningSignature = delta.signature;
        }
        return false;
      case "reasoning_redacted": {
        if (reasoningStarted) {
          failProtocol("Upstream mixed visible and redacted reasoning payloads");
          return false;
        }
        const index = nextContentIndex;
        nextContentIndex += 1;
        emit("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "redacted_thinking", data: delta.data },
        });
        emit("content_block_stop", { type: "content_block_stop", index });
        return true;
      }
      case "reasoning_encrypted":
        return false;
      case "text": {
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
          delta: { type: "text_delta", text: delta.text },
        });
        return true;
      }
      case "tool_calls": {
        stopReasoning();
        for (const fragment of delta.calls) {
          const tool = tools.get(fragment.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (tool.id.length === 0 && fragment.id !== undefined) tool.id = fragment.id;
          if (tool.name.length === 0 && fragment.name !== undefined) tool.name = fragment.name;
          tool.arguments += fragment.arguments;
          tools.set(fragment.index, tool);
        }
        return false;
      }
    }
  };
  const complete = (usage: ChatWireUsage): void => {
    const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
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
              const parsed = parseChatWireChunk(line);
              if (!parsed) {
                failProtocol("Malformed upstream stream");
                return;
              }
              const emitted = addDelta(parsed.delta);
              if (parsed.finishReason !== null) {
                if (!parsed.usage) {
                  failProtocol("Terminal upstream chunk omitted usage");
                  return;
                }
                complete(parsed.usage);
                return;
              }
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
              const parsed = parseChatWireChunk(finalLine);
              if (!parsed) {
                failProtocol("Malformed upstream stream");
                return;
              }
              addDelta(parsed.delta);
              if (parsed.finishReason !== null && parsed.usage) {
                complete(parsed.usage);
                return;
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
