import { randomBytes } from "node:crypto";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import { normalizeStreamFailure, streamFailure } from "../../core/stream-error.js";
import type { CodeReference } from "../../protocol/code-references.js";
import type { CanonicalOutputUsage } from "../../protocol/output.js";
import {
  type CanonicalCompletionV2,
  type CanonicalOutputEventV2,
  parseCanonicalOutputEventV2Line,
} from "../../protocol/output-v2.js";
import { codePointLength } from "../../web-search/citations.js";
import type { IngressSignals } from "../request-lifecycle.js";
import { publicResponseState } from "./continuation.js";
import {
  contentPartAdded,
  contentPartDone,
  customToolCallInputDelta,
  customToolCallInputDone,
  formatSseEvent,
  functionCallArgumentsDelta,
  functionCallArgumentsDone,
  outputItemAdded,
  outputItemDone,
  outputTextAnnotationAdded,
  outputTextDelta,
  outputTextDone,
  type ResponsesEvent,
  reasoningSummaryPartAdded,
  reasoningSummaryPartDone,
  reasoningSummaryTextDelta,
  reasoningSummaryTextDone,
  responseCompleted,
  responseCreated,
  responseFailed,
  responseInProgress,
  webSearchCallProgress,
} from "./events.js";
import { couldStillBeGpt56ReasoningPlaceholder, isGpt56ReasoningPlaceholder } from "./reasoning.js";
import {
  type MessageOutputItem,
  type OutputTextContent,
  type ReasoningOutputItem,
  type ResponseOutputItem,
  type ResponseRequestConfiguration,
  type ResponseStateObject,
  responseState,
  responseUsage,
  type UrlCitationAnnotation,
  type WebSearchCallOutputItem,
} from "./state.js";
import { type ResponsesToolBridge, reportToolRestoreFailure } from "./tool-bridge.js";

/**
 * OpenAI Responses encoding of hosted web search output (canonical v2).
 *
 * One response owns one lifecycle and one terminal while it spans several
 * Kiro generations. Each generation contributes its own reasoning item and
 * message; every executed search is a `web_search_call` item in the order it
 * ran; cited spans become `url_citation` annotations. Output indexes and
 * sequence numbers increase over the whole execution. The JSON body is built
 * from the same encoder, so both transports publish the same output.
 */

export class HostedResponsesOutputError extends Error {
  override readonly name = "HostedResponsesOutputError";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function protocolError(message: string): HostedResponsesOutputError {
  return new HostedResponsesOutputError(message, "upstream_protocol_error");
}

export interface HostedResponsesOptions {
  readonly model: string;
  readonly bridge: ResponsesToolBridge;
  readonly includeEncryptedReasoning: boolean;
  readonly captureEncryptedReasoning: boolean;
  /** `include: ["web_search_call.action.sources"]`. */
  readonly includeSources: boolean;
}

export interface HostedResponsesTerminal {
  readonly usage: CanonicalOutputUsage;
  readonly webSearchRequests: number;
  readonly codeReferences?: readonly CodeReference[];
}

type Emit = (create: (sequence: number) => ResponsesEvent) => void;

type ReasoningRun = {
  readonly id: string;
  outputIndex?: number;
  text: string;
  emitted: boolean;
};

type OpenMessage = {
  readonly id: string;
  readonly outputIndex: number;
  text: string;
  codePoints: number;
  readonly annotations: UrlCitationAnnotation[];
};

type SearchCall = {
  readonly outputIndex: number;
  readonly query: string;
  sources?: readonly { readonly type: "url"; readonly url: string }[];
  state: "searching" | "result" | "completed" | "failed";
};

export class HostedResponsesEncoder {
  #nextOutput = 0;
  readonly #output = new Map<number, ResponseOutputItem>();
  #started = false;
  #terminal: HostedResponsesTerminal | undefined;
  #phase: "generation" | "group" = "generation";
  #reasoning: ReasoningRun | undefined;
  #deferredReasoning = "";
  #token: string | undefined;
  #tokenAttached = false;
  /**
   * Reasoning items announced when the generation's tool group starts and
   * completed when the generation ends. Announcing them first keeps every
   * item of one generation before the next generation's items, which is how a
   * replayed input is split back into generations.
   */
  #reserved: Array<
    | { readonly kind: "summary"; readonly run: ReasoningRun }
    | { readonly kind: "opaque"; readonly id: string; readonly outputIndex: number }
  > = [];
  #message: OpenMessage | undefined;
  #messageSeen = false;
  readonly #calls = new Map<string, SearchCall>();
  #groupClientCalls = 0;
  readonly #defer: boolean;
  /** Shared by every item of the current generation; see `generation_started`. */
  #generationKey = randomBytes(8).toString("hex");

