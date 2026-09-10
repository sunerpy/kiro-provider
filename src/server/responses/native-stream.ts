import { randomUUID } from "node:crypto";
import { abortable } from "../../core/pipeline-runtime.js";
import { boundedCleanup, runCleanupSteps } from "../../core/stream-cleanup.js";
import { isRecord } from "../../protocol/adapter-utils.js";
import type { IngressSignals } from "../request-lifecycle.js";
import { type ResponseStateObject, responseState } from "./state.js";

export class NativeStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeStreamError";
  }
}

type NativeEvent = Record<string, unknown>;

interface NativeStreamOptions {
  readonly upstream: Response;
  readonly headers: Headers;
  readonly model: string;
  readonly signals: IngressSignals;
  readonly idleTimeoutMs: number;
  readonly normalize: (event: NativeEvent) => readonly NativeEvent[];
  readonly commit: (response: ResponseStateObject) => void;
  readonly terminal: (
    provenance: string,
    eventType?: string,
    response?: ResponseStateObject,
  ) => void;
  readonly finish: () => void;
  readonly abortUpstream: () => void;
  readonly renumber?: boolean;
}

const TERMINAL_STATUS: Readonly<Record<string, string>> = {
  "response.completed": "completed",
  "response.failed": "failed",
  "response.incomplete": "incomplete",
  "response.cancelled": "cancelled",
};

function hasSemanticContent(event: NativeEvent): boolean {
  if (["response.created", "response.in_progress", "response.queued"].includes(String(event.type)))
    return false;
  if (event.type === "response.output_item.added" && isRecord(event.item)) {
    const item = event.item;
    if (item.type === "message" && Array.isArray(item.content) && !item.content.length)
      return false;
    if (
      item.type === "reasoning" &&
      (!Array.isArray(item.summary) || !item.summary.length) &&
      (!Array.isArray(item.content) || !item.content.length) &&
      !item.encrypted_content
    )
      return false;
  }
  if (
    (event.type === "response.content_part.added" ||
      event.type === "response.reasoning_summary_part.added") &&
    isRecord(event.part) &&
    (event.part.text === "" || event.part.refusal === "")
  )
    return false;
  return event.delta !== "";
}

