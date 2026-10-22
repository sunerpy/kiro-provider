import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "../src/config/schema.js";
import { openAiError } from "../src/server/errors.js";
import { translatePipelineError } from "../src/server/routes/messages.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";

const MODEL = "claude-opus-5-5";
const CONTEXT_CODE = "context_length_exceeded";
const UPSTREAM_PRIVATE_TEXT = "synthetic upstream-only diagnostic text";
const HISTORY = [
  { role: "user", content: "Inspect the synthetic status" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Checking the synthetic status" },
      { type: "tool_use", id: "fixture_call", name: "fixture_lookup", input: {} },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "fixture_call", content: "healthy" }],
  },
  { role: "assistant", content: "The synthetic status is healthy" },
  { role: "user", content: "Continue the synthetic task" },
];

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

function overflow(reason: string, nested = false): Error {
  if (reason === "legacy")
    return Object.assign(new Error("input is too long"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });
  const sdk = Object.assign(new Error(UPSTREAM_PRIVATE_TEXT), {
    name: "ValidationException",
    reason,
    $metadata: { httpStatusCode: 400 },
  });
  return nested ? new Error("synthetic SDK transport wrapper", { cause: sdk }) : sdk;
}

/** Real authenticated ingress -> canonical history -> pipeline -> SDK classification. */
function gateway(
  reason = "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
  nested = false,
  config: Partial<Config> = {},
) {
  const state = {
    fail: true,
    calls: 0,
    closed: 0,
    signals: [] as AbortSignal[],
    historyPreserved: false,
  };
  const f = messagesFixture([], {
    config: {
      max_inflight_requests: 1,
      rate_limit_max_retries: 3,
      stream_max_attempts: 3,
      ...config,
    },
    dependencies: {
      makeClient: () => ({
        async send(command, options) {
          state.calls += 1;
          state.signals.push(options.abortSignal);
          const history = JSON.stringify(command.input.conversationState?.history ?? []);
          state.historyPreserved = history.includes("fixture_call") && history.includes("healthy");
          if (state.fail) throw overflow(reason, nested);
          return {
            generateAssistantResponseResponse: (async function* () {
              try {
                yield { assistantResponseEvent: { content: "CONTINUED" } };
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
                  },
                };
              } finally {
                state.closed += 1;
              }
            })(),
          };
        },
      }),
    },
  });
  return {
    ...f,
    state,
    send(stream = false, key = MESSAGES_FIXTURE_KEY) {
      return f.request(
        {
          model: MODEL,
          stream,
          messages: HISTORY,
          tools: [
            {
              name: "fixture_lookup",
              description: "Read a synthetic status",
              input_schema: { type: "object", properties: {} },
            },
          ],
        },
        "/v1/messages",
        { key },
      );
    },
  };
}

