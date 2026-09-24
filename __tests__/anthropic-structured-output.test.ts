import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { runChatCompletion } from "../src/core/pipeline.js";
import type { Effort } from "../src/kiro/types.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
} from "../src/protocol/output.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const MODEL = "claude-sonnet-5";
const SESSION_ID = "9d2f4c1e-structured-output-session";

/** The exact `output_config.format` Claude Code 2.1.280 sends for a session title. */
const CLAUDE_CODE_TITLE_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
} as const;

/** Headers Claude Code sends through kiroclaude's ANTHROPIC_CUSTOM_HEADERS. */
const CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
  "anthropic-beta": "structured-outputs-2025-11-13,interleaved-thinking-2025-05-14",
  "x-claude-code-session-id": SESSION_ID,
  "user-agent": "claude-cli/2.1.280 (external, cli)",
  "x-kiro-output-token-limit-mode": "advisory",
  "x-kiro-client-normalization": "claude-code-bash-v1",
  "x-kiro-working-directory-hash": "a".repeat(64),
};

const CLAUDE_CODE_TITLE_PROMPT = [
  "<session>",
  "user: Fix the replay migration that mis-fires on origin-first bindings",
  "</session>",
  "",
  "Summarize the session above in a short title.",
].join("\n");

function claudeCodeTitleRequest(
  stream: boolean,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 1024,
    stream,
    thinking: { type: "disabled" },
    system: [
      {
        type: "text",
        text: "Generate a concise title for this coding session. Respond with only the title.",
      },
    ],
    messages: [{ role: "user", content: CLAUDE_CODE_TITLE_PROMPT }],
    metadata: { user_id: `{"device_id":"fixture-device","session_id":"${SESSION_ID}"}` },
    tools: [],
    output_config: { format: CLAUDE_CODE_TITLE_FORMAT },
    ...overrides,
  };
}

function titleFormatWithProperty(
  propertySchema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { title: propertySchema },
      required: ["title"],
      additionalProperties: false,
    },
  };
}

/**
 * Builds the title format with a different property name. The computed key matters:
 * a literal `__proto__:` key in an object literal sets the prototype instead of an own
 * property and serializes as an empty `properties` object.
 */
function titleFormatNamed(propertyName: string): Record<string, unknown> {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { [propertyName]: { type: "string" } },
      required: [propertyName],
      additionalProperties: false,
    },
  };
}

/** The exact `output_config.format` Claude Code 2.1.280 sends for a `hook_prompt` evaluation. */
const CLAUDE_CODE_HOOK_PROMPT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      reason: { type: "string" },
      impossible: { type: "boolean" },
    },
    required: ["ok", "reason"],
    additionalProperties: false,
  },
} as const;

type Fixture = ReturnType<typeof fidelityFixture>;

function sendMessages(
  fixture: Fixture,
  body: unknown,
  overrides: Partial<RouteDependencies> = {},
  headers: Readonly<Record<string, string>> = CLAUDE_CODE_HEADERS,
  signal?: AbortSignal,
): Promise<Response> {
  return handleMessages(
    new Request("http://gateway/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }),
    fixture.config,
    { ...fixture.dependencies, ...overrides },
  );
}

const canonical = (event: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ canonicalOutputVersion: 1, ...event });

function canonicalCompletion(
  text: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Response {
  return new Response(
    JSON.stringify({
      canonicalOutputVersion: 1,
      conversationId: "synthetic-conversation",
      model: MODEL,
      createdAt: 1_700_000_000,
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      ...overrides,
    }),
    { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
  );
}

function startedLine(): string {
  return canonical({
    type: "started",
    conversationId: "synthetic-conversation",
    model: MODEL,
    createdAt: 1_700_000_000,
  });
}

function completedLine(finishReason: "stop" | "tool_calls" = "stop"): string {
  return canonical({
    type: "completed",
    finishReason,
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });
}

function canonicalStream(lines: readonly string[]): Response {
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE },
  });
}

function textStream(...deltas: readonly string[]): Response {
  return canonicalStream([
    startedLine(),
    // The canonical stream never carries an empty delta; "" means no text at all.
    ...deltas
      .filter((text) => text.length > 0)
      .map((text) => canonical({ type: "text_delta", text })),
    completedLine(),
  ]);
}

