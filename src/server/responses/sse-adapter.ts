import { randomUUID } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import {
  normalizeStreamFailure,
  type StreamFailure,
  type StreamFailureCode,
  streamFailure,
} from "../../core/stream-error.js";
import {
  type CanonicalOutputEvent,
  type CanonicalOutputUsage,
  parseCanonicalOutputEventLine,
} from "../../protocol/output.js";
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
  reasoningSummaryPartAdded,
  reasoningSummaryPartDone,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  responseCompleted,
  responseCreated,
  responseFailed,
  responseInProgress,
} from "./events.js";
import {
  couldStillBeGptSolReasoningPlaceholder,
  isGptSolReasoningPlaceholder,
} from "./reasoning.js";
import {
  outputTextContent,
  type ResponseRequestConfiguration,
  type ResponseUsage,
  responseUsage,
} from "./state.js";
import {
  type BridgeFailure,
  type ResponsesToolBridge,
  reportToolRestoreFailure,
} from "./tool-bridge.js";

type AdapterOptions = {
  readonly model: string;
  readonly signals: IngressSignals;
  readonly finalize: () => void;
  readonly bridge?: ResponsesToolBridge;
  readonly configuration: ResponseRequestConfiguration;
  readonly includeEncryptedReasoning: boolean;
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

function toTerminalFailure(failure: StreamFailure): TerminalFailure {
  return { code: failure.code, message: failure.message };
}

type ToolCallAccumulator = {
  readonly itemId: string;
  id: string;
  name: string;
  arguments: string;
};

type ReasoningRun = {
  readonly id: string;
  outputIndex?: number;
  text: string;
  emitted: boolean;
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
  const pendingFrames: Uint8Array[] = [];
  let buffer = "";
  let text = "";
  let messageIndex: number | undefined;
  let activeReasoning: ReasoningRun | undefined;
  let deferredReasoningText = "";
  let reasoningEncryptedContent: string | undefined;
  let encryptedContentAttached = false;
  let nextOutputIndex = 0;
  let sequenceNumber = 0;
  let terminalOutcome: AdapterOutcome | undefined;
  let terminalCompletion: TerminalCompletion | undefined;
  let terminalFailure: TerminalFailure | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamClosed = false;
  let canonicalStarted = false;
  let canonicalCompleted = false;

  const emit = (create: (sequence: number) => ResponsesEvent): void => {
    pendingFrames.push(encoder.encode(formatSseEvent(create(sequenceNumber))));
    sequenceNumber += 1;
  };
  const closeIfDrained = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
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
  const flushOne = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (streamClosed) return false;
    const desiredSize = controller.desiredSize;
    if (pendingFrames.length > 0 && desiredSize !== null && desiredSize > 0) {
      const frame = pendingFrames.shift();
      if (!frame) return false;
      controller.enqueue(frame);
      closeIfDrained(controller);
      return true;
    }
    closeIfDrained(controller);
    return false;
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
    if (outcome === "consumer-cancel") pendingFrames.length = 0;
    runCleanupSteps(
      removeDeadlineListener,
      removeClientListener,
      () => {
        if (!streamController) return;
        if (outcome === "normal-complete") {
          if (!terminalCompletion) {
            throw new TypeError("Responses stream completed without terminal data");
          }
          emit((sequence) =>
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
            code: "upstream_stream_error",
            message: "Upstream stream error",
          };
          emit((sequence) =>
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
      options.finalize,
      () => {
        if (streamController) flushOne(streamController);
      },
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const failProtocol = (
    message: string,
    code: StreamFailureCode = "upstream_protocol_error",
  ): void => {
    beginTerminal("upstream-protocol-error", undefined, { code, message });
  };
  const failToolRestore = (failure: BridgeFailure): void => {
    beginTerminal("upstream-protocol-error", undefined, reportToolRestoreFailure(failure));
  };
  const failIncomplete = (): void => {
    beginTerminal(
      "upstream-error",
      undefined,
      toTerminalFailure(streamFailure("upstream_stream_incomplete")),
    );
  };
  const onDeadlineAbort = (): void => {
    const reason =
      signals.deadline.reason instanceof Error
        ? signals.deadline.reason
        : new DOMException("Request deadline exceeded", "TimeoutError");
    beginTerminal("deadline", reason, {
      code: "request_deadline_exceeded",
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
  const startReasoning = (run: ReasoningRun): void => {
    if (run.emitted) return;
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    run.outputIndex = outputIndex;
    run.emitted = true;
    emit((sequence) =>
      outputItemAdded({
        item: { id: run.id, type: "reasoning", summary: [] },
        outputIndex,
        sequenceNumber: sequence,
      }),
    );
    emit((sequence) =>
      reasoningSummaryPartAdded({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        part: { type: "summary_text", text: "" },
        sequenceNumber: sequence,
      }),
    );
    emit((sequence) =>
      reasoningSummaryTextDelta({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        delta: run.text,
        sequenceNumber: sequence,
      }),
    );
  };
  // Exactly one reasoning item per turn carries the replay token, so replaying
  // every returned item still resolves to a single Kiro reasoning envelope.
  const claimEncryptedContent = (): string | undefined => {
    if (reasoningEncryptedContent === undefined || encryptedContentAttached) return undefined;
    encryptedContentAttached = true;
    return reasoningEncryptedContent;
  };
  const finishReasoning = (run: ReasoningRun): void => {
    if (isGptSolReasoningPlaceholder(options.model, run.text)) {
      if (!options.includeEncryptedReasoning) return;
      const outputIndex = nextOutputIndex;
      nextOutputIndex += 1;
      const encryptedContent = claimEncryptedContent();
      const item: ReasoningOutputItem = {
        id: run.id,
        type: "reasoning",
        summary: [],
        ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
      };
      emit((sequence) =>
        outputItemAdded({
          item: { id: run.id, type: "reasoning", summary: [] },
          outputIndex,
          sequenceNumber: sequence,
        }),
      );
      emit((sequence) =>
        outputItemDone({ item, outputIndex, sequenceNumber: sequence }),
      );
      completedOutput.set(outputIndex, item);
      return;
    }
    startReasoning(run);
    const outputIndex = run.outputIndex;
    if (outputIndex === undefined) {
      throw new TypeError("Reasoning output index was not allocated");
    }
    const summary = { type: "summary_text" as const, text: run.text };
    emit((sequence) =>
      reasoningSummaryTextDone({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        text: run.text,
        sequenceNumber: sequence,
      }),
    );
    emit((sequence) =>
      reasoningSummaryPartDone({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        part: summary,
        sequenceNumber: sequence,
      }),
    );
    const encryptedContent = claimEncryptedContent();
    const item: ReasoningOutputItem = {
      id: run.id,
      type: "reasoning",
      summary: [summary],
      ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
    };
    emit((sequence) =>
      outputItemDone({ item, outputIndex, sequenceNumber: sequence }),
    );
    completedOutput.set(outputIndex, item);
  };
  const closeReasoning = (): void => {
    if (!activeReasoning) return;
    const run = activeReasoning;
    activeReasoning = undefined;
    finishReasoning(run);
  };
  // With encrypted replay the token arrives only after every tool delta, so the
  // reasoning item stays open (deltas keep streaming) and completes in
  // complete() where output_item.done can carry the same encrypted_content as
  // response.completed. Without encrypted replay the item closes eagerly.
  const closeReasoningBeforeOutput = (): void => {
    if (options.includeEncryptedReasoning) return;
    closeReasoning();
  };
  const flushDeferredReasoning = (): void => {
    if (deferredReasoningText.length === 0) return;
    const run: ReasoningRun = {
      id: `rs_${randomUUID()}`,
      text: deferredReasoningText,
      emitted: false,
    };
    deferredReasoningText = "";
    finishReasoning(run);
  };
  const addEvent = (event: CanonicalOutputEvent): void => {
    switch (event.type) {
      case "started":
      case "completed":
        return;
      case "reasoning_delta": {
        // Kiro has been observed to emit an ellipsis placeholder for GPT 5.6 Sol.
        // Buffer only that exact candidate so it can be omitted without affecting
        // normal Opus reasoning or future non-placeholder GPT reasoning.
        if (messageIndex !== undefined) {
          deferredReasoningText += event.text;
          return;
        }
        if (!activeReasoning) {
          activeReasoning = {
            id: `rs_${randomUUID()}`,
            text: "",
            emitted: false,
          };
        }
        const run = activeReasoning;
        const wasEmitted = run.emitted;
        run.text += event.text;
        if (wasEmitted) {
          const outputIndex = run.outputIndex;
          if (outputIndex === undefined) {
            throw new TypeError("Reasoning output index was not allocated");
          }
          emit((sequence) =>
            reasoningSummaryTextDelta({
              itemId: run.id,
              outputIndex,
              summaryIndex: 0,
              delta: event.text,
              sequenceNumber: sequence,
            }),
          );
        } else if (
          !couldStillBeGptSolReasoningPlaceholder(options.model, run.text)
        ) {
          startReasoning(run);
        }
        return;
      }
      case "reasoning_encrypted":
        if (options.includeEncryptedReasoning) {
          reasoningEncryptedContent = event.encryptedContent;
        }
        return;
      case "reasoning_signature":
      case "reasoning_redacted":
        return;
      case "text_delta": {
        closeReasoningBeforeOutput();
        if (messageIndex === undefined) {
          messageIndex = nextOutputIndex;
          nextOutputIndex += 1;
          emit((sequence) =>
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
          emit((sequence) =>
            contentPartAdded({
              itemId: messageId,
              outputIndex: messageIndex ?? 0,
              contentIndex: 0,
              part: outputTextContent(""),
              sequenceNumber: sequence,
            }),
          );
        }
        text += event.text;
        emit((sequence) =>
          outputTextDelta({
            itemId: messageId,
            outputIndex: messageIndex ?? 0,
            contentIndex: 0,
            delta: event.text,
            sequenceNumber: sequence,
          }),
        );
        return;
      }
      case "tool_call_delta": {
        closeReasoningBeforeOutput();
        const existing = tools.get(event.index) ?? {
          itemId: `fc_${randomUUID()}`,
          id: "",
          name: "",
          arguments: "",
        };
        if (existing.id.length === 0 && event.id !== undefined) existing.id = event.id;
        if (existing.name.length === 0 && event.name !== undefined) existing.name = event.name;
        existing.arguments += event.arguments;
        tools.set(event.index, existing);
        return;
      }
    }
  };

  const complete = (
    usage: CanonicalOutputUsage,
    finishReason: "stop" | "tool_calls",
  ): void => {
    const invalidTool = [...tools.values()].some(
      (tool) => tool.id.length === 0 || tool.name.length === 0,
    );
    if (invalidTool) {
      failProtocol("Malformed upstream tool call");
      return;
    }
    const orderedTools = [...tools.entries()].sort(([left], [right]) => left - right);
    const expectedFinishReason =
      orderedTools.length > 0 ? "tool_calls" : "stop";
    if (finishReason !== expectedFinishReason) {
      failProtocol("Upstream finish reason does not match its output");
      return;
    }
    // The canonical stream only carries validated JSON arguments; a no-argument
    // Kiro tool call already arrives as "{}" from the SDK transformer.
    const restorableTools = orderedTools.map(([, tool]) => ({
        itemId: tool.itemId,
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
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
      failToolRestore(restored);
      return;
    }
    // Item-level done events follow output order (reasoning, message, later
    // reasoning, tool calls) so history assembled from output_item.done matches
    // response.completed.output even though the reasoning done was deferred.
    closeReasoning();
    if (messageIndex !== undefined) {
      const item: MessageOutputItem = {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [outputTextContent(text)],
      };
      emit((sequence) =>
        outputTextDone({
          itemId: messageId,
          outputIndex: messageIndex ?? 0,
          contentIndex: 0,
          text,
          sequenceNumber: sequence,
        }),
      );
      emit((sequence) =>
        contentPartDone({
          itemId: messageId,
          outputIndex: messageIndex ?? 0,
          contentIndex: 0,
          part: outputTextContent(text),
          sequenceNumber: sequence,
        }),
      );
      emit((sequence) =>
        outputItemDone({ item, outputIndex: messageIndex ?? 0, sequenceNumber: sequence }),
      );
      completedOutput.set(messageIndex, item);
    }
    flushDeferredReasoning();
    const unattachedEncryptedContent = claimEncryptedContent();
    if (unattachedEncryptedContent !== undefined) {
      const outputIndex = nextOutputIndex;
      nextOutputIndex += 1;
      const item: ReasoningOutputItem = {
        id: `rs_${randomUUID()}`,
        type: "reasoning",
        summary: [],
        encrypted_content: unattachedEncryptedContent,
      };
      emit((sequence) =>
        outputItemAdded({
          item: { id: item.id, type: "reasoning", summary: [] },
          outputIndex,
          sequenceNumber: sequence,
        }),
      );
      emit((sequence) =>
        outputItemDone({ item, outputIndex, sequenceNumber: sequence }),
      );
      completedOutput.set(outputIndex, item);
    }
    for (const item of restored.items) {
      const outputIndex = nextOutputIndex;
      nextOutputIndex += 1;
      const addedItem =
        item.type === "function_call"
          ? { ...item, arguments: "", status: "in_progress" as const }
          : { ...item, input: "", status: "in_progress" as const };
      emit((sequence) =>
        outputItemAdded({ item: addedItem, outputIndex, sequenceNumber: sequence }),
      );
      if (item.type === "function_call") {
        emit((sequence) =>
          functionCallArgumentsDelta({
            itemId: item.id,
            outputIndex,
            delta: item.arguments,
            sequenceNumber: sequence,
          }),
        );
        emit((sequence) =>
          functionCallArgumentsDone({
            itemId: item.id,
            outputIndex,
            arguments: item.arguments,
            sequenceNumber: sequence,
          }),
        );
      } else {
        emit((sequence) =>
          customToolCallInputDelta({
            itemId: item.id,
            outputIndex,
            delta: item.input,
            sequenceNumber: sequence,
          }),
        );
        emit((sequence) =>
          customToolCallInputDone({
            itemId: item.id,
            outputIndex,
            input: item.input,
            sequenceNumber: sequence,
          }),
        );
      }
      const completedItem = { ...item, status: "completed" as const };
      emit((sequence) =>
        outputItemDone({ item: completedItem, outputIndex, sequenceNumber: sequence }),
      );
      completedOutput.set(outputIndex, completedItem);
    }
    const output = [...completedOutput.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
    terminalCompletion = { output, usage: responseUsage(usage) };
    beginTerminal("normal-complete");
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        emit((sequence) =>
          responseCreated({
            responseId,
            model: options.model,
            sequenceNumber: sequence,
            createdAt,
            configuration: options.configuration,
          }),
        );
        emit((sequence) =>
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
        flushOne(controller);
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
              addEvent(event);
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
              }
            }
            failIncomplete();
            return;
          }
        } catch (error) {
          if (terminalOutcome !== undefined) return;
          const failure = normalizeStreamFailure(error);
          beginTerminal(
            failure.disposition === "fatal"
              ? "upstream-protocol-error"
              : "upstream-error",
            error,
            toTerminalFailure(failure),
          );
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