  constructor(
    private readonly options: HostedResponsesOptions,
    private readonly emit: Emit,
  ) {
    this.#defer = options.includeEncryptedReasoning || options.captureEncryptedReasoning;
  }

  get terminal(): HostedResponsesTerminal | undefined {
    return this.#terminal;
  }

  /** Completed items in output order. */
  get output(): readonly ResponseOutputItem[] {
    return [...this.#output.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
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
    switch (event.type) {
      case "generation_started":
        this.#content();
        this.#generationKey = event.key;
        return;
      case "reasoning_delta":
        this.#content();
        this.#reasoningDelta(event.text);
        return;
      case "reasoning_encrypted":
        this.#content();
        if (this.#defer) this.#token = event.encryptedContent;
        return;
      case "reasoning_signature":
      case "reasoning_redacted":
        this.#content();
        return;
      case "text_delta":
        this.#content();
        this.#text(event.text);
        return;
      case "citation":
        this.#content();
        this.#text(event.text, { url: event.url, title: event.title });
        return;
      case "tool_call_delta":
        this.#group();
        this.#clientTool(event);
        return;
      case "search_call_started":
        if (event.deferred) throw protocolError("Responses cannot defer a web search call");
        this.#group();
        this.#searchStarted(event.callId, event.query);
        return;
      case "search_result": {
        const call = this.#calls.get(event.callId);
        if (call?.state !== "searching")
          throw protocolError("Web search result has no running call");
        call.sources = event.sources.map((source) => ({ type: "url" as const, url: source.url }));
        call.state = "result";
        return;
      }
      case "search_call_completed": {
        const call = this.#calls.get(event.callId);
        if (call?.state !== "result") throw protocolError("Web search completion has no result");
        call.state = "completed";
        this.emit((sequence) =>
          webSearchCallProgress({
            phase: "completed",
            itemId: event.callId,
            outputIndex: call.outputIndex,
            sequenceNumber: sequence,
          }),
        );
        this.#searchDone(event.callId, call, "completed");
        return;
      }
      case "search_call_failed": {
        const call = this.#calls.get(event.callId);
        if (call?.state !== "searching")
          throw protocolError("Web search failure has no running call");
        call.state = "failed";
        this.#searchDone(event.callId, call, "failed");
        return;
      }
      case "generation_boundary":
        if (this.#groupClientCalls > 0) {
          throw protocolError("A generation boundary followed client tool calls");
        }
        this.#requireResolved();
        this.#closeSegment();
        this.#phase = "generation";
        return;
      case "completed": {
        this.#requireResolved();
        if (event.finishReason === "pause") throw protocolError("Responses cannot pause a turn");
        const clientCalls = this.#phase === "group" ? this.#groupClientCalls : 0;
        if ((event.finishReason === "tool_calls") !== clientCalls > 0) {
          throw protocolError("Upstream finish reason does not match its output");
        }
        this.#closeSegment();
        this.#terminal = {
          usage: event.usage,
          webSearchRequests: event.webSearchRequests,
          ...(event.codeReferences !== undefined ? { codeReferences: event.codeReferences } : {}),
        };
        return;
      }
    }
  }

  #content(): void {
    if (this.#phase === "group") throw protocolError("Generation output followed its tool group");
  }

  #group(): void {
    if (this.#phase === "generation") {
      this.#closeMessage();
      this.#closeReasoningBeforeOutput();
      if (this.#defer) this.#reserveReasoning();
      this.#phase = "group";
      this.#groupClientCalls = 0;
    }
  }

  #reserveReasoning(): void {
    const run = this.#reasoning;
    this.#reasoning = undefined;
    if (run !== undefined) {
      if (!run.emitted && isGpt56ReasoningPlaceholder(this.options.model, run.text)) {
        if (this.#token !== undefined) this.#reserved.push(this.#announceOpaque(run.id));
      } else {
        this.#startReasoning(run);
        this.#reserved.push({ kind: "summary", run });
      }
    }
    if (this.#deferredReasoning.length > 0) {
      const late: ReasoningRun = {
        id: this.#itemId("rs"),
        text: this.#deferredReasoning,
        emitted: false,
      };
      this.#deferredReasoning = "";
      this.#startReasoning(late);
      this.#reserved.push({ kind: "summary", run: late });
    }
    if (this.#reserved.length === 0 && this.#token !== undefined) {
      this.#reserved.push(this.#announceOpaque(this.#itemId("rs")));
    }
  }

  #announceOpaque(id: string): {
    readonly kind: "opaque";
    readonly id: string;
    readonly outputIndex: number;
  } {
    const outputIndex = this.#allocate();
    this.emit((sequence) =>
      outputItemAdded({
        item: { id, type: "reasoning", summary: [] },
        outputIndex,
        sequenceNumber: sequence,
      }),
    );
    return { kind: "opaque", id, outputIndex };
  }

