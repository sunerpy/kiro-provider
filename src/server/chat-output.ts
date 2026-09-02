import { boundedCleanup, runCleanupSteps } from "../core/stream-cleanup.js";
import { normalizeStreamFailure, type StreamFailure, streamFailure } from "../core/stream-error.js";
import {
  type CanonicalCompletion,
  type CanonicalOutputEvent,
  parseCanonicalOutputEventLine,
} from "../protocol/output.js";
import type { IngressSignals } from "./request-lifecycle.js";

type ChatAdapterOutcome =
  | "normal-complete"
  | "deadline"
  | "client-abort"
  | "consumer-cancel"
  | "upstream-error"
  | "upstream-protocol-error";

interface ChatStreamIdentity {
  readonly id: string;
  readonly model: string;
  readonly created: number;
}

interface ChatToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatOutputOptions {
  readonly expectedModel: string;
  readonly includeUsage?: boolean;
}

function chatChunk(
  identity: ChatStreamIdentity,
  delta: Readonly<Record<string, unknown>>,
  finishReason: "stop" | "tool_calls" | null,
): Readonly<Record<string, unknown>> {
  return {
    id: identity.id,
    object: "chat.completion.chunk",
    created: identity.created,
    model: identity.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function eventFrames(
  event: Exclude<CanonicalOutputEvent, { readonly type: "started" }>,
  identity: ChatStreamIdentity,
  includeUsage: boolean,
): readonly string[] {
  switch (event.type) {
    case "text_delta":
      return [JSON.stringify(chatChunk(identity, { content: event.text }, null))];
    case "reasoning_delta":
      return [JSON.stringify(chatChunk(identity, { reasoning_content: event.text }, null))];
    case "reasoning_signature":
      return [JSON.stringify(chatChunk(identity, { reasoning_signature: event.signature }, null))];
    case "reasoning_redacted":
      return [
        JSON.stringify(chatChunk(identity, { reasoning_redacted_content: event.data }, null)),
      ];
    case "reasoning_encrypted":
      return [
        JSON.stringify(
          chatChunk(identity, { reasoning_encrypted_content: event.encryptedContent }, null),
        ),
      ];
    case "tool_call_delta":
      return [
        JSON.stringify(
          chatChunk(
            identity,
            {
              tool_calls: [
                {
                  index: event.index,
                  ...(event.id !== undefined ? { id: event.id, type: "function" } : {}),
                  function: {
                    ...(event.name !== undefined ? { name: event.name } : {}),
                    arguments: event.arguments,
                  },
                },
              ],
            },
            null,
          ),
        ),
      ];
    case "completed": {
      const finish = JSON.stringify(chatChunk(identity, {}, event.finishReason));
      if (!includeUsage) return [finish];
      const usage = {
        id: identity.id,
        object: "chat.completion.chunk",
        created: identity.created,
        model: identity.model,
        choices: [],
        usage: {
          prompt_tokens: event.usage.inputTokens,
          completion_tokens: event.usage.outputTokens,
          total_tokens: event.usage.totalTokens,
        },
      };
      return [finish, JSON.stringify(usage)];
    }
  }
}

export function canonicalCompletionToChat(completion: CanonicalCompletion): Response {
  const reasoning = completion.reasoning;
  return Response.json({
    id: completion.conversationId,
    object: "chat.completion",
    created: completion.createdAt,
    model: completion.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // OpenAI returns `content: null` for a tool-call-only assistant turn.
          content:
            completion.text.length === 0 && completion.toolCalls.length > 0
              ? null
              : completion.text,
          ...(reasoning?.text ? { reasoning_content: reasoning.text } : {}),
          ...(reasoning?.signature ? { reasoning_signature: reasoning.signature } : {}),
          ...(reasoning?.redactedContent
            ? { reasoning_redacted_content: reasoning.redactedContent }
            : {}),
          ...(reasoning?.encryptedContent
            ? { reasoning_encrypted_content: reasoning.encryptedContent }
            : {}),
          ...(completion.toolCalls.length > 0
            ? {
                tool_calls: completion.toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  type: "function",
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.input,
                  },
                })),
              }
            : {}),
        },
        finish_reason: completion.finishReason,
      },
    ],
    usage: {
      prompt_tokens: completion.usage.inputTokens,
      completion_tokens: completion.usage.outputTokens,
      total_tokens: completion.usage.totalTokens,
    },
  });
}