describe("Messages context overflow is recognizable by Claude compaction", () => {
  for (const reason of ["CONTENT_LENGTH_EXCEEDS_THRESHOLD", "PROMPT_TOO_LONG", "legacy"]) {
    test.each([false, true])(
      `${reason} with tool history returns a pre-stream 400 (stream=%s)`,
      async (stream) => {
        const f = gateway(reason);
        const response = await f.send(stream);
        const wire = await response.text();
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/json");
        const body = JSON.parse(wire);
        expect(body.type).toBe("error");
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.message).toStartWith("Prompt is too long");
        expect(body.error.message).toContain(CONTEXT_CODE);
        expect(body.error.message).not.toContain(UPSTREAM_PRIVATE_TEXT);
        expect(body.error.details).toMatchObject({
          phase: "upstream_headers",
          attempt: 1,
          response_committed: false,
          completion_witnessed: false,
        });
        expect(wire).not.toContain("event: message_start");
        expect(wire).not.toContain("max 32MB");
        expect(f.state.calls).toBe(1);
        expect(f.state.historyPreserved).toBe(true);
        expect(audit.events("sdk_dispatch_started")).toHaveLength(1);
        const errors = audit.events("upstream_attempt_failed");
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          failure_code: "ValidationException",
          upstream_status: 400,
        });
        expect(JSON.stringify(audit.events())).not.toContain(UPSTREAM_PRIVATE_TEXT);

        // A terminal context error releases admission/account ownership after
        // its body is consumed; a later independent request can succeed.
        f.state.fail = false;
        const followup = await f.send(stream);
        const next = await followup.text();
        expect(followup.status).toBe(200);
        if (stream) expect(messagesSseEvents(next).at(-1)?.type).toBe("message_stop");
        else expect(JSON.parse(next).stop_reason).toBe("end_turn");
        expect(f.state.calls).toBe(2);
        expect(f.state.closed).toBe(1);
      },
    );
  }

  test("structured context reason in an SDK cause drives the translation", async () => {
    const f = gateway("CONTENT_LENGTH_EXCEEDS_THRESHOLD", true);
    const response = await f.send();
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toStartWith("Prompt is too long");
    expect(f.state.calls).toBe(1);
  });

  test("actual ingress body overflow remains 413 without SDK dispatch", async () => {
    const f = gateway("CONTENT_LENGTH_EXCEEDS_THRESHOLD", false, { max_request_body_bytes: 512 });
    const response = await f.request({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "x".repeat(2_048) }],
    });
    const wire = await response.text();
    expect(response.status).toBe(413);
    expect(JSON.parse(wire).error).toMatchObject({
      type: "request_too_large",
      message: "Request body exceeds the 512 byte limit",
    });
    expect(wire).not.toContain("Prompt is too long");
    expect(f.state.calls).toBe(0);
  });

  test("authentication still precedes context classification and dispatch", async () => {
    const f = gateway();
    const response = await f.send(true, "invalid-key");
    expect(response.status).toBe(401);
    await response.text();
    expect(f.state.calls).toBe(0);
  });

  test("Responses preserves its existing context error contract", async () => {
    const f = gateway();
    const response = await f.app(
      new Request("http://fixture/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          store: false,
          input: [{ role: "user", content: "Continue" }],
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: CONTEXT_CODE } });
    expect(f.state.calls).toBe(1);
  });

  test.each([
    ["request_too_large", "Request body exceeds the 33554432 byte limit"],
    ["other_error", "CONTENT_LENGTH_EXCEEDS_THRESHOLD"],
    [undefined, "input is too long"],
  ])("does not infer context overflow from a 413 message (code=%s)", async (code, message) => {
    const response = await translatePipelineError(
      openAiError(413, message, "upstream_error", code),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { message } });
  });

  test("an opaque 413 remains a size rejection", async () => {
    const response = await translatePipelineError(new Response("body too large", { status: 413 }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { message: "Upstream request failed with HTTP 413" },
    });
  });

  test.each([400, 502])(
    "does not reclassify a context code paired with HTTP %s",
    async (status) => {
      const response = await translatePipelineError(
        openAiError(status, "original failure", "upstream_error", CONTEXT_CODE),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { message: "original failure" } });
    },
  );

  test("an already committed stream keeps one SSE error and never retries the accepted generation", async () => {
    let closed = 0;
    const f = messagesFixture([], {
      config: { stream_max_attempts: 3, rate_limit_max_retries: 3, max_inflight_requests: 1 },
      stream: async function* () {
        try {
          yield { assistantResponseEvent: { content: "An accepted synthetic prefix" } };
          throw overflow("CONTENT_LENGTH_EXCEEDS_THRESHOLD");
        } finally {
          closed += 1;
        }
      },
    });
    const response = await f.request({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "Continue" }],
    });
    const wire = await response.text();
    const events = messagesSseEvents(wire);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          type: "overloaded_error",
          message: "Upstream stream error",
        }),
      }),
    ]);
    expect(events.some((event) => event.type === "message_stop")).toBe(false);
    expect(wire).not.toContain("max 32MB");
    expect(wire).not.toContain("Prompt is too long");
    expect(f.inputs).toHaveLength(1);
    expect(closed).toBe(1);
    for (
      let count = 0;
      count < 100 && audit.events("request_admission_released").length === 0;
      count += 1
    )
      await Bun.sleep(1);
    expect(f.state.aborted).toBe(1);
    expect(audit.events("request_admission_released").at(-1)).toMatchObject({
      active_requests: 0,
      reserved_body_bytes: 0,
    });
  });
});