  #finishReserved(): void {
    for (const entry of this.#reserved.splice(0)) {
      if (entry.kind === "summary") {
        this.#finishReasoning(entry.run);
        continue;
      }
      const token = this.#claimToken();
      const item: ReasoningOutputItem = {
        id: entry.id,
        type: "reasoning",
        summary: [],
        ...(token !== undefined ? { encrypted_content: token } : {}),
      };
      const outputIndex = entry.outputIndex;
      this.emit((sequence) => outputItemDone({ item, outputIndex, sequenceNumber: sequence }));
      this.#output.set(outputIndex, item);
    }
  }

  #requireResolved(): void {
    for (const call of this.#calls.values()) {
      if (call.state === "searching" || call.state === "result") {
        throw protocolError("Web search call ended without a result");
      }
    }
  }

  /** Item identity carrying the generation key, e.g. `rs_<key><random>`. */
  #itemId(prefix: "rs" | "msg" | "fc"): string {
    return `${prefix}_${this.#generationKey}${randomBytes(8).toString("hex")}`;
  }

  #allocate(): number {
    const index = this.#nextOutput;
    this.#nextOutput += 1;
    return index;
  }

  #searchStarted(callId: string, query: string): void {
    if (this.#calls.has(callId)) throw protocolError("Web search call identity repeated");
    const outputIndex = this.#allocate();
    this.#calls.set(callId, { outputIndex, query, state: "searching" });
    const item: WebSearchCallOutputItem = {
      id: callId,
      type: "web_search_call",
      status: "in_progress",
      action: { type: "search", query, queries: [query] },
    };
    this.emit((sequence) => outputItemAdded({ item, outputIndex, sequenceNumber: sequence }));
    for (const phase of ["in_progress", "searching"] as const) {
      this.emit((sequence) =>
        webSearchCallProgress({ phase, itemId: callId, outputIndex, sequenceNumber: sequence }),
      );
    }
  }

  #searchDone(callId: string, call: SearchCall, status: "completed" | "failed"): void {
    const item: WebSearchCallOutputItem = {
      id: callId,
      type: "web_search_call",
      status,
      action: {
        type: "search",
        query: call.query,
        queries: [call.query],
        ...(this.options.includeSources && status === "completed" && call.sources !== undefined
          ? { sources: call.sources }
          : {}),
      },
    };
    this.emit((sequence) =>
      outputItemDone({ item, outputIndex: call.outputIndex, sequenceNumber: sequence }),
    );
    this.#output.set(call.outputIndex, item);
  }

  #clientTool(event: Extract<CanonicalOutputEventV2, { readonly type: "tool_call_delta" }>): void {
    if (event.id === undefined || event.id.length === 0 || !event.name) {
      throw protocolError("Malformed upstream tool call");
    }
    const itemId = this.#itemId("fc");
    const restored = this.options.bridge.restoreCalls([
      { itemId, id: event.id, name: event.name, arguments: event.arguments },
    ]);
    if (!restored.ok) {
      const failure = reportToolRestoreFailure(restored);
      throw new HostedResponsesOutputError(failure.message, failure.code);
    }
    const item = restored.items[0];
    if (item === undefined) throw protocolError("Malformed upstream tool call");
    const outputIndex = this.#allocate();
    const common = {
      id: item.id,
      call_id: item.call_id,
      name: item.name,
      ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
      status: "in_progress" as const,
    };
    if (item.type === "function_call") {
      this.emit((sequence) =>
        outputItemAdded({
          item: { ...common, type: "function_call", arguments: "" },
          outputIndex,
          sequenceNumber: sequence,
        }),
      );
      if (item.arguments.length > 0) {
        this.emit((sequence) =>
          functionCallArgumentsDelta({
            itemId: item.id,
            outputIndex,
            delta: item.arguments,
            sequenceNumber: sequence,
          }),
        );
      }
      this.emit((sequence) =>
        functionCallArgumentsDone({
          itemId: item.id,
          outputIndex,
          arguments: item.arguments,
          sequenceNumber: sequence,
        }),
      );
    } else {
      this.emit((sequence) =>
        outputItemAdded({
          item: { ...common, type: "custom_tool_call", input: "" },
          outputIndex,
          sequenceNumber: sequence,
        }),
      );
      this.emit((sequence) =>
        customToolCallInputDelta({
          itemId: item.id,
          outputIndex,
          delta: item.input,
          sequenceNumber: sequence,
        }),
      );
      this.emit((sequence) =>
        customToolCallInputDone({
          itemId: item.id,
          outputIndex,
          input: item.input,
          sequenceNumber: sequence,
        }),
      );
    }
    const completed = { ...item, status: "completed" as const };
    this.emit((sequence) =>
      outputItemDone({ item: completed, outputIndex, sequenceNumber: sequence }),
    );
    this.#output.set(outputIndex, completed);
    this.#groupClientCalls += 1;
  }

  #text(text: string, citation?: { readonly url: string; readonly title: string }): void {
    this.#closeReasoningBeforeOutput();
    if (this.#message === undefined) {
      const message: OpenMessage = {
        id: this.#itemId("msg"),
        outputIndex: this.#allocate(),
        text: "",
        codePoints: 0,
        annotations: [],
      };
      this.#message = message;
      this.#messageSeen = true;
      this.emit((sequence) =>
        outputItemAdded({
          item: {
            id: message.id,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
          outputIndex: message.outputIndex,
          sequenceNumber: sequence,
        }),
      );
      this.emit((sequence) =>
        contentPartAdded({
          itemId: message.id,
          outputIndex: message.outputIndex,
          contentIndex: 0,
          part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          sequenceNumber: sequence,
        }),
      );
    }
    const message = this.#message;
    const start = message.codePoints;
    message.text += text;
    message.codePoints += codePointLength(text);
    if (text.length > 0) {
      this.emit((sequence) =>
        outputTextDelta({
          itemId: message.id,
          outputIndex: message.outputIndex,
          contentIndex: 0,
          delta: text,
          sequenceNumber: sequence,
        }),
      );
    }
    if (citation === undefined) return;
    const annotation: UrlCitationAnnotation = {
      type: "url_citation",
      start_index: start,
      end_index: message.codePoints,
      url: citation.url,
      title: citation.title,
    };
    const annotationIndex = message.annotations.length;
    message.annotations.push(annotation);
    this.emit((sequence) =>
      outputTextAnnotationAdded({
        itemId: message.id,
        outputIndex: message.outputIndex,
        contentIndex: 0,
        annotationIndex,
        annotation,
        sequenceNumber: sequence,
      }),
    );
  }

  #closeMessage(): void {
    const message = this.#message;
    if (message === undefined) return;
    this.#message = undefined;
    const part: OutputTextContent = {
      type: "output_text",
      text: message.text,
      annotations: [...message.annotations],
      logprobs: [],
    };
    this.emit((sequence) =>
      outputTextDone({
        itemId: message.id,
        outputIndex: message.outputIndex,
        contentIndex: 0,
        text: message.text,
        sequenceNumber: sequence,
      }),
    );
    this.emit((sequence) =>
      contentPartDone({
        itemId: message.id,
        outputIndex: message.outputIndex,
        contentIndex: 0,
        part,
        sequenceNumber: sequence,
      }),
    );
    const item: MessageOutputItem = {
      id: message.id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [part],
    };
    this.emit((sequence) =>
      outputItemDone({ item, outputIndex: message.outputIndex, sequenceNumber: sequence }),
    );
    this.#output.set(message.outputIndex, item);
  }

  // Reasoning follows the ordinary Responses rules within each generation.

  #reasoningDelta(text: string): void {
    if (this.#messageSeen) {
      this.#deferredReasoning += text;
      return;
    }
    this.#reasoning ??= { id: this.#itemId("rs"), text: "", emitted: false };
    const run = this.#reasoning;
    const wasEmitted = run.emitted;
    run.text += text;
    if (wasEmitted) {
      const outputIndex = run.outputIndex as number;
      this.emit((sequence) =>
        reasoningSummaryTextDelta({
          itemId: run.id,
          outputIndex,
          summaryIndex: 0,
          delta: text,
          sequenceNumber: sequence,
        }),
      );
    } else if (!couldStillBeGpt56ReasoningPlaceholder(this.options.model, run.text)) {
      this.#startReasoning(run);
    }
  }

  #startReasoning(run: ReasoningRun): void {
    if (run.emitted) return;
    const outputIndex = this.#allocate();
    run.outputIndex = outputIndex;
    run.emitted = true;
    this.emit((sequence) =>
      outputItemAdded({
        item: { id: run.id, type: "reasoning", summary: [] },
        outputIndex,
        sequenceNumber: sequence,
      }),
    );
    this.emit((sequence) =>
      reasoningSummaryPartAdded({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        part: { type: "summary_text", text: "" },
        sequenceNumber: sequence,
      }),
    );
    this.emit((sequence) =>
      reasoningSummaryTextDelta({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        delta: run.text,
        sequenceNumber: sequence,
      }),
    );
  }

  /** Exactly one reasoning item per generation carries its replay token. */
  #claimToken(): string | undefined {
    if (this.#token === undefined || this.#tokenAttached) return undefined;
    this.#tokenAttached = true;
    return this.#token;
  }

  #finishReasoning(run: ReasoningRun): void {
    if (isGpt56ReasoningPlaceholder(this.options.model, run.text)) {
      if (!this.#defer) return;
      const token = this.#claimToken();
      if (token === undefined) return;
      this.#opaqueReasoning(run.id, token);
      return;
    }
    this.#startReasoning(run);
    const outputIndex = run.outputIndex as number;
    const summary = { type: "summary_text" as const, text: run.text };
    this.emit((sequence) =>
      reasoningSummaryTextDone({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        text: run.text,
        sequenceNumber: sequence,
      }),
    );
    this.emit((sequence) =>
      reasoningSummaryPartDone({
        itemId: run.id,
        outputIndex,
        summaryIndex: 0,
        part: summary,
        sequenceNumber: sequence,
      }),
    );
    const token = this.#claimToken();
    const item: ReasoningOutputItem = {
      id: run.id,
      type: "reasoning",
      summary: [summary],
      ...(token !== undefined ? { encrypted_content: token } : {}),
    };
    this.emit((sequence) => outputItemDone({ item, outputIndex, sequenceNumber: sequence }));
    this.#output.set(outputIndex, item);
  }

  #opaqueReasoning(id: string, token: string): void {
    const outputIndex = this.#allocate();
    const item: ReasoningOutputItem = {
      id,
      type: "reasoning",
      summary: [],
      encrypted_content: token,
    };
    this.emit((sequence) =>
      outputItemAdded({
        item: { id, type: "reasoning", summary: [] },
        outputIndex,
        sequenceNumber: sequence,
      }),
    );
    this.emit((sequence) => outputItemDone({ item, outputIndex, sequenceNumber: sequence }));
    this.#output.set(outputIndex, item);
  }

  #closeReasoning(): void {
    const run = this.#reasoning;
    if (run === undefined) return;
    this.#reasoning = undefined;
    this.#finishReasoning(run);
  }

  // Without replay the item closes before visible output; with replay it stays
  // open until the generation's output is complete, so its token is published
  // only after every item that token authenticates.
  #closeReasoningBeforeOutput(): void {
    if (!this.#defer) this.#closeReasoning();
  }

  #flushDeferredReasoning(): void {
    if (this.#deferredReasoning.length === 0) return;
    const run: ReasoningRun = {
      id: this.#itemId("rs"),
      text: this.#deferredReasoning,
      emitted: false,
    };
    this.#deferredReasoning = "";
    this.#finishReasoning(run);
  }

  #closeSegment(): void {
    this.#closeMessage();
    this.#finishReserved();
    this.#closeReasoning();
    this.#flushDeferredReasoning();
    const token = this.#claimToken();
    if (token !== undefined) this.#opaqueReasoning(this.#itemId("rs"), token);
    this.#token = undefined;
    this.#tokenAttached = false;
    this.#messageSeen = false;
  }
}