type SseFrame = { readonly event: string; readonly data: Record<string, unknown> };

function sseFrames(wire: string): SseFrame[] {
  return wire
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
      if (event === undefined || data === undefined) {
        throw new TypeError(`SSE frame is missing event or data: ${frame}`);
      }
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

function textDeltas(frames: readonly SseFrame[]): string {
  return frames
    .filter((frame) => frame.event === "content_block_delta")
    .map((frame) => {
      const delta = frame.data.delta as Record<string, unknown>;
      expect(delta.type).toBe("text_delta");
      return String(delta.text);
    })
    .join("");
}

function errorFrame(frames: readonly SseFrame[]): Record<string, unknown> {
  const frame = frames.find((candidate) => candidate.event === "error");
  if (!frame) throw new TypeError("expected an SSE error frame");
  return frame.data.error as Record<string, unknown>;
}

function expectStructuredSuccessStream(wire: string, expectedJson: string): SseFrame[] {
  const frames = sseFrames(wire);
  expect(frames.map((frame) => frame.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  expect(frames[1]?.data).toMatchObject({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  expect(textDeltas(frames)).toBe(expectedJson);
  expect(frames[4]?.data).toMatchObject({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
  });
  expect(typeof (frames[4]?.data.usage as Record<string, unknown>).output_tokens).toBe("number");
  expect(frames.some((frame) => frame.event === "error")).toBe(false);
  return frames;
}

function expectStructuredFailureStream(wire: string, code: string): SseFrame[] {
  const frames = sseFrames(wire);
  expect(frames[0]?.event).toBe("message_start");
  expect(frames.at(-1)?.event).toBe("error");
  expect(errorFrame(frames)).toMatchObject({ type: "api_error" });
  expect(String(errorFrame(frames).message)).toContain(`(code: ${code})`);
  expect(frames.some((frame) => frame.event.startsWith("content_block"))).toBe(false);
  expect(frames.some((frame) => frame.event === "message_delta")).toBe(false);
  expect(frames.some((frame) => frame.event === "message_stop")).toBe(false);
  return frames;
}

async function expectStructuredFailureResponse(response: Response, code: string): Promise<void> {
  const body = (await response.json()) as { error: { type: string; message: string } };
  expect(response.status).toBe(502);
  expect(body.error.type).toBe("api_error");
  expect(body.error.message).toContain(`(code: ${code})`);
  expect(response.headers.get("x-kiro-structured-output")).toBeNull();
}

let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

function realPipelineDependencies(
  events: Parameters<typeof makeSdkResponse>[0],
  overrides: Partial<RouteDependencies> = {},
): {
  readonly dependencies: Partial<RouteDependencies>;
  readonly commands: GenerateAssistantResponseCommand[];
  readonly efforts: (Effort | undefined)[];
} {
  const commands: GenerateAssistantResponseCommand[] = [];
  const efforts: (Effort | undefined)[] = [];
  return {
    commands,
    efforts,
    dependencies: {
      runPipeline: runChatCompletion,
      makeClient: (_auth, _region, effort) => ({
        async send(command) {
          efforts.push(effort);
          commands.push(command);
          return makeSdkResponse(events);
        },
      }),
      ...overrides,
    },
  };
}

describe("Claude Code session-title structured output on /v1/messages", () => {
  test("streams the exact Claude Code 2.1.280 title request as one validated JSON text block", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(true), {
        runPipeline: async (input) => {
          fixture.canonical.push(input.body);
          return textStream("Fix replay ", "migration");
        },
      });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-kiro-structured-output")).toBe("single-string-object-v1");
      const frames = expectStructuredSuccessStream(wire, '{"title":"Fix replay migration"}');
      expect(frames[0]?.data).toMatchObject({
        type: "message_start",
        message: { role: "assistant", model: MODEL, content: [] },
      });
      expect(frames[4]?.data).toMatchObject({ usage: { output_tokens: 7 } });
      // Raw upstream text is never published before validation.
      expect(wire).not.toContain('"text":"Fix replay "');

      // The schema never reaches the canonical request and no prompt is injected.
      const projected = fixture.canonical.at(-1);
      expect(projected).toBeDefined();
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain("json_schema");
      expect(serialized).not.toContain("additionalProperties");
      expect(serialized).not.toContain("output_config");
      expect(projected?.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(projected?.thinking).toEqual({ enabled: false });
      expect(projected?.tools).toEqual([]);

      const enforced = audit.events("anthropic_structured_output_enforced");
      expect(enforced).toHaveLength(1);
      expect(enforced[0]).toMatchObject({
        level: "info",
        model: MODEL,
        stream: true,
        local_profile: "single-string-object-v1",
      });
      expect(typeof enforced[0]?.schema_hash).toBe("string");
      expect(typeof enforced[0]?.property_hash).toBe("string");
      const auditLine = JSON.stringify(enforced[0]);
      expect(auditLine).not.toContain("title");
      expect(auditLine).not.toContain("Fix replay");
      expect(auditLine).not.toContain("<session>");
      expect(audit.events("anthropic_structured_output_failed")).toHaveLength(0);
      expect(audit.events("protocol_projection_rejected")).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });

  test("returns the same title request non-streamed as exactly one validated text block", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(false), {
        runPipeline: async () => canonicalCompletion("Fix replay migration"),
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-structured-output")).toBe("single-string-object-v1");
      expect(body).toMatchObject({
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: '{"title":"Fix replay migration"}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 7 },
      });
      expect((body.content as unknown[]).length).toBe(1);
      expect(JSON.parse((body.content as [{ text: string }])[0].text)).toEqual({
        title: "Fix replay migration",
      });
      expect(audit.events("anthropic_structured_output_enforced")).toMatchObject([
        { stream: false, local_profile: "single-string-object-v1" },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  test("accepts output_config.effort alongside format", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(
        fixture,
        claudeCodeTitleRequest(false, {
          output_config: { effort: "high", format: CLAUDE_CODE_TITLE_FORMAT },
        }),
        {
          runPipeline: async (input) => {
            fixture.canonical.push(input.body);
            return canonicalCompletion("Effortful title");
          },
        },
      );
      expect(response.status).toBe(200);
      expect(fixture.canonical.at(-1)).toMatchObject({
        reasoningEffort: "high",
        requestedReasoningEffort: "high",
      });
      expect(JSON.stringify(fixture.canonical.at(-1))).not.toContain("json_schema");
    } finally {
      fixture.database.close();
    }
  });
});

describe("Messages structured output normalization", () => {
  test.each([
    ['{"title":"Already JSON"}', '{"title":"Already JSON"}'],
    ['"A JSON string"', '{"title":"A JSON string"}'],
    ["  \n spaced title \t ", '{"title":"spaced title"}'],
    ['  {"title":"  padded  "}  ', '{"title":"padded"}'],
  ])(
    "normalizes upstream %j into the single property (non-stream and stream)",
    async (upstream, expected) => {
      const fixture = fidelityFixture();
      try {
        const nonStream = await sendMessages(fixture, claudeCodeTitleRequest(false), {
          runPipeline: async () => canonicalCompletion(upstream),
        });
        expect(nonStream.status).toBe(200);
        expect((await nonStream.json()) as Record<string, unknown>).toMatchObject({
          content: [{ type: "text", text: expected }],
        });
        const stream = await sendMessages(fixture, claudeCodeTitleRequest(true), {
          runPipeline: async () => textStream(upstream),
        });
        expect(stream.status).toBe(200);
        expectStructuredSuccessStream(await stream.text(), expected);
      } finally {
        fixture.database.close();
      }
    },
  );

  test("truncates to maxLength code points when the schema bounds the property", async () => {
    const fixture = fidelityFixture();
    const boundedFormat = titleFormatWithProperty({ type: "string", minLength: 1, maxLength: 8 });
    const upstream = "修复回放迁移标题过长了";
    const expected = `{"title":"${Array.from(upstream).slice(0, 8).join("")}"}`;
    try {
      const nonStream = await sendMessages(
        fixture,
        claudeCodeTitleRequest(false, { output_config: { format: boundedFormat } }),
        { runPipeline: async () => canonicalCompletion(upstream) },
      );
      expect(nonStream.status).toBe(200);
      expect((await nonStream.json()) as Record<string, unknown>).toMatchObject({
        content: [{ type: "text", text: expected }],
      });
      expect(Array.from(JSON.parse(expected).title as string)).toHaveLength(8);

      const stream = await sendMessages(
        fixture,
        claudeCodeTitleRequest(true, { output_config: { format: boundedFormat } }),
        { runPipeline: async () => textStream("修复回放", "迁移标题过长了") },
      );
      expect(stream.status).toBe(200);
      expectStructuredSuccessStream(await stream.text(), expected);
    } finally {
      fixture.database.close();
    }
  });

  test("fails closed on empty or unusable upstream text", async () => {
    for (const [upstream, code] of [
      ["", "structured_output_validation_failed"],
      ["   \n\t ", "structured_output_validation_failed"],
      ['{"wrong":"property"}', "structured_output_validation_failed"],
      ['{"title":"x","extra":"y"}', "structured_output_validation_failed"],
      ['{"title":42}', "structured_output_validation_failed"],
    ] as const) {
      const fixture = fidelityFixture();
      try {
        const nonStream = await sendMessages(fixture, claudeCodeTitleRequest(false), {
          runPipeline: async () => canonicalCompletion(upstream),
        });
        await expectStructuredFailureResponse(nonStream, code);
        expect(audit.events("anthropic_structured_output_failed").at(-1)).toMatchObject({
          level: "warn",
          model: MODEL,
          stream: false,
          code,
        });

        const stream = await sendMessages(fixture, claudeCodeTitleRequest(true), {
          runPipeline: async () => textStream(upstream),
        });
        expect(stream.status).toBe(200);
        const wire = await stream.text();
        expectStructuredFailureStream(wire, code);
        if (upstream.trim().length > 0) expect(wire).not.toContain(upstream.trim());
        expect(audit.events("anthropic_structured_output_failed").at(-1)).toMatchObject({
          stream: true,
          code,
        });
      } finally {
        fixture.database.close();
      }
    }
    for (const record of audit.events("anthropic_structured_output_failed")) {
      const line = JSON.stringify(record);
      expect(line).not.toContain("wrong");
      expect(line).not.toContain("property");
      expect(line).not.toContain("<session>");
    }
  });

  test("rejects code references that cannot describe the replaced text", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(false), {
        runPipeline: async () =>
          canonicalCompletion("Referenced title", {
            codeReferences: [{ recommendationContentSpan: { start: 0, end: 5 } }],
          }),
      });
      await expectStructuredFailureResponse(response, "structured_output_validation_failed");
    } finally {
      fixture.database.close();
    }
  });
});

describe("Messages structured output upstream guardrails", () => {
  test("rejects an upstream tool call before publishing any text (non-stream)", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(false), {
        runPipeline: async () =>
          canonicalCompletion("private raw title", {
            toolCalls: [{ id: "private-call-id", name: "private_tool_name", input: "{}" }],
            finishReason: "tool_calls",
          }),
      });
      await expectStructuredFailureResponse(response, "structured_output_unexpected_tool_call");
    } finally {
      fixture.database.close();
    }
  });

  test("rejects an upstream tool call before publishing any text (stream)", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            startedLine(),
            canonical({ type: "text_delta", text: "private raw title" }),
            canonical({
              type: "tool_call_delta",
              index: 0,
              id: "private-call-id",
              name: "private_tool_name",
              arguments: "{}",
            }),
            completedLine("tool_calls"),
          ]),
      });
      const wire = await response.text();
      expectStructuredFailureStream(wire, "structured_output_unexpected_tool_call");
      expect(wire).not.toContain("private raw title");
      expect(wire).not.toContain("private-call-id");
      expect(wire).not.toContain("private_tool_name");
      expect(audit.events("anthropic_structured_output_failed").at(-1)).toMatchObject({
        code: "structured_output_unexpected_tool_call",
        stream: true,
      });
    } finally {
      fixture.database.close();
    }
  });

  test("rejects a tool_calls finish reason without tool deltas (stream)", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            startedLine(),
            canonical({ type: "text_delta", text: "title" }),
            completedLine("tool_calls"),
          ]),
      });
      expectStructuredFailureStream(
        await response.text(),
        "structured_output_unexpected_tool_call",
      );
    } finally {
      fixture.database.close();
    }
  });

  test("never publishes a thinking block for a profile response", async () => {
    const fixture = fidelityFixture();
    try {
      const nonStream = await sendMessages(fixture, claudeCodeTitleRequest(false), {
        runPipeline: async () =>
          canonicalCompletion("Reasoned title", {
            reasoning: { text: "private reasoning", signature: "private-signature" },
          }),
      });
      const body = await nonStream.clone().text();
      await expectStructuredFailureResponse(nonStream, "structured_output_unexpected_reasoning");
      expect(body).not.toContain("private reasoning");

      const stream = await sendMessages(fixture, claudeCodeTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            startedLine(),
            canonical({ type: "reasoning_delta", text: "private reasoning" }),
            canonical({ type: "reasoning_signature", signature: "private-signature" }),
            canonical({ type: "text_delta", text: "Reasoned title" }),
            completedLine(),
          ]),
      });
      const wire = await stream.text();
      expectStructuredFailureStream(wire, "structured_output_unexpected_reasoning");
      expect(wire).not.toContain("private reasoning");
      expect(wire).not.toContain("private-signature");
      expect(wire).not.toContain("Reasoned title");
    } finally {
      fixture.database.close();
    }
  });

  test("fails closed when buffered text exceeds 64 KiB and publishes nothing first", async () => {
    const fixture = fidelityFixture();
    let cancelled = 0;
    try {
      const response = await sendMessages(fixture, claudeCodeTitleRequest(true), {
        runPipeline: async () => {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `${startedLine()}\n${canonical({ type: "text_delta", text: "x".repeat(32 * 1024) })}\n${canonical({ type: "text_delta", text: "y".repeat(32 * 1024 + 1) })}\n`,
                  ),
                );
              },
              cancel() {
                cancelled += 1;
              },
            }),
            { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
          );
        },
      });
      const wire = await response.text();
      await Bun.sleep(1);
      expectStructuredFailureStream(wire, "structured_output_buffer_exceeded");
      expect(wire).not.toContain("xxxx");
      expect(cancelled).toBe(1);
      expect(audit.events("anthropic_structured_output_failed").at(-1)).toMatchObject({
        code: "structured_output_buffer_exceeded",
        stream: true,
      });

      const nonStream = await sendMessages(fixture, claudeCodeTitleRequest(false), {
        runPipeline: async () => canonicalCompletion("z".repeat(64 * 1024 + 1)),
      });
      await expectStructuredFailureResponse(nonStream, "structured_output_buffer_exceeded");
    } finally {
      fixture.database.close();
    }
  });

  test("disposes the buffer and publishes nothing when the client aborts mid-stream", async () => {
    const fixture = fidelityFixture();
    const controller = new AbortController();
    const upstreamOpen = Promise.withResolvers<void>();
    let cancelled = 0;
    try {
      const response = await sendMessages(
        fixture,
        claudeCodeTitleRequest(true),
        {
          runPipeline: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(streamController) {
                  streamController.enqueue(
                    new TextEncoder().encode(
                      `${startedLine()}\n${canonical({ type: "text_delta", text: "partial private" })}\n`,
                    ),
                  );
                  upstreamOpen.resolve();
                },
                cancel() {
                  cancelled += 1;
                },
              }),
              { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
            ),
        },
        CLAUDE_CODE_HEADERS,
        controller.signal,
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("expected a streaming body");
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("message_start");
      await upstreamOpen.promise;
      controller.abort();
      const chunks: string[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(new TextDecoder().decode(next.value));
      }
      const rest = chunks.join("");
      expect(rest).not.toContain("partial private");
      expect(rest).not.toContain("content_block");
      expect(cancelled).toBe(1);
    } finally {
      fixture.database.close();
    }
  });
});

