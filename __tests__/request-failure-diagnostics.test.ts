import { afterEach, describe, expect, test } from "bun:test";
import { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { RequestDiagnostics } from "../src/core/request-diagnostics.js";
import { retryAfterMs } from "../src/core/retry-after.js";
import { streamErrorAuditFields } from "../src/core/stream-error.js";
import { sendAcceptedStream } from "../src/core/upstream-acceptance.js";
import { readUpstreamErrorBody } from "../src/core/upstream-error-body.js";
import { createNativeStream } from "../src/server/responses/native-stream.js";
import { responseState } from "../src/server/responses/state.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

let audit: ReturnType<typeof captureAuditEvents> | undefined;
afterEach(() => audit?.restore());

describe("failure diagnostics and redaction", () => {
  test("native incomplete tool output preserves the authentic terminal reason", async () => {
    const initial = responseState({
      id: "resp-incomplete-tool",
      model: "gpt-5.6-sol",
      status: "in_progress",
    });
    const tool = {
      type: "function_call",
      id: "fc-partial",
      call_id: "call-partial",
      name: "lookup",
      arguments: '{"query":',
      status: "incomplete",
    };
    const events = [
      { type: "response.created", sequence_number: 0, response: initial },
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...tool, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        output_index: 0,
        item_id: tool.id,
        delta: tool.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        sequence_number: 3,
        output_index: 0,
        item_id: tool.id,
        arguments: tool.arguments,
      },
      { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: tool },
      {
        type: "response.incomplete",
        sequence_number: 5,
        response: {
          ...initial,
          status: "incomplete",
          output: [tool],
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ];
    const controller = new AbortController();
    const response = await createNativeStream({
      upstream: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      model: "gpt-5.6-sol",
      signals: {
        combined: controller.signal,
        deadline: controller.signal,
        client: controller.signal,
      },
      idleTimeoutMs: 1_000,
      normalize: (event) => [event],
      commit() {},
      terminal() {},
      finish() {},
      abortUpstream() {},
    });
    const text = await response.text();
    expect(text.match(/event: response.incomplete\n/g)).toHaveLength(1);
    expect(text).toContain('"reason":"max_output_tokens"');
    expect(text).not.toContain("event: response.failed");
    expect(text).not.toContain("event: response.completed");
  });

  test("masks adversarial unclosed JSON without a backtracking expression", () => {
    const trace = new RequestDiagnostics("req-braces");
    expect(trace.sanitize(`upstream ${"{".repeat(100_000)}`)).toBe("upstream [redacted payload]");
    expect(trace.sanitize('before {"tool":"private"} after')).toBe(
      "before [redacted payload] after",
    );
    expect(trace.sanitize('{"partial":"private')).toBe("[redacted payload]");
  });

  test("native stream errors keep source evidence through the terminal wrapper", async () => {
    const trace = new RequestDiagnostics("req-native-source");
    trace.dispatch(1);
    trace.headers(200, { "x-request-id": "upstream-native" });
    trace.accepted();
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: responseState({
          id: "resp-native-source",
          model: "gpt-5.6-sol",
          status: "in_progress",
        }),
      },
      {
        type: "error",
        sequence_number: 1,
        error: { code: "ServiceUnavailableException", message: "upstream busy", status: 503 },
      },
    ];
    const controller = new AbortController();
    const response = await createNativeStream({
      upstream: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      model: "gpt-5.6-sol",
      signals: {
        combined: controller.signal,
        deadline: controller.signal,
        client: controller.signal,
        diagnostics: trace,
      },
      idleTimeoutMs: 1_000,
      normalize: (event) => [event],
      commit() {},
      terminal() {},
      finish() {},
      abortUpstream() {},
    });
    const text = await response.text();
    expect(text.match(/event: response.failed\n/g)).toHaveLength(1);
    expect(text).not.toContain("event: response.completed");
    const source = {
      upstream_status: 503,
      upstream_code: "ServiceUnavailableException",
      upstream_request_id: "upstream-native",
    };
    expect(trace.snapshot().first_failure).toMatchObject(source);
    expect(trace.snapshot().last_failure).toMatchObject(source);
  });

  test("retains first and last upstream failures plus the immutable final cancellation", async () => {
    audit = captureAuditEvents();
    const trace = new RequestDiagnostics("req-fixture", ["account-access-secret", "client-secret"]);
    trace.hidePayload({ input: [{ role: "user", content: "private client prompt" }] });
    trace.dispatch(1);
    trace.headers(503, { "x-amzn-requestid": "upstream-1", "retry-after": "7" });
    trace.failure(
      Object.assign(
        new Error(
          "private client prompt; Bearer account-access-secret; cookie=session-secret; https://example.invalid/?token=private",
        ),
        { name: "ServiceUnavailableException", $metadata: { httpStatusCode: 503 } },
      ),
    );
    trace.dispatch(2);
    trace.headers(429, { "x-request-id": "upstream-2" });
    trace.failure(
      Object.assign(new Error("rate limited"), {
        name: "ThrottlingException",
        $metadata: { httpStatusCode: 429 },
      }),
    );
    trace.cancel("request_deadline");
    trace.cancel("consumer_cancel");
    trace.failure(new Error("cleanup must not replace the failure"));
    const response = await trace.response(
      Response.json(
        {
          error: {
            type: "upstream_error",
            message: "Request deadline exceeded",
            code: "request_timeout",
          },
        },
        { status: 504 },
      ),
    );
    const body = (await response.json()) as { error: { message: string; details: unknown } };
    expect(response.headers.get("x-request-id")).toBe("req-fixture");
    expect(body.error.details).toMatchObject({
      attempt: 2,
      cancel_source: "request_deadline",
      response_committed: false,
      first_failure: {
        upstream_status: 503,
        upstream_request_id: "upstream-1",
        upstream_retry_after_ms: 7_000,
      },
      last_failure: {
        upstream_status: 429,
        upstream_request_id: "upstream-2",
        upstream_retry_after_ms: null,
      },
    });
    expect(body.error.message).toContain("earlier upstream failure HTTP 429");
    const serialized = JSON.stringify([body, audit.events()]);
    for (const secret of [
      "private client prompt",
      "account-access-secret",
      "session-secret",
      "example.invalid",
      "client-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(JSON.stringify(audit.events())).not.toContain("rate limited");
  });

  test("retains nested actual SDK evidence and bounds cyclic or very long errors", () => {
    const trace = new RequestDiagnostics("req-cause");
    trace.dispatch(1);
    const sdkError = Object.assign(new Error(`upstream ${"x".repeat(4_096)}`), {
      name: "ServiceUnavailableException",
      $metadata: { httpStatusCode: 503, requestId: "sdk-id" },
    });
    const outer = new Error("local stream wrapper", { cause: sdkError });
    trace.failure(outer);
    expect(trace.snapshot().first_failure).toMatchObject({
      upstream_code: "ServiceUnavailableException",
      upstream_status: 503,
      upstream_request_id: "sdk-id",
    });
    expect(trace.snapshot().first_failure?.message.length).toBeLessThanOrEqual(1_024);
    const cycle: { message: string; cause?: unknown } = { message: "cycle" };
    cycle.cause = cycle;
    expect(() => trace.failure(cycle)).not.toThrow();
    expect(trace.snapshot().last_failure?.message).toBe("cycle");
  });

  test("rejects malicious identifier fields in diagnostics and audit outlets", () => {
    const trace = new RequestDiagnostics("req-identifiers", ["secret-id"]);
    trace.dispatch(1);
    trace.headers(503, { "x-request-id": "secret-id", "Retry-After": "1.5" });
    const hostile = Object.assign(new Error('tool arguments={"private":"data"}'), {
      name: "Bad\ninjected",
      code: "secret-id",
      $metadata: { httpStatusCode: 503, requestId: "bad\nid" },
    });
    trace.failure(hostile);
    expect(trace.snapshot().last_failure).toMatchObject({
      failure_code: null,
      upstream_code: null,
      upstream_request_id: null,
      upstream_retry_after_ms: 1_500,
    });
    const text = JSON.stringify([trace.snapshot(), streamErrorAuditFields(hostile, trace)]);
    for (const value of ["secret-id", "injected", "private", "bad\\nid"])
      expect(text).not.toContain(value);
  });

  test("HTTP Retry-After and local/upstream IDs survive the public error envelope", async () => {
    const trace = new RequestDiagnostics("req-http");
    trace.dispatch(1);
    trace.headers(503, { "x-amzn-requestid": "upstream-http", "Retry-After": "7" });
    trace.failure({ status: 503, code: "ServiceUnavailable", message: "busy" });
    const response = await trace.response(
      Response.json(
        {
          error: {
            type: "upstream_error",
            code: "service_unavailable",
            message: "busy",
            param: "model",
            raw_body: "must not be copied",
          },
        },
        { status: 503, headers: { "x-request-id": "upstream-http" } },
      ),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("req-http");
    expect(response.headers.get("x-kiro-upstream-request-id")).toBe("upstream-http");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      error: { request_id: "req-http", param: "model" },
    });
  });

  test("records actual body consumption and closes a cancelled reader once", async () => {
    audit = captureAuditEvents();
    const trace = new RequestDiagnostics("req-reader");
    let cancellations = 0;
    const response = await trace.publicResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event"));
          },
          cancel() {
            cancellations += 1;
          },
        }),
      ),
    );
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.byteLength).toBe(5);
    await reader?.cancel();
    trace.cleanup();
    trace.cleanup();
    expect(cancellations).toBe(1);
    expect(audit.events("response_body_closed")).toEqual([
      expect.objectContaining({ downstream_bytes: 5, cancel_source: "consumer_cancel" }),
    ]);
    expect(audit.events("request_cleanup_complete")).toHaveLength(1);
  });
});