export interface HostedResponseIdentity {
  readonly responseId: string;
  readonly createdAt: number;
  readonly configuration: ResponseRequestConfiguration;
  readonly usageMode: "compatible" | "strict";
}

/** The completed response object for a hosted search execution. */
export function hostedResponseState(
  encoder: HostedResponsesEncoder,
  identity: HostedResponseIdentity,
  model: string,
): ResponseStateObject {
  const terminal = encoder.terminal;
  if (terminal === undefined) throw protocolError("Upstream stream ended before completion");
  return responseState({
    id: identity.responseId,
    model,
    status: "completed",
    output: encoder.output,
    usage: responseUsage(terminal.usage, identity.usageMode),
    codeReferences: terminal.codeReferences,
    createdAt: identity.createdAt,
    configuration: identity.configuration,
  });
}

/** Non-stream: the same ordered events, encoded once execution has ended. */
export function hostedCompletedResponse(
  completion: CanonicalCompletionV2,
  options: HostedResponsesOptions,
  identity: HostedResponseIdentity,
): ResponseStateObject {
  const encoder = new HostedResponsesEncoder(options, () => {});
  for (const event of completion.events) encoder.push(event);
  return hostedResponseState(encoder, identity, options.model);
}

type HostedSseOptions = HostedResponsesOptions &
  HostedResponseIdentity & {
    readonly signals: IngressSignals;
    readonly finalize: () => void;
    readonly onCompleted?: (response: ResponseStateObject) => void;
  };