describe("Messages structured output request boundary", () => {
  async function expectAdapterRejection(
    body: Record<string, unknown>,
    code: string,
    param: string,
    messageFragment?: string,
  ): Promise<void> {
    const fixture = fidelityFixture();
    try {
      const response = await sendMessages(fixture, body);
      const payload = (await response.json()) as { error: { type: string; message: string } };
      expect(response.status).toBe(400);
      expect(payload.error.type).toBe("invalid_request_error");
      if (messageFragment !== undefined) expect(payload.error.message).toContain(messageFragment);
      expect(fixture.canonical).toHaveLength(0);
      const rejected = audit.events("protocol_projection_rejected").at(-1);
      expect(rejected).toMatchObject({ protocol: "anthropic-messages", code, param });
      expect(audit.events("anthropic_structured_output_enforced")).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  }

  const PROFILE_MESSAGE = "outside the supported local structured output profile";

  test.each([
    [
      "two properties",
      {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, subtitle: { type: "string" } },
          required: ["title", "subtitle"],
          additionalProperties: false,
        },
      },
    ],
    ["a non-string property", titleFormatWithProperty({ type: "integer" })],
    [
      "additionalProperties missing",
      {
        type: "json_schema",
        schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      },
    ],
    [
      "additionalProperties true",
      {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: true,
        },
      },
    ],
    [
      "required mismatch",
      {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
    [
      "required empty",
      {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    ],
    ["an extra format key", { ...CLAUDE_CODE_TITLE_FORMAT, name: "title", strict: true }],
    ["a non json_schema format type", { type: "text" }],
    ["a null format", null],
    ["a string format", "json_schema"],
    ["minLength 0", titleFormatWithProperty({ type: "string", minLength: 0, maxLength: 8 })],
    ["maxLength 300", titleFormatWithProperty({ type: "string", minLength: 1, maxLength: 300 })],
    [
      "minLength above maxLength",
      titleFormatWithProperty({ type: "string", minLength: 9, maxLength: 8 }),
    ],
    ["a fractional maxLength", titleFormatWithProperty({ type: "string", maxLength: 8.5 })],
    ["an extra property key", titleFormatWithProperty({ type: "string", pattern: "^.+$" })],
    [
      "a schema description",
      {
        type: "json_schema",
        schema: {
          type: "object",
          description: "title",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    ],
    [
      "an empty properties object",
      {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {},
          required: ["title"],
          additionalProperties: false,
        },
      },
    ],
    ["an invalid property name", titleFormatNamed("bad-name")],
    ["the Claude Code 2.1.280 prompt-hook evaluator schema", CLAUDE_CODE_HOOK_PROMPT_FORMAT],
  ])("rejects output_config.format with %s", async (_label, format) => {
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, { output_config: { format } }),
      "unsupported_structured_output",
      "output_config.format",
      PROFILE_MESSAGE,
    );
  });

  test.each(["__proto__", "prototype", "constructor"])(
    "rejects output_config.format whose only property is named %s",
    async (propertyName) => {
      const format = titleFormatNamed(propertyName);
      // Guard the wire shape itself so this case cannot silently regress into `properties: {}`.
      expect(JSON.stringify(format)).toContain(
        `"properties":{"${propertyName}":{"type":"string"}},"required":["${propertyName}"]`,
      );
      await expectAdapterRejection(
        claudeCodeTitleRequest(false, { output_config: { format } }),
        "unsupported_structured_output",
        "output_config.format",
        PROFILE_MESSAGE,
      );
    },
  );

  test("rejects enabled or adaptive thinking together with format", async () => {
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, { thinking: { type: "enabled", budget_tokens: 1024 } }),
      "unsupported_structured_output",
      "thinking",
    );
    await expectAdapterRejection(
      claudeCodeTitleRequest(true, { thinking: { type: "adaptive" } }),
      "unsupported_structured_output",
      "thinking",
    );
  });

  test("rejects a forced tool choice together with format", async () => {
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, {
        tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "lookup" },
      }),
      "unsupported_structured_output",
      "tool_choice",
    );
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, {
        tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object" } }],
        tool_choice: { type: "any" },
      }),
      "unsupported_structured_output",
      "tool_choice",
    );
  });

  test("keeps every other output_config key on the existing unsupported_parameter path", async () => {
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, {
        output_config: { format: CLAUDE_CODE_TITLE_FORMAT, task_budget: 1_000 },
      }),
      "unsupported_parameter",
      "output_config.task_budget",
      "output_config.task_budget is not supported",
    );
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, { output_config: { task_budget: 1_000 } }),
      "unsupported_parameter",
      "output_config.task_budget",
    );
  });

  test("keeps message-local output_config on the existing unsupported_message_field path", async () => {
    await expectAdapterRejection(
      claudeCodeTitleRequest(false, {
        messages: [
          {
            role: "user",
            content: CLAUDE_CODE_TITLE_PROMPT,
            output_config: { format: CLAUDE_CODE_TITLE_FORMAT },
          },
        ],
      }),
      "unsupported_message_field",
      "messages.0.output_config",
      "messages.0.output_config is not supported",
    );
  });

  test("still streams ordinary requests without output_config as before", async () => {
    const fixture = fidelityFixture();
    try {
      const request = claudeCodeTitleRequest(true);
      delete request.output_config;
      const response = await sendMessages(fixture, request, {
        runPipeline: async () => textStream("plain ", "text"),
      });
      const frames = sseFrames(await response.text());
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-structured-output")).toBeNull();
      expect(textDeltas(frames)).toBe("plain text");
      expect(audit.events("anthropic_structured_output_enforced")).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });
});