/** Incremental SSE reader. A transport EOF is never a completion witness. */
export async function createNativeStream(options: NativeStreamOptions): Promise<Response> {
  const body = options.upstream.body;
  if (!body)
    throw new NativeStreamError(
      "missing_upstream_stream",
      "Upstream response did not include a stream",
    );
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending: string[] = [];
  let buffer = "";
  let eof = false;
  let done = false;
  let finalized = false;
  let witnessed = false;
  let sequence = -1;
  let sourceSequence = -1;
  let responseId: string | undefined;
  let lastResponse: ResponseStateObject | undefined;
  let terminalCandidate:
    | { event: NativeEvent; prefix: string; response: ResponseStateObject }
    | undefined;
  let createdSeen = false;
  let clientClosed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (finalized) return;
    finalized = true;
    options.signals.combined.removeEventListener("abort", onAbort);
    runCleanupSteps(options.abortUpstream, options.finish);
    void boundedCleanup(() => reader.cancel());
  };
  const failure = (error: unknown): NativeStreamError =>
    error instanceof NativeStreamError
      ? error
      : options.signals.deadline.aborted
        ? new NativeStreamError("request_deadline_exceeded", "Request deadline exceeded")
        : new NativeStreamError("upstream_stream_error", "Upstream stream error");
  const failedEvent = (error: NativeStreamError): NativeEvent => ({
    type: "response.failed",
    sequence_number: ++sequence,
    response: {
      ...(lastResponse ??
        responseState({
          id: responseId ?? `resp_${randomUUID()}`,
          model: options.model,
          status: "in_progress",
        })),
      status: "failed",
      completed_at: null,
      incomplete_details: null,
      error: { code: error.code, message: error.message },
    },
  });
  const format = (event: NativeEvent, prefix = ""): string =>
    `${prefix}event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  const commitTerminal = (): void => {
    if (!terminalCandidate) return;
    try {
      options.commit(terminalCandidate.response);
    } catch {
      throw new NativeStreamError(
        "response_state_store_failed",
        "Response continuation could not be stored",
      );
    }
    witnessed = true;
    done = true;
    pending.push(format(terminalCandidate.event, terminalCandidate.prefix));
    options.terminal(
      "terminal_event",
      String(terminalCandidate.event.type),
      terminalCandidate.response,
    );
  };
  const fail = (error: unknown): void => {
    if (done) return;
    done = true;
    if (options.signals.client.aborted) {
      clientClosed = true;
      pending.length = 0;
      controller?.error(new DOMException("Client closed request", "AbortError"));
      options.terminal("client_abort");
    } else {
      const reason = failure(error);
      pending.push(format(failedEvent(reason)));
      options.terminal(reason.code);
    }
    finish();
  };
  const onAbort = (): void => fail(options.signals.combined.reason);
  const read = async (): ReturnType<typeof reader.read> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await abortable(
        Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new NativeStreamError(
                    "upstream_stream_idle_timeout",
                    "Upstream stream idle timeout",
                  ),
                ),
              options.idleTimeoutMs,
            );
          }),
        ]),
        options.signals.combined,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const nextFrame = async (): Promise<string | undefined> => {
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        return frame;
      }
      if (eof) {
        const frame = buffer;
        buffer = "";
        return frame.length ? frame : undefined;
      }
      const chunk = await read();
      if (chunk.done) {
        eof = true;
        buffer += decoder.decode();
      } else buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) {
        throw new NativeStreamError(
          "upstream_protocol_error",
          "Upstream SSE frame exceeds the 16 MiB limit",
        );
      }
    }
  };
  const accept = (frame: string): boolean => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data.length) {
      pending.push(`${frame}\n\n`);
      return false;
    }
    if (data === "[DONE]") {
      if (terminalCandidate) {
        commitTerminal();
        return true;
      }
      throw new NativeStreamError(
        "upstream_stream_incomplete",
        "Upstream stream ended before completion",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new NativeStreamError("upstream_protocol_error", "Upstream SSE data is not valid JSON");
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new NativeStreamError("upstream_protocol_error", "Upstream SSE event has no type");
    }
    if (terminalCandidate) {
      throw new NativeStreamError(
        "upstream_protocol_error",
        "Upstream sent an event after the terminal response",
      );
    }
    if (
      (value.type.startsWith("response.") && value.type !== "response.created" && !createdSeen) ||
      (typeof value.response_id === "string" &&
        responseId !== undefined &&
        value.response_id !== responseId)
    )
      throw new NativeStreamError(
        "upstream_protocol_error",
        "Upstream event does not belong to the active response lifecycle",
      );
    if (value.sequence_number !== undefined) {
      if (
        !Number.isSafeInteger(value.sequence_number) ||
        (value.sequence_number as number) <= sourceSequence
      ) {
        throw new NativeStreamError(
          "upstream_protocol_error",
          "Upstream event sequence is not increasing",
        );
      }
      sourceSequence = value.sequence_number as number;
    }
    if (value.type === "response.created") {
      if (createdSeen)
        throw new NativeStreamError("upstream_protocol_error", "Duplicate response.created event");
      createdSeen = true;
    }
    if (value.type === "error") {
      throw new NativeStreamError("upstream_stream_error", "Upstream returned an error event");
    }
    if (isRecord(value.response)) {
      if (
        typeof value.response.id !== "string" ||
        !Array.isArray(value.response.output) ||
        value.response.object !== "response" ||
        (responseId !== undefined && value.response.id !== responseId)
      ) {
        throw new NativeStreamError(
          "upstream_protocol_error",
          "Upstream response identity is invalid",
        );
      }
      responseId = value.response.id;
      if (TERMINAL_STATUS[value.type] && value.response.status !== TERMINAL_STATUS[value.type]) {
        throw new NativeStreamError(
          "upstream_protocol_error",
          "Upstream terminal status contradicts its event",
        );
      }
      if (
        value.type === "response.created" &&
        value.response.status !== "in_progress" &&
        value.response.status !== "queued"
      ) {
        throw new NativeStreamError(
          "upstream_protocol_error",
          "Upstream created response is not active",
        );
      }
    } else if (TERMINAL_STATUS[value.type] || value.type === "response.created") {
      throw new NativeStreamError(
        "upstream_protocol_error",
        "Upstream terminal event has no response",
      );
    }
    const prefix = lines
      .filter((line) => line.startsWith("id:") || line.startsWith("retry:"))
      .map((line) => `${line}\n`)
      .join("");
    const events = options.normalize(value);
    for (const [index, source] of events.entries()) {
      const event = options.renumber ? { ...source, sequence_number: ++sequence } : source;
      if (!options.renumber && typeof event.sequence_number === "number")
        sequence = event.sequence_number;
      if (isRecord(event.response)) lastResponse = event.response as unknown as ResponseStateObject;
      if (typeof event.type === "string" && TERMINAL_STATUS[event.type]) {
        terminalCandidate = {
          event,
          prefix: index === 0 ? prefix : "",
          response: lastResponse as ResponseStateObject,
        };
        continue;
      }
      pending.push(format(event, index === 0 ? prefix : ""));
    }
    return !terminalCandidate && events.some(hasSemanticContent);
  };
  // Hold lifecycle frames until a usable response exists, allowing typed HTTP failures
  // and bounded retries without publishing an abandoned upstream response ID.
  try {
    while (!done) {
      const frame = await nextFrame();
      if (frame === undefined) {
        if (terminalCandidate) {
          commitTerminal();
          break;
        }
        throw new NativeStreamError(
          "upstream_stream_incomplete",
          "Upstream stream ended before completion",
        );
      }
      if (accept(frame)) break;
    }
  } catch (error) {
    // The caller still owns the account lease and deadline until this function
    // returns a stream. A pre-publication retry only cancels this attempt.
    options.abortUpstream();
    void boundedCleanup(() => reader.cancel());
    throw failure(error);
  }
  if (done) finish();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(target) {
        controller = target;
        if (!done) {
          options.signals.combined.addEventListener("abort", onAbort, { once: true });
          if (options.signals.combined.aborted) onAbort();
        }
      },
      async pull(target) {
        if (!pending.length && !done) {
          try {
            while (!pending.length && !done) {
              const frame = await nextFrame();
              if (done) break;
              if (frame === undefined) {
                if (terminalCandidate) {
                  commitTerminal();
                  break;
                }
                throw new NativeStreamError(
                  "upstream_stream_incomplete",
                  "Upstream stream ended before completion",
                );
              }
              accept(frame);
            }
          } catch (error) {
            fail(error);
          }
        }
        if (clientClosed) return;
        const frame = pending.shift();
        if (frame !== undefined) target.enqueue(encoder.encode(frame));
        if (done && !pending.length) {
          target.close();
          finish();
        }
      },
      cancel() {
        if (!witnessed) options.terminal("consumer_cancel");
        done = true;
        pending.length = 0;
        finish();
      },
    }),
    { status: options.upstream.status, headers: options.headers },
  );
}