/**
 * Streams a hosted search execution as Responses SSE: one created/in_progress
 * pair, every item event in execution order, and exactly one terminal.
 */
export function hostedResponsesSseAdapter(
  pipelineResponse: Response,
  options: HostedSseOptions,
): Response {
  const { signals } = options;
  const upstream =
    pipelineResponse.body ??
    new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = upstream.getReader();
  const textEncoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frames: Uint8Array[] = [];
  let sequenceNumber = 0;
  const emit: Emit = (create) => {
    signals.diagnostics?.projectedFrame();
    let event = create(sequenceNumber);
    if (!options.includeEncryptedReasoning) {
      if ("response" in event) {
        event = { ...event, response: publicResponseState(event.response, false) };
      }
      if ("item" in event && event.item.type === "reasoning") {
        const { encrypted_content: _privateReplay, ...item } = event.item;
        event = { ...event, item };
      }
    }
    frames.push(textEncoder.encode(formatSseEvent(event)));
    sequenceNumber += 1;
  };
  const encoder = new HostedResponsesEncoder(options, emit);
  let buffer = "";
  let terminal = false;
  let dropFrames = false;
  let consumerCancelled = false;
  let closed = false;
  let reading = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const fail = (code: string, message: string): void => {
    const diagnostic = signals.diagnostics?.streamError(code, message);
    emit((sequence) =>
      responseFailed({
        responseId: options.responseId,
        model: options.model,
        error: diagnostic ?? { code, message },
        sequenceNumber: sequence,
        createdAt: options.createdAt,
        configuration: options.configuration,
      }),
    );
  };
  const end = (failure?: { readonly code: string; readonly message: string }, reason?: unknown) => {
    if (terminal) return;
    terminal = true;
    runCleanupSteps(
      () => signals.deadline.removeEventListener("abort", onDeadline),
      () => signals.client.removeEventListener("abort", onClient),
      () => {
        if (dropFrames) frames.length = 0;
        else if (failure !== undefined) fail(failure.code, failure.message);
      },
      options.finalize,
    );
    void boundedCleanup(() => reader.cancel(reason));
  };
  const complete = (): void => {
    let state: ResponseStateObject;
    try {
      state = hostedResponseState(encoder, options, options.model);
    } catch (error) {
      end({ code: "upstream_protocol_error", message: String((error as Error).message) }, error);
      return;
    }
    try {
      options.onCompleted?.(state);
    } catch {
      end({
        code: "response_state_store_failed",
        message: "Response continuation could not be stored",
      });
      return;
    }
    emit((sequence) =>
      responseCompleted({
        responseId: options.responseId,
        model: options.model,
        output: state.output,
        usage: state.usage,
        codeReferences: state.x_kiro?.code_references,
        sequenceNumber: sequence,
        createdAt: options.createdAt,
        completedAt: Math.floor(Date.now() / 1000),
        configuration: options.configuration,
      }),
    );
    end();
  };
  const onDeadline = (): void => {
    end(streamFailure("request_deadline_exceeded"), signals.deadline.reason);
    if (!reading && controllerRef !== undefined) flush(controllerRef);
  };
  const onClient = (): void => {
    dropFrames = true;
    end(undefined, signals.client.reason);
    if (!reading && controllerRef !== undefined) flush(controllerRef);
  };
  const accept = (line: string): void => {
    const event = parseCanonicalOutputEventV2Line(line);
    if (event === undefined) throw protocolError("Malformed upstream stream");
    encoder.push(event);
    if (encoder.terminal !== undefined) complete();
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
          signals.diagnostics?.published();
          emit((sequence) =>
            responseCreated({
              responseId: options.responseId,
              model: options.model,
              sequenceNumber: sequence,
              createdAt: options.createdAt,
              configuration: options.configuration,
            }),
          );
          emit((sequence) =>
            responseInProgress({
              responseId: options.responseId,
              model: options.model,
              sequenceNumber: sequence,
              createdAt: options.createdAt,
              configuration: options.configuration,
            }),
          );
          signals.deadline.addEventListener("abort", onDeadline, { once: true });
          signals.client.addEventListener("abort", onClient, { once: true });
          if (signals.deadline.aborted) onDeadline();
          else if (signals.client.aborted) onClient();
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
              reading = true;
              const next = await reader.read();
              reading = false;
              if (terminal) break;
              if (!next.done) {
                buffer += decoder.decode(next.value, { stream: true });
                continue;
              }
              buffer += decoder.decode();
              const finalLine = buffer.trim();
              buffer = "";
              if (finalLine.length > 0) accept(finalLine);
              if (!terminal) end(streamFailure("upstream_stream_incomplete"));
            }
          } catch (error) {
            reading = false;
            if (!terminal) {
              const failure =
                error instanceof HostedResponsesOutputError
                  ? { code: error.code, message: error.message }
                  : normalizeStreamFailure(error);
              signals.diagnostics?.failure(error, "projection");
              end({ code: failure.code, message: failure.message }, error);
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
        "X-Kiro-Usage-Policy":
          options.usageMode === "strict" ? "measured-only" : "compatible-estimates",
        "X-Reasoning-Included": "true",
      },
    },
  );
}