describe("Retry-After parsing", () => {
  const now = Date.parse("Sun, 13 Sep 2026 00:00:00 GMT");
  test.each([
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
    { value: "", expected: undefined },
    { value: "0", expected: 0 },
    { value: " 1.5 ", expected: 1_500 },
    { value: "-1", expected: undefined },
    { value: "1abc", expected: undefined },
    { value: "Infinity", expected: undefined },
    { value: "Sun, 13 Sep 2026 00:00:07 GMT", expected: 7_000 },
    { value: "Sat, 12 Sep 2026 23:59:59 GMT", expected: 0 },
  ])("$value", ({ value, expected }) => expect(retryAfterMs(value, now)).toBe(expected));
});

describe("bounded upstream error-body reads", () => {
  test("decodes small JSON and ignores malformed or oversized bodies", async () => {
    const signal = new AbortController().signal;
    expect(await readUpstreamErrorBody(Response.json({ error: { code: "503" } }), signal)).toEqual({
      error: { code: "503" },
    });
    expect(await readUpstreamErrorBody(new Response("not JSON"), signal)).toBeUndefined();
    expect(await readUpstreamErrorBody(new Response("x".repeat(65_537)), signal)).toBeUndefined();
    expect(await readUpstreamErrorBody(new Response(null), signal)).toBeUndefined();
  });

  test("aborts a stalled body and asks the upstream reader to cancel", async () => {
    const abort = new AbortController();
    let cancelled = false;
    const pending = readUpstreamErrorBody(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
      abort.signal,
    );
    abort.abort(new Error("test cancelled"));
    await expect(pending).rejects.toThrow("test cancelled");
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
  });
});

