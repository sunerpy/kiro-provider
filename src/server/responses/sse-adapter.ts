import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  type ChatWireDelta,
  type ChatWireUsage,
  parseChatWireChunk,
} from "../chat-wire.js";
import type { IngressSignals } from "../request-lifecycle.js";
import {
  contentPartAdded,
  contentPartDone,
  customToolCallInputDelta,
  customToolCallInputDone,
  formatSseEvent,
  functionCallArgumentsDelta,
  functionCallArgumentsDone,
  type MessageOutputItem,
  outputItemAdded,
  outputItemDone,
  outputTextDelta,
  outputTextDone,
  type ReasoningOutputItem,
  type ResponseOutputItem,
  type ResponsesEvent,
  type ResponseUsage,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  responseCompleted,
  responseCreated,
  responseFailed,
  responseInProgress,
} from "./events.js";
import type { ResponseRequestConfiguration } from "./state.js";
import type { ResponsesToolBridge } from "./tool-bridge.js";

type AdapterOptions = {
  readonly model: string;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
  readonly bridge?: ResponsesToolBridge;
  readonly configuration: ResponseRequestConfiguration;
};

type AdapterOutcome =
  | "normal-complete"
  | "deadline"
  | "client-abort"
  | "consumer-cancel"
  | "upstream-error"
  | "upstream-protocol-error";

type TerminalCompletion = {
  readonly output: readonly ResponseOutputItem[];
  readonly usage: ResponseUsage;
};

type TerminalFailure = {
  readonly code: string;
  readonly message: string;
};

type ToolCallAccumulator = {
  readonly itemId: string;
  id: string;
  name: string;
  arguments: string;
};

type ReasoningRun = {
  readonly id: string;
  readonly outputIndex: number;
  text: string;
};