export function canonicalOutputToChatSse(
  response: Response,
  signals: IngressSignals,
  finalize: () => void,
  options: ChatOutputOptions,
): Response {
  const includeUsage = options.includeUsage === true;
  const upstream =
    response.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pendingFrames: Uint8Array[] = [];
  const tools = new Map<number, ChatToolAccumulator>();
  let buffer = "";
  let identity: ChatStreamIdentity | undefined;
  let completed = false;
  let terminalOutcome: ChatAdapterOutcome | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;

  const enqueueFrame = (frame: string): void => {
    pendingFrames.push(encoder.encode(`data: ${frame}\n\n`));
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
  const flushOne = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (streamClosed || pendingFrames.length === 0) {
      closeIfDrained(controller);
      return false;
    }
    const desiredSize = controller.desiredSize;
    if (desiredSize === null || desiredSize <= 0) return false;
    const frame = pendingFrames.shift();
    if (!frame) return false;
    controller.enqueue(frame);
    closeIfDrained(controller);
    return true;
  };
  const claimTerminal = (outcome: ChatAdapterOutcome): boolean => {
    if (terminalOutcome !== undefined) return false;
    terminalOutcome = outcome;
    return true;
  };
  const removeDeadlineListener = (): void => {
    signals.deadline.removeEventListener("abort", onDeadlineAbort);
  };
  const removeClientListener = (): void => {
    signals.client.removeEventListener("abort", onClientAbort);
  };
  const beginTerminal = (
    outcome: ChatAdapterOutcome,
    reason?: unknown,
    explicitFailure?: StreamFailure,
  ): void => {
    if (!claimTerminal(outcome)) return;
    if (outcome === "consumer-cancel") pendingFrames.length = 0;
    runCleanupSteps(
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (outcome === "normal-complete") {
          enqueueFrame("[DONE]");
        } else if (
          outcome === "deadline" ||
          outcome === "upstream-error" ||
          outcome === "upstream-protocol-error"
        ) {
          const failure =
            explicitFailure ??
            (outcome === "deadline"
              ? streamFailure("request_deadline_exceeded")
              : outcome === "upstream-protocol-error"
                ? streamFailure("upstream_protocol_error")
                : normalizeStreamFailure(reason));
          enqueueFrame(
            JSON.stringify({
              error: {
                message: failure.message,
                type:
                  failure.disposition === "fatal" ? "upstream_protocol_error" : "upstream_error",
                code: failure.code,
              },
            }),
          );
        }
      },
      finalize,
      () => {
        if (streamController) flushOne(streamController);
      },
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const onDeadlineAbort = (): void => {
    beginTerminal(
      "deadline",
      signals.deadline.reason instanceof Error
        ? signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError"),
    );
  };
  const onClientAbort = (): void => {
    beginTerminal(
      "client-abort",
      signals.client.reason instanceof Error
        ? signals.client.reason
        : new DOMException("Client closed request", "AbortError"),
    );
  };
  const failProtocol = (): void => {
    beginTerminal("upstream-protocol-error", undefined, streamFailure("upstream_protocol_error"));
  };
  const failIncomplete = (): void => {
    beginTerminal("upstream-error", undefined, streamFailure("upstream_stream_incomplete"));
  };
  const acceptEvent = (event: CanonicalOutputEvent): boolean => {
    if (event.type === "started") {
      if (identity !== undefined || completed || event.model !== options.expectedModel)
        return false;
      identity = {
        id: event.conversationId,
        model: event.model,
        created: event.createdAt,
      };
      return true;
    }
    if (!identity || completed) return false;
    if (event.type === "tool_call_delta") {
      const tool = tools.get(event.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (
        (event.id !== undefined && tool.id.length > 0 && event.id !== tool.id) ||
        (event.name !== undefined && tool.name.length > 0 && event.name !== tool.name)
      ) {
        return false;
      }
      if (event.id !== undefined) tool.id = event.id;
      if (event.name !== undefined) tool.name = event.name;
      tool.arguments += event.arguments;
      tools.set(event.index, tool);
    }
    if (event.type === "completed") {
      const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
      const expectedFinishReason = orderedTools.length > 0 ? "tool_calls" : "stop";
      if (
        event.finishReason !== expectedFinishReason ||
        orderedTools.some(
          ([index, tool], ordinal) =>
            index !== ordinal || tool.id.length === 0 || tool.name.length === 0,
        ) ||
        new Set(orderedTools.map(([, tool]) => tool.id)).size !== orderedTools.length
      ) {
        return false;
      }
    }
    for (const frame of eventFrames(event, identity, includeUsage)) {
      enqueueFrame(frame);
    }
    if (event.type === "completed") completed = true;
    return true;
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        signals.deadline.addEventListener("abort", onDeadlineAbort, {
          once: true,
        });
        signals.client.addEventListener("abort", onClientAbort, { once: true });
        if (signals.deadline.aborted) onDeadlineAbort();
        else if (signals.client.aborted) onClientAbort();
      },
      async pull(controller) {
        if (flushOne(controller)) return;
        if (terminalOutcome !== undefined) return;
        try {
          while (terminalOutcome === undefined) {
            const newline = buffer.indexOf("\n");
            if (newline >= 0) {
              const line = buffer.slice(0, newline).trimEnd();
              buffer = buffer.slice(newline + 1);
              if (line.length === 0) continue;
              const event = parseCanonicalOutputEventLine(line);
              if (!event || !acceptEvent(event)) {
                failProtocol();
                return;
              }
              if (flushOne(controller)) return;
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
              if (!event || !acceptEvent(event)) {
                failProtocol();
                return;
              }
            }
            if (!completed) {
              failIncomplete();
              return;
            }
            beginTerminal("normal-complete");
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          beginTerminal("upstream-error", error);
        }
      },
      cancel(reason) {
        beginTerminal("consumer-cancel", reason);
      },
    }),
    {
      status: response.status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}