describe("actual HTTP acceptance boundary", () => {
  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: "MANUAL",
      currentMessage: { userInputMessage: { content: "fixture", modelId: "auto" } },
    },
  });
  test("waits for ordinary SDK errors on unsuccessful HTTP responses", async () => {
    const source = Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    await expect(
      sendAcceptedStream(
        {
          async send(_command, options) {
            options.onResponseHeaders?.({
              status: 403,
              headers: { "content-type": "application/json" },
            });
            throw source;
          },
        },
        command,
        { abortSignal: new AbortController().signal },
      ),
    ).rejects.toBe(source);
  });

  test("rejects successful JSON pretending to be an EventStream", async () => {
    await expect(
      sendAcceptedStream(
        {
          async send(_command, options) {
            options.onResponseHeaders?.({
              status: 200,
              headers: { "content-type": "application/json" },
            });
            return {};
          },
        },
        command,
        { abortSignal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  test("accepts real headers before SDK deserialization and retains a later decoder failure", async () => {
    const sent = Promise.withResolvers<never>();
    const response = await sendAcceptedStream(
      {
        send(_command, options) {
          options.onResponseHeaders?.({
            status: 200,
            headers: { "content-type": "application/vnd.amazon.eventstream" },
          });
          return sent.promise;
        },
      },
      command,
      { abortSignal: new AbortController().signal },
    );
    const iterator = response.generateAssistantResponseResponse?.[Symbol.asyncIterator]();
    const next = iterator?.next();
    sent.reject(new Error("decoder failed"));
    await expect(next).rejects.toThrow("decoder failed");
  });
});
