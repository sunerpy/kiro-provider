import { auditLog } from "../core/audit-log.js";
import { abortReason } from "../core/pipeline-runtime.js";
import {
  abandonPreparedStream,
  finishPreparedStream,
  type PreparedCanonicalStream,
  StreamIdleTimeoutError,
} from "../core/pipeline-stream.js";
import { boundedCleanup, runCleanupSteps } from "../core/stream-cleanup.js";
import type { SdkReasoningCapture } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import { textPart } from "../protocol/adapter-utils.js";
import type {
  CanonicalMessage,
  CanonicalRequest,
  KiroReasoningContent,
  ResolvedReasoningReplay,
} from "../protocol/canonical.js";
import type { CodeReference } from "../protocol/code-references.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  type CanonicalOutputEvent,
  type CanonicalOutputUsage,
} from "../protocol/output.js";
import {
  CANONICAL_OUTPUT_V2,
  type CanonicalCompletionV2,
  type CanonicalOutputEventV2,
} from "../protocol/output-v2.js";
import type { ReportedTokenUsage, UsageAccounting } from "../protocol/usage.js";
import { CitationScanner, type CitationSegment, CitationSourceIndex } from "./citations.js";
import { WebSearchError } from "./errors.js";
import type { ProjectedSource } from "./projection.js";
import type { ExecutedHostedCall, HostedSearchSession } from "./session.js";

/**
 * The hosted search execution loop.
 *
 * One public request owns one account lease, one Kiro conversation and one
 * cancellation chain. Each generation is consumed in order; its complete tool
 * group decides the next step:
 *
 * - no tools: the response ends;
 * - client tools only: they are delivered and the response ends;
 * - hosted calls only (or any hosted call in Responses): each authorized call is
 *   budget-checked, executed through InvokeMCP and persisted, and the real tool
 *   results go back to the same conversation for the next generation;
 * - a Messages group mixing hosted and client calls: the hosted calls are
 *   recorded as deferred and returned unexecuted with the client calls.
 *
 * Messages may pause only at a stable checkpoint: a generation has ended and
 * no RPC has been dispatched for the calls it requested.
 */

export interface HostedGeneration {
  readonly prepared: PreparedCanonicalStream;
  readonly abortUpstream: (reason?: unknown) => void;
  readonly conversationId: string;
}

export interface HostedLoopRuntime {
  readonly session: HostedSearchSession;
  /** Canonical request of the first generation (pending results already filled). */
  readonly body: CanonicalRequest;
  /** Resolved reasoning replays of that request. */
  readonly replays: readonly ResolvedReasoningReplay[];
  /** Pending history calls executed before the first generation. */
  readonly prelude: readonly ExecutedHostedCall[];
  /** Sources already in this request's authenticated history. */
  readonly historySources: ReadonlyArray<{
    readonly callId: string;
    readonly sources: readonly ProjectedSource[];
  }>;
  readonly account: ManagedAccount;
  readonly region: string;
  readonly profileArn?: string;
  readonly wireModel: string;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly requestId?: string;
  /** Current credentials for the owner account (refreshed when near expiry). */
  authFor(signal: AbortSignal): Promise<KiroAuthDetails>;
  /** Dispatches the next generation in the same owner conversation. */
  continueWith(
    body: CanonicalRequest,
    replays: readonly ResolvedReasoningReplay[],
    signal: AbortSignal,
  ): Promise<HostedGeneration>;
}

function v2<T extends CanonicalOutputEventV2["type"]>(
  type: T,
  body: Omit<
    Extract<CanonicalOutputEventV2, { readonly type: T }>,
    "canonicalOutputVersion" | "type"
  >,
): CanonicalOutputEventV2 {
  return { canonicalOutputVersion: CANONICAL_OUTPUT_V2, type, ...body } as CanonicalOutputEventV2;
}

function toV2(event: Exclude<CanonicalOutputEvent, { readonly type: "completed" }>) {
  const { canonicalOutputVersion: _version, ...body } = event;
  return { canonicalOutputVersion: CANONICAL_OUTPUT_V2, ...body } as CanonicalOutputEventV2;
}

/**
 * Token usage summed over every generation. Context occupancy is the last
 * generation's: summing per-round context would overstate the window in use.
 */