describe("Messages structured output through the real pipeline", () => {
  test.each([false, true])(
    "keeps output_config.effort upstream and strips the schema (stream=%s)",
    async (stream) => {
      const fixture = fidelityFixture();
      const real = realPipelineDependencies([
        { assistantResponseEvent: { content: "Fix replay migration" } },
      ]);
      try {
        const response = await sendMessages(
          fixture,
          claudeCodeTitleRequest(stream, {
            output_config: { effort: "high", format: CLAUDE_CODE_TITLE_FORMAT },
          }),
          real.dependencies,
        );
        expect(response.status).toBe(200);
        if (stream) {
          expectStructuredSuccessStream(await response.text(), '{"title":"Fix replay migration"}');
        } else {
          expect((await response.json()) as Record<string, unknown>).toMatchObject({
            content: [{ type: "text", text: '{"title":"Fix replay migration"}' }],
            stop_reason: "end_turn",
          });
        }
        expect(real.commands).toHaveLength(1);
        expect(real.efforts).toEqual(["high"]);
        const input = real.commands[0]?.input;
        expect(input?.conversationState?.currentMessage?.userInputMessage?.modelId).toBe(MODEL);
        const fields = input?.additionalModelRequestFields as Record<string, unknown> | undefined;
        expect(fields?.output_config).toEqual({ effort: "high" });
        const wire = JSON.stringify(input);
        expect(wire).not.toContain("json_schema");
        expect(wire).not.toContain("additionalProperties");
        expect(wire).not.toContain('"format"');
        expect(wire).not.toContain('"schema"');
        expect(wire).not.toContain('"title"');
      } finally {
        fixture.database.close();
      }
    },
  );

  test.each([false, true])(
    "maps a real upstream tool event to structured_output_unexpected_tool_call with one dispatch (stream=%s)",
    async (stream) => {
      const fixture = fidelityFixture({
        config: { rate_limit_max_retries: 3, stream_max_attempts: 3 },
      });
      const real = realPipelineDependencies([
        {
          toolUseEvent: {
            toolUseId: "private-tool-id",
            name: "private_tool_name",
            input: "{}",
            stop: true,
          },
        },
      ]);
      try {
        const response = await sendMessages(
          fixture,
          claudeCodeTitleRequest(stream),
          real.dependencies,
        );
        if (stream) {
          // The tool event arrives after the stream is committed, so the coded
          // failure terminates the SSE stream instead of changing the status.
          expect(response.status).toBe(200);
          const wire = await response.text();
          expectStructuredFailureStream(wire, "structured_output_unexpected_tool_call");
          expect(wire).not.toContain("private-tool-id");
          expect(wire).not.toContain("private_tool_name");
        } else {
          await expectStructuredFailureResponse(response, "structured_output_unexpected_tool_call");
        }
        expect(real.commands).toHaveLength(1);
        expect(audit.events("anthropic_structured_output_failed").at(-1)).toMatchObject({
          code: "structured_output_unexpected_tool_call",
        });
      } finally {
        fixture.database.close();
      }
    },
  );
});