// allow: SIZE_OK — this file is one indivisible stream state machine with typed boundary parsing.
export function responsesSseAdapter(pipelineResponse: Response, options: AdapterOptions): Response {
  const signals = options.signals;
  const upstream =
    pipelineResponse.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const tools = new Map<number, ToolCallAccumulator>();
  const completedOutput = new Map<number, ResponseOutputItem>();
  let buffer = "";
  let text = "";
  let messageIndex: number | undefined;
  let activeReasoning: ReasoningRun | undefined;
  let deferredReasoningText = "";
  let reasoningEncryptedContent: string | undefined;
  let nextOutputIndex = 0;
  let sequenceNumber = 0;
  let terminalOutcome: AdapterOutcome | undefined;
  let terminalCompletion: TerminalCompletion | undefined;
  let terminalFailure: TerminalFailure | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    create: (sequence: number) => ResponsesEvent,
  ): void => {
    controller.enqueue(encoder.encode(formatSseEvent(create(sequenceNumber))));
    sequenceNumber += 1;
  };
  const claimTerminal = (outcome: AdapterOutcome): boolean => {
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
    outcome: AdapterOutcome,
    reason?: unknown,
    failure?: TerminalFailure,
  ): void => {
    if (!claimTerminal(outcome)) return;
    terminalFailure = failure;
    runCleanupSteps(
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (!streamController) return;
        if (outcome === "normal-complete") {
          if (!terminalCompletion) {
            throw new TypeError("Responses stream completed without terminal data");
          }
          emit(streamController, (sequence) =>
            responseCompleted({
              responseId,
              model: options.model,
              output: terminalCompletion?.output ?? [],
              usage: terminalCompletion?.usage ?? {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
              },
              sequenceNumber: sequence,
              createdAt,
              completedAt: Math.floor(Date.now() / 1000),
              configuration: options.configuration,
            }),
          );
        } else if (
          outcome === "deadline" ||
          outcome === "upstream-error" ||
          outcome === "upstream-protocol-error"
        ) {
          const details = terminalFailure ?? {
            code: "upstream_error",
            message: "Upstream stream error",
          };
          emit(streamController, (sequence) =>
            responseFailed({
              responseId,
              model: options.model,
              error: details,
              sequenceNumber: sequence,
              createdAt,
              configuration: options.configuration,
            }),
          );
        }
      },
      () => {
        if (outcome !== "consumer-cancel") streamController?.close();
      },
      options.finalize,
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const failProtocol = (message: string, code = "upstream_error"): void => {
    beginTerminal("upstream-protocol-error", undefined, { code, message });
  };
  const onDeadlineAbort = (): void => {
    const reason =
      signals.deadline.reason instanceof Error
        ? signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError");
    beginTerminal("deadline", reason, {
      code: "upstream_error",
      message: "Request deadline exceeded",
    });
  };
  const onClientAbort = (): void => {
    const reason =
      signals.client.reason instanceof Error
        ? signals.client.reason
        : new DOMException("Client closed request", "AbortError");
    beginTerminal("client-abort", reason);
  };
  const closeReasoning = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!activeReasoning) return;
    const item: ReasoningOutputItem = {
      id: activeReasoning.id,
      type: "reasoning",
      summary: [{ type: "summary_text", text: activeReasoning.text }],
      ...(reasoningEncryptedContent !== undefined
        ? { encrypted_content: reasoningEncryptedContent }
        : {}),
    };
    emit(controller, (sequence) =>
      reasoningSummaryTextDone({
        itemId: activeReasoning?.id ?? "",
        outputIndex: activeReasoning?.outputIndex ?? 0,
        summaryIndex: 0,
        text: activeReasoning?.text ?? "",
        sequenceNumber: sequence,
      }),
    );
    emit(controller, (sequence) =>
      outputItemDone({
        item,
        outputIndex: activeReasoning?.outputIndex ?? 0,
        sequenceNumber: sequence,
      }),
    );
    completedOutput.set(activeReasoning.outputIndex, item);
    activeReasoning = undefined;
  };
  const flushDeferredReasoning = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (deferredReasoningText.length === 0) return;
    const run: ReasoningRun = {
      id: `rs_${randomUUID()}`,
      outputIndex: nextOutputIndex,
      text: deferredReasoningText,
    };
    nextOutputIndex += 1;
    deferredReasoningText = "";
    emit(controller, (sequence) =>
      outputItemAdded({
        item: { id: run.id, type: "reasoning", summary: [] },
        outputIndex: run.outputIndex,
        sequenceNumber: sequence,
      }),
    );
    emit(controller, (sequence) =>
      reasoningSummaryTextDelta({
        itemId: run.id,
        outputIndex: run.outputIndex,
        summaryIndex: 0,
        delta: run.text,
        sequenceNumber: sequence,
      }),
    );
    emit(controller, (sequence) =>
      reasoningSummaryTextDone({
        itemId: run.id,
        outputIndex: run.outputIndex,
        summaryIndex: 0,
        text: run.text,
        sequenceNumber: sequence,
      }),
    );
    const item: ReasoningOutputItem = {
      id: run.id,
      type: "reasoning",
      summary: [{ type: "summary_text", text: run.text }],
      ...(reasoningEncryptedContent !== undefined
        ? { encrypted_content: reasoningEncryptedContent }
        : {}),
    };
    emit(controller, (sequence) =>
      outputItemDone({ item, outputIndex: run.outputIndex, sequenceNumber: sequence }),
    );
    completedOutput.set(run.outputIndex, item);
  };
  const addDelta = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: ChatWireDelta,
  ): void => {
    switch (delta.kind) {
      case "empty":
        return;
      case "reasoning": {
        // Codex tracks one active output item. Kiro can interleave a late
        // reasoning fragment between text deltas, so defer that fragment until
        // the message is complete instead of overlapping two active items.
        if (messageIndex !== undefined) {
          deferredReasoningText += delta.text;
          return;
        }
        if (!activeReasoning) {
          activeReasoning = {
            id: `rs_${randomUUID()}`,
            outputIndex: nextOutputIndex,
            text: "",
          };
          nextOutputIndex += 1;
          emit(controller, (sequence) =>
            outputItemAdded({
              item: { id: activeReasoning?.id ?? "", type: "reasoning", summary: [] },
              outputIndex: activeReasoning?.outputIndex ?? 0,
              sequenceNumber: sequence,
            }),
          );
        }
        activeReasoning.text += delta.text;
        emit(controller, (sequence) =>
          reasoningSummaryTextDelta({
            itemId: activeReasoning?.id ?? "",
            outputIndex: activeReasoning?.outputIndex ?? 0,
            summaryIndex: 0,
            delta: delta.text,
            sequenceNumber: sequence,
          }),
        );
        return;
      }
      case "reasoning_encrypted":
        reasoningEncryptedContent = delta.encryptedContent;
        return;
      case "reasoning_signature":
      case "reasoning_redacted":
        return;
      case "text": {
        closeReasoning(controller);
        if (messageIndex === undefined) {
          messageIndex = nextOutputIndex;
          nextOutputIndex += 1;
          emit(controller, (sequence) =>
            outputItemAdded({
              item: {
                id: messageId,
                type: "message",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
              outputIndex: messageIndex ?? 0,
              sequenceNumber: sequence,
            }),
          );
          emit(controller, (sequence) =>
            contentPartAdded({
              itemId: messageId,
              outputIndex: messageIndex ?? 0,
              contentIndex: 0,
              part: { type: "output_text", text: "", annotations: [] },
              sequenceNumber: sequence,
            }),
          );
        }
        text += delta.text;
        emit(controller, (sequence) =>
          outputTextDelta({
            itemId: messageId,
            outputIndex: messageIndex ?? 0,
            contentIndex: 0,
            delta: delta.text,
            sequenceNumber: sequence,
          }),
        );
        return;
      }
      case "tool_calls":
        closeReasoning(controller);
        for (const fragment of delta.calls) {
          const existing = tools.get(fragment.index) ?? {
            itemId: `fc_${randomUUID()}`,
            id: "",
            name: "",
            arguments: "",
          };
          if (existing.id.length === 0 && fragment.id !== undefined) existing.id = fragment.id;
          if (existing.name.length === 0 && fragment.name !== undefined)
            existing.name = fragment.name;
          existing.arguments += fragment.arguments;
          tools.set(fragment.index, existing);
        }
        return;
    }
  };

  const complete = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    usage: ChatWireUsage,
  ): void => {
    const invalidTool = [...tools.values()].some(
      (tool) => tool.id.length === 0 || tool.name.length === 0,
    );
    if (invalidTool) {
      failProtocol("Malformed upstream tool call");
      return;
    }
    const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
    const restorableTools = orderedTools.map(([, tool]) => ({
        itemId: tool.itemId,
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments.trim().length === 0 ? "{}" : tool.arguments,
      }));
    const restored = options.bridge?.restoreCalls(restorableTools) ?? {
      ok: true as const,
      items: restorableTools.map((tool) => ({
        id: tool.itemId,
        type: "function_call" as const,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      })),
    };
    if (!restored.ok) {
      failProtocol(restored.message, "upstream_protocol_error");
      return;
    }
    closeReasoning(controller);
    if (messageIndex !== undefined) {
      const item: MessageOutputItem = {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      emit(controller, (sequence) =>
        outputTextDone({
          itemId: messageId,
          outputIndex: messageIndex ?? 0,
          contentIndex: 0,
          text,
          sequenceNumber: sequence,
        }),
      );
      emit(controller, (sequence) =>
        contentPartDone({
          itemId: messageId,
          outputIndex: messageIndex ?? 0,
          contentIndex: 0,
          part: { type: "output_text", text, annotations: [] },
          sequenceNumber: sequence,
        }),
      );
      emit(controller, (sequence) =>
        outputItemDone({ item, outputIndex: messageIndex ?? 0, sequenceNumber: sequence }),
      );
      completedOutput.set(messageIndex, item);
    }
    flushDeferredReasoning(controller);
    if (reasoningEncryptedContent !== undefined) {
      let attached = false;
      for (const [index, item] of completedOutput) {
        if (item.type !== "reasoning") continue;
        completedOutput.set(index, {
          ...item,
          encrypted_content: reasoningEncryptedContent,
        });
        attached = true;
      }
      if (!attached) {
        const outputIndex = nextOutputIndex;
        nextOutputIndex += 1;
        const item: ReasoningOutputItem = {
          id: `rs_${randomUUID()}`,
          type: "reasoning",
          summary: [],
          encrypted_content: reasoningEncryptedContent,
        };
        emit(controller, (sequence) =>
          outputItemAdded({
            item: { id: item.id, type: "reasoning", summary: [] },
            outputIndex,
            sequenceNumber: sequence,
          }),
        );
        emit(controller, (sequence) =>
          outputItemDone({ item, outputIndex, sequenceNumber: sequence }),
        );
        completedOutput.set(outputIndex, item);
      }
    }
    for (const item of restored.items) {
      const outputIndex = nextOutputIndex;
      nextOutputIndex += 1;
      const addedItem =
        item.type === "function_call"
          ? { ...item, arguments: "" }
          : { ...item, input: "" };
      emit(controller, (sequence) =>
        outputItemAdded({ item: addedItem, outputIndex, sequenceNumber: sequence }),
      );
      if (item.type === "function_call") {
        emit(controller, (sequence) =>
          functionCallArgumentsDelta({
            itemId: item.id,
            outputIndex,
            delta: item.arguments,
            sequenceNumber: sequence,
          }),
        );
        emit(controller, (sequence) =>
          functionCallArgumentsDone({
            itemId: item.id,
            outputIndex,
            arguments: item.arguments,
            sequenceNumber: sequence,
          }),
        );
      } else {
        emit(controller, (sequence) =>
          customToolCallInputDelta({
            itemId: item.id,
            outputIndex,
            delta: item.input,
            sequenceNumber: sequence,
          }),
        );
        emit(controller, (sequence) =>
          customToolCallInputDone({
            itemId: item.id,
            outputIndex,
            input: item.input,
            sequenceNumber: sequence,
          }),
        );
      }
      const completedItem = { ...item, status: "completed" as const };
      emit(controller, (sequence) =>
        outputItemDone({ item: completedItem, outputIndex, sequenceNumber: sequence }),
      );
      completedOutput.set(outputIndex, completedItem);
    }
    const output = [...completedOutput.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
    terminalCompletion = {
      output,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
      },
    };
    beginTerminal("normal-complete");
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        emit(controller, (sequence) =>
          responseCreated({
            responseId,
            model: options.model,
            sequenceNumber: sequence,
            createdAt,
            configuration: options.configuration,
          }),
        );
        emit(controller, (sequence) =>
          responseInProgress({
            responseId,
            model: options.model,
            sequenceNumber: sequence,
            createdAt,
            configuration: options.configuration,
          }),
        );
        signals.deadline.addEventListener("abort", onDeadlineAbort, { once: true });
        signals.client.addEventListener("abort", onClientAbort, { once: true });
        if (signals.deadline.aborted) onDeadlineAbort();
        else if (signals.client.aborted) onClientAbort();
      },
      async pull(controller) {
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
              addDelta(controller, parsed.delta);
              if (parsed.finishReason !== null) {
                if (!parsed.usage) {
                  failProtocol("Terminal upstream chunk omitted usage");
                  return;
                }
                complete(controller, parsed.usage);
                return;
              }
              if (parsed.delta.kind !== "tool_calls" && parsed.delta.kind !== "empty") return;
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
              addDelta(controller, parsed.delta);
              if (parsed.finishReason !== null && parsed.usage) {
                complete(controller, parsed.usage);
                return;
              }
            }
            failProtocol("Upstream stream ended before completion");
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          beginTerminal("upstream-error", error, {
            code: "upstream_error",
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
      },
    },
  );
}