export class UsageAccumulator {
  #input = 0;
  #output = 0;
  #reported: ReportedTokenUsage[] = [];
  #accounting: UsageAccounting[] = [];
  #count = 0;

  add(usage: CanonicalOutputUsage): void {
    this.#count += 1;
    this.#input += usage.inputTokens;
    this.#output += usage.outputTokens;
    if (usage.reported !== undefined) this.#reported.push(usage.reported);
    if (usage.accounting !== undefined) this.#accounting.push(usage.accounting);
  }

  get generations(): number {
    return this.#count;
  }

  total(): CanonicalOutputUsage {
    const usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reported?: ReportedTokenUsage;
      accounting?: UsageAccounting;
    } = {
      inputTokens: this.#input,
      outputTokens: this.#output,
      totalTokens: this.#input + this.#output,
    };
    if (this.#count > 0 && this.#reported.length === this.#count) {
      const reported: Record<string, number> = {};
      const keys = new Set(this.#reported.flatMap((entry) => Object.keys(entry)));
      for (const key of keys) {
        const values = this.#reported.map((entry) => entry[key as keyof ReportedTokenUsage]);
        if (values.every((value) => typeof value === "number")) {
          reported[key] = values.reduce((sum, value) => sum + (value as number), 0);
        }
      }
      if (
        reported.inputTokens === usage.inputTokens &&
        reported.outputTokens === usage.outputTokens &&
        (reported.totalTokens === undefined || reported.totalTokens === usage.totalTokens)
      ) {
        usage.reported = reported as ReportedTokenUsage;
      }
    }
    const last = this.#accounting.at(-1);
    if (last !== undefined && this.#accounting.length === this.#count) {
      const units = new Set(this.#accounting.map((entry) => entry.metering?.unit));
      const metering =
        units.size === 1 && !units.has(undefined)
          ? {
              value: this.#accounting.reduce((sum, entry) => sum + (entry.metering?.value ?? 0), 0),
              unit: last.metering?.unit as string,
            }
          : undefined;
      usage.accounting = {
        input: this.#accounting.every((entry) => entry.input === "upstream")
          ? "upstream"
          : "estimated",
        output: this.#accounting.every((entry) => entry.output === "upstream")
          ? "upstream"
          : "estimated",
        context: last.context,
        ...(last.contextUsagePercentage !== undefined
          ? { contextUsagePercentage: last.contextUsagePercentage }
          : {}),
        ...(last.contextUsageWindow !== undefined
          ? { contextUsageWindow: last.contextUsageWindow }
          : {}),
        ...(last.percentageSaturated !== undefined
          ? { percentageSaturated: last.percentageSaturated }
          : {}),
        ...(metering !== undefined ? { metering } : {}),
      };
    }
    return usage;
  }
}

function nextEvent(
  prepared: PreparedCanonicalStream,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<IteratorResult<CanonicalOutputEvent>> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const { iterator, telemetry } = prepared;
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      stopIdle();
      telemetry.onUpstreamReadSettled();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      settle();
      reject(abortReason(signal));
    };
    const stopIdle = telemetry.watchIdle(idleTimeoutMs, () => {
      settle();
      reject(new StreamIdleTimeoutError(idleTimeoutMs));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        settle();
        resolve(result);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

/** Reads one generation in order; owns its terminal telemetry and upstream teardown. */
async function* readGeneration(
  generation: HostedGeneration,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<CanonicalOutputEvent> {
  const { prepared } = generation;
  let finished = false;
  try {
    for (const event of prepared.prefetched.splice(0)) yield event;
    while (true) {
      const next = await nextEvent(prepared, signal, idleTimeoutMs);
      if (next.done) break;
      prepared.telemetry.observeCanonicalEvent(next.value);
      yield next.value;
    }
    finished = true;
    auditLog("info", "sdk_stream_completed", prepared.telemetry.auditFields());
    prepared.telemetry.emitTerminal("normal_complete");
    await finishPreparedStream(prepared);
  } finally {
    if (!finished) {
      const reason = signal.aborted ? abortReason(signal) : new Error("hosted generation ended");
      prepared.telemetry.emitTerminal(signal.aborted ? "external_abort" : "upstream_error");
      await abandonPreparedStream(prepared, generation.abortUpstream, reason);
    }
  }
}

function replayFromCapture(
  capture: SdkReasoningCapture | undefined,
): KiroReasoningContent | undefined {
  if (capture === undefined) return undefined;
  if (capture.redactedContent !== undefined && capture.redactedContent.byteLength > 0) {
    return { kind: "redacted_content", bytes: capture.redactedContent };
  }
  if (capture.signature !== undefined && capture.signature.length > 0) {
    return { kind: "reasoning_text", text: capture.text, signature: capture.signature };
  }
  return undefined;
}

function segmentEvent(
  segment: CitationSegment,
  session: HostedSearchSession,
): CanonicalOutputEventV2 {
  if (segment.kind === "text") return v2("text_delta", { text: segment.text });
  return v2("citation", {
    text: segment.text,
    ...session.citation(segment.citation.callId, segment.citation.source),
  });
}

interface GroupCall {
  readonly index: number;
  id: string;
  name: string;
  arguments: string;
}

function argumentsObject(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function* hostedSearchEvents(
  runtime: HostedLoopRuntime,
  first: HostedGeneration,
): AsyncGenerator<CanonicalOutputEventV2> {
  const { session } = runtime;
  const usage = new UsageAccumulator();
  const sources = new CitationSourceIndex();
  for (const entry of runtime.historySources) sources.add(entry.callId, entry.sources);
  const codeReferences: CodeReference[] = [];
  const generationCap = runtime.session.config.web_search_max_calls + 1;
  let generation: HostedGeneration | undefined = first;
  let body = runtime.body;
  let replays = runtime.replays;
  let started = false;

  const finish = (finishReason: "stop" | "tool_calls" | "pause"): CanonicalOutputEventV2 =>
    v2("completed", {
      finishReason,
      usage: usage.total(),
      webSearchRequests: session.webSearchRequests,
      ...(codeReferences.length > 0 ? { codeReferences } : {}),
    });

  while (generation !== undefined) {
    const current = generation;
    generation = undefined;
    const generationKey = session.beginGeneration();
    if (started) yield v2("generation_started", { key: generationKey });
    const group = new Map<number, GroupCall>();
    let text = "";
    const scanner = new CitationScanner(sources);
    for await (const event of readGeneration(current, runtime.signal, runtime.idleTimeoutMs)) {
      switch (event.type) {
        case "started":
          if (!started) {
            started = true;
            yield toV2(event);
            yield v2("generation_started", { key: generationKey });
            for (const call of runtime.prelude) {
              for (const prelude of call.events) {
                if (prelude.type === "search_result") {
                  sources.add(call.callId, session.sourcesForCitation(call.callId));
                }
                yield prelude;
              }
            }
          }
          continue;
        case "reasoning_delta":
        case "reasoning_signature":
        case "reasoning_redacted":
        case "reasoning_encrypted":
          yield toV2(event);
          continue;
        case "text_delta":
          text += event.text;
          for (const segment of scanner.push(event.text)) yield segmentEvent(segment, session);
          continue;
        case "tool_call_delta": {
          const call = group.get(event.index) ?? {
            index: event.index,
            id: "",
            name: "",
            arguments: "",
          };
          if (call.id.length === 0 && event.id !== undefined) call.id = event.id;
          if (call.name.length === 0 && event.name !== undefined) call.name = event.name;
          call.arguments += event.arguments;
          group.set(event.index, call);
          continue;
        }
        case "completed":
          usage.add(event.usage);
          if (event.codeReferences !== undefined) codeReferences.push(...event.codeReferences);
          continue;
      }
    }
    for (const segment of scanner.flush()) yield segmentEvent(segment, session);
    const calls = [...group.values()].sort((left, right) => left.index - right.index);
    if (calls.length === 0) {
      yield finish("stop");
      return;
    }
    const hosted = calls.filter((call) => session.isHostedWireName(call.name));
    const clients = calls.filter((call) => !session.isHostedWireName(call.name));
    const clientEvent = (call: GroupCall): CanonicalOutputEventV2 =>
      v2("tool_call_delta", {
        index: call.index,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    if (hosted.length === 0) {
      for (const call of clients) yield clientEvent(call);
      yield finish("tool_calls");
      return;
    }
    const capture = session.takeCapture();
    const groupIds = calls.map((call) => call.id);
    const binding = (call: GroupCall, query: string) =>
      session.binding({
        wireModel: runtime.wireModel,
        account: runtime.account,
        region: runtime.region,
        ...(runtime.profileArn !== undefined ? { profileArn: runtime.profileArn } : {}),
        conversationId: current.conversationId,
        wireId: call.id,
        group: groupIds,
        query,
      });
    const queryOf = (call: GroupCall): unknown => session.parseQuery(call.arguments);
    const pauseFor = (): "deadline" | "iteration_limit" | undefined => {
      if (usage.generations >= generationCap) return "iteration_limit";
      if (session.remainingMs() < session.config.web_search_timeout_ms) return "deadline";
      return undefined;
    };
    if (session.protocol === "anthropic-messages") {
      const pause = clients.length > 0 ? undefined : pauseFor();
      if (clients.length > 0 || pause !== undefined) {
        // A stable checkpoint: nothing has been dispatched for these calls.
        // The whole group is recorded before any of it is published.
        const deferred = new Map(
          hosted.map((call) => {
            const query = queryOf(call);
            return [
              call.id,
              {
                callId: session.publicIdFor(call.id),
                query: typeof query === "string" ? query : "",
              },
            ] as const;
          }),
        );
        session.deferGroup(
          hosted.map((call) => {
            const entry = deferred.get(call.id) as { callId: string; query: string };
            return {
              callId: entry.callId,
              status: clients.length > 0 ? ("deferred" as const) : ("paused" as const),
              reason:
                clients.length > 0
                  ? ("mixed_tool_group" as const)
                  : (pause as "deadline" | "iteration_limit"),
              binding: binding(call, entry.query),
            };
          }),
        );
        for (const call of calls) {
          const entry = deferred.get(call.id);
          if (entry === undefined) {
            yield clientEvent(call);
            continue;
          }
          yield v2("search_call_started", {
            callId: entry.callId,
            query: entry.query,
            deferred: true,
          });
        }
        auditLog("info", "web_search_turn_deferred", {
          request_id: runtime.requestId,
          reason: clients.length > 0 ? "mixed_tool_group" : pause,
          hosted_call_count: hosted.length,
          client_call_count: clients.length,
        });
        yield finish(clients.length > 0 ? "tool_calls" : "pause");
        return;
      }
    } else if (usage.generations >= generationCap) {
      throw new WebSearchError(
        "Hosted web search exceeded its generation limit",
        "web_search_iteration_limit",
        502,
      );
    }
    const results = new Map<string, ExecutedHostedCall>();
    // Every published call identity is recorded before it becomes visible, and
    // the whole group is announced before any search runs, so a client can
    // always tell which calls one generation made.
    const planned = hosted.map((call) => {
      const query = queryOf(call);
      return { call, query, callId: session.publicIdFor(call.id) };
    });
    // All or none of the group is claimed; a partial failure leaves nothing.
    const claimedGroup = session.startGroup(
      planned.map((entry) => ({
        callId: entry.callId,
        binding: binding(entry.call, typeof entry.query === "string" ? entry.query : ""),
      })),
    );
    const claims = planned.map((entry, index) => ({
      ...entry,
      claimed: claimedGroup[index] as (typeof claimedGroup)[number],
    }));
    let executing = 0;
    try {
      for (const claim of claims) {
        yield v2("search_call_started", {
          callId: claim.callId,
          query: typeof claim.query === "string" ? claim.query : "",
          deferred: false,
        });
      }
      for (const claim of claims) {
        const auth = await runtime.authFor(runtime.signal);
        const executed = await session.execute(
          claim.claimed,
          claim.query,
          auth,
          runtime.region,
          runtime.signal,
        );
        executing += 1;
        if (executed.ok) sources.add(claim.callId, session.sourcesForCitation(claim.callId), true);
        for (const event of executed.events) yield event;
        results.set(claim.call.id, executed);
      }
    } finally {
      // Calls this response announced but never finished cannot be resumed.
      for (const claim of claims.slice(executing)) {
        if (!results.has(claim.call.id)) session.abandon(claim.claimed);
      }
    }
    if (clients.length > 0) {
      // Responses: hosted calls are complete; client calls await their outputs.
      for (const call of clients) yield clientEvent(call);
      yield finish("tool_calls");
      return;
    }
    const assistantIndex = body.messages.length;
    const path = `hosted.generation.${usage.generations}`;
    const assistant: CanonicalMessage = {
      role: "assistant",
      content: text.length > 0 ? [textPart(text, `${path}.text`)] : [],
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        input: argumentsObject(call.arguments),
        path: `${path}.tool_calls`,
      })),
      path,
    };
    const toolResults: CanonicalMessage = {
      role: "tool",
      content: calls.map((call) => {
        const executed = results.get(call.id);
        return {
          type: "tool_result" as const,
          toolCallId: call.id,
          content: [textPart(executed?.modelText ?? "", `${path}.tool_results`)],
          isError: executed?.ok !== true,
          path: `${path}.tool_results`,
        };
      }),
      toolCalls: [],
      path: `${path}.tool_results`,
    };
    body = { ...body, messages: [...body.messages, assistant, toolResults] };
    const replay = replayFromCapture(capture);
    if (replay !== undefined) {
      replays = [...replays, { insertBeforeMessage: assistantIndex, content: replay }];
    }
    yield v2("generation_boundary", {});
    generation = await runtime.continueWith(body, replays, runtime.signal);
  }
}

export interface HostedStreamControl {
  /**
   * Aborts the loop's in-flight search RPC and generation, including a first
   * generation the loop never started reading; resolves once that is torn down.
   */
  readonly abort: (reason: unknown) => Promise<void>;
  /** Records every claim the loop did not finish as uncertain. */
  readonly settle: () => void;
}

/**
 * NDJSON v2 stream. A cancel, an abort or a failure first aborts the loop, then
 * waits (bounded) for it to unwind and settles any claim it left executing;
 * only then does the `finalize` cleanup resolve and the lease become free.
 */
export function createHostedStreamResponse(
  events: AsyncGenerator<CanonicalOutputEventV2>,
  signal: AbortSignal,
  control: HostedStreamControl,
  finalize: (cleanup: Promise<void>) => void,
): Response {
  const encoder = new TextEncoder();
  let terminal = false;
  let inflight: Promise<unknown> | undefined;
  let finishCleanup: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const ignore = (): undefined => undefined;
  const end = (completed: boolean, reason?: unknown): Promise<void> => {
    if (terminal) return cleanup;
    terminal = true;
    signal.removeEventListener("abort", onAbort);
    let teardown: Promise<void> = Promise.resolve();
    if (!completed) {
      runCleanupSteps(() => {
        teardown = control.abort(
          reason ?? new DOMException("The hosted stream ended", "AbortError"),
        );
      });
    }
    const unwound = Promise.all([
      teardown.then(ignore, ignore),
      Promise.resolve(inflight)
        .then(ignore, ignore)
        .then(() => events.return(undefined))
        .then(ignore, ignore),
    ]);
    void boundedCleanup(() => unwound).then(() => {
      runCleanupSteps(control.settle);
      finishCleanup();
    });
    runCleanupSteps(() => finalize(cleanup));
    return cleanup;
  };
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onAbort = (): void => {
    const reason = abortReason(signal);
    controllerRef?.error(reason);
    void end(false, reason);
  };
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controllerRef = controller;
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        },
        async pull(controller) {
          if (terminal) return;
          try {
            const pending = events.next();
            inflight = pending;
            const next = await pending;
            inflight = undefined;
            if (terminal) return;
            if (next.done) {
              controller.close();
              await end(true);
              return;
            }
            controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
          } catch (error) {
            inflight = undefined;
            if (terminal) return;
            controller.error(error);
            await end(false, error);
          }
        },
        cancel(reason) {
          return end(false, reason);
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
  );
}

/** Non-stream v2: collects the same ordered events once execution has ended. */
export async function collectHostedCompletion(
  events: AsyncGenerator<CanonicalOutputEventV2>,
): Promise<Response> {
  const collected: CanonicalOutputEventV2[] = [];
  try {
    for await (const event of events) collected.push(event);
  } finally {
    await boundedCleanup(() => events.return(undefined).then(() => undefined));
  }
  const completion: CanonicalCompletionV2 = {
    canonicalOutputVersion: CANONICAL_OUTPUT_V2,
    events: collected,
  };
  return Response.json(completion, {
    headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE },
  });
}
