import type { Config } from "../config/schema.js";
import { auditLog } from "../core/audit-log.js";
import { boundedCleanup } from "../core/stream-cleanup.js";

export interface RequestAdmissionLease {
  /** Actual size is known only after the bounded upload has completed. */
  bodyRead(bytes: number): void;
  /** The returned function is called after execution and upstream teardown. */
  retainExecution(): () => void;
  wrapResponse(response: Response, client: AbortSignal): Promise<Response>;
}

type AdmissionConfig = Pick<
  Config,
  "max_inflight_requests" | "max_inflight_request_body_bytes" | "max_request_body_bytes"
>;

export type RequestAdmission =
  | { readonly ok: true; readonly lease: RequestAdmissionLease }
  | { readonly ok: false; readonly reason: "request_limit" | "body_budget" };

/**
 * One gate per HTTP application, shared by every tenant and generation route.
 * Reserve the maximum upload size, never a client-supplied Content-Length.
 * Count and bytes remain held through queueing and asynchronous stream cleanup.
 */
export class RequestAdmissionGate {
  #active = 0;
  #bytes = 0;

  constructor(private readonly config: AdmissionConfig) {
    if (config.max_inflight_request_body_bytes < config.max_request_body_bytes) {
      throw new TypeError(
        "max_inflight_request_body_bytes must be at least max_request_body_bytes",
      );
    }
  }

  acquire(): RequestAdmission {
    const reason =
      this.#active >= this.config.max_inflight_requests
        ? "request_limit"
        : this.#bytes + this.config.max_request_body_bytes >
            this.config.max_inflight_request_body_bytes
          ? "body_budget"
          : undefined;
    if (reason) {
      auditLog("warn", "request_admission_rejected", {
        reason,
        active_requests: this.#active,
        reserved_body_bytes: this.#bytes,
      });
      return { ok: false, reason };
    }
    this.#active++;
    this.#bytes += this.config.max_request_body_bytes;
    let bytes = this.config.max_request_body_bytes;
    let execution = 0;
    let responseDone = false;
    let released = false;
    const release = (): void => {
      if (released || !responseDone || execution > 0) return;
      released = true;
      this.#active--;
      this.#bytes -= bytes;
      auditLog("info", "request_admission_released", {
        active_requests: this.#active,
        reserved_body_bytes: this.#bytes,
      });
    };
    auditLog("info", "request_admission_acquired", {
      active_requests: this.#active,
      reserved_body_bytes: this.#bytes,
    });
    return {
      ok: true,
      lease: {
        bodyRead: (actual) => {
          if (released) return;
          const retained = Math.min(bytes, Math.max(0, actual));
          this.#bytes -= bytes - retained;
          bytes = retained;
        },
        retainExecution: () => {
          execution++;
          let finished = false;
          return () => {
            if (finished) return;
            finished = true;
            execution--;
            release();
          };
        },
        wrapResponse: (response, client) =>
          wrapAdmittedResponse(response, client, () => {
            responseDone = true;
            release();
          }),
      },
    };
  }
}

/** Do not release on Response creation: its body and execution may still retain the input. */
async function wrapAdmittedResponse(
  response: Response,
  client: AbortSignal,
  release: () => void,
): Promise<Response> {
  if (!response.body) {
    release();
    return response;
  }
  if (client.aborted && !response.ok) {
    // Bun does not consume a returned 499 once the socket has disconnected.
    // Drain the provider's error envelope here, then detach its bytes so direct
    // callers can still read it without retaining the abandoned request budget.
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } finally {
      release();
    }
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const reader = response.body.getReader();
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    client.removeEventListener("abort", onAbort);
    release();
  };
  const cancel = (reason?: unknown): Promise<void> => {
    cancellation ??= boundedCleanup(() => reader.cancel(reason)).then(finish, finish);
    return cancellation;
  };
  const onAbort = (): void => {
    void cancel(client.reason);
  };
  if (!client.aborted) client.addEventListener("abort", onAbort, { once: true });
  if (client.aborted) onAbort();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (finished) {
            controller.close();
            return;
          }
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              finish();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            controller.error(error);
            finish();
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
