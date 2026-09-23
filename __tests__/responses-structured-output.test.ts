import { describe, expect, test } from "bun:test";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const TITLE_FORMAT = {
  type: "json_schema",
  name: "codex_output_schema",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: 36,
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const;

function codexTitleRequest(stream: boolean): Record<string, unknown> {
  return {
    model: "gpt-5.6-sol",
    instructions: "Generate one concise title in the user's language.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix the synthetic login timeout" }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "max", summary: "none" },
    store: false,
    stream,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "synthetic-title-thread",
    text: { format: TITLE_FORMAT },
    client_metadata: {
      thread_id: "synthetic-thread-id",
      request_kind: "turn",
    },
  };
}

function outputText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("output" in body)) return undefined;
  const output = Reflect.get(body, "output");
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (typeof item !== "object" || item === null || Reflect.get(item, "type") !== "message") {
      continue;
    }
    const content = Reflect.get(item, "content");
    if (!Array.isArray(content)) continue;
    const part = content.find(
      (candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        Reflect.get(candidate, "type") === "output_text",
    );
    if (part && typeof Reflect.get(part, "text") === "string") {
      return Reflect.get(part, "text") as string;
    }
  }
  return undefined;
}

describe("bounded local Responses structured output", () => {
  test("accepts the Codex title profile and returns a schema-valid single-string object", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await fixture.send(codexTitleRequest(false));
      const body: unknown = await response.json();
      if (response.status !== 200) {
        throw new Error(`expected HTTP 200, received ${response.status}: ${JSON.stringify(body)}`);
      }

      expect(response.headers.get("X-Kiro-Transport")).toBe("stateless");
      expect(fixture.requests).toHaveLength(0);
      expect(response.headers.get("X-Kiro-Compatibility")).toContain(
        "structured_output_locally_enforced",
      );
      expect(outputText(body)).toBe('{"title":"OK"}');
      expect(Reflect.get(body as object, "text")).toEqual({ format: TITLE_FORMAT });
      expect(Reflect.get(body as object, "store")).toBe(false);
      expect(
        fixture.responseStore.get("fidelity-test", String(Reflect.get(body as object, "id"))),
      ).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });
});

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
      model: "gpt-5.6-sol",
      createdAt: 1_700_000_000,
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reported: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      },
      ...overrides,
    }),
    { headers: { "Content-Type": "application/x-kiro-provider-output+json; charset=utf-8" } },
  );
}

function canonicalStream(lines: readonly string[]): Response {
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "application/x-kiro-provider-output+ndjson; charset=utf-8" },
  });
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("local structured output routing and projection", () => {
  test("buffers raw upstream text and publishes only the validated JSON SSE lifecycle", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await fixture.send(codexTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            canonical({
              type: "started",
              conversationId: "synthetic-conversation",
              model: "gpt-5.6-sol",
              createdAt: 1_700_000_000,
            }),
            canonical({ type: "text_delta", text: "修复 " }),
            canonical({ type: "text_delta", text: "KiroCodex 标题" }),
            canonical({
              type: "completed",
              finishReason: "stop",
              usage: {
                inputTokens: 11,
                outputTokens: 7,
                totalTokens: 18,
                reported: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
              },
            }),
          ]),
      });
      const events = sseEvents(await response.text());
      const expectedJson = '{"title":"修复 KiroCodex 标题"}';

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Kiro-Transport")).toBe("stateless");
      expect(response.headers.get("X-Kiro-Compatibility")).toContain(
        "structured_output_locally_enforced",
      );
      expect(response.headers.get("X-Kiro-Compatibility")).toContain(
        "structured_output_stream_buffered",
      );
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
      const deltas = events
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => String(event.delta))
        .join("");
      expect(deltas).toBe(expectedJson);
      expect(deltas).not.toContain('"delta":"修复 ');
      expect(events.find((event) => event.type === "response.output_text.done")?.text).toBe(
        expectedJson,
      );
      expect(
        Reflect.get(
          Reflect.get(
            events.find((event) => event.type === "response.content_part.done") as object,
            "part",
          ) as object,
          "text",
        ),
      ).toBe(expectedJson);
      expect(
        events.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject({
        type: "message",
        content: [{ type: "output_text", text: expectedJson }],
      });
      for (const type of ["response.created", "response.in_progress", "response.completed"]) {
        const stateEvent = events.find((event) => event.type === type);
        expect(
          Reflect.get(Reflect.get(stateEvent as object, "response") as object, "text"),
        ).toEqual({ format: TITLE_FORMAT });
      }
      const completed = events.at(-1);
      expect(
        Reflect.get(Reflect.get(completed as object, "response") as object, "usage"),
      ).toMatchObject({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    } finally {
      fixture.database.close();
    }
  });

  test("keeps strict fidelity fail-closed before upstream dispatch", async () => {
    const fixture = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    try {
      const response = await fixture.send(codexTitleRequest(false));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: "invalid_request_error",
          code: "unsupported_response_semantics",
          param: "text.format",
        },
      });
      expect(fixture.canonical).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });

  test("keeps complex JSON Schema unsupported in compatible mode", async () => {
    const fixture = fidelityFixture();
    try {
      const request = codexTitleRequest(false);
      request.text = {
        format: {
          ...TITLE_FORMAT,
          schema: {
            type: "object",
            properties: { title: { type: "string" }, subtitle: { type: "string" } },
            required: ["title", "subtitle"],
            additionalProperties: false,
          },
        },
      };
      const response = await fixture.send(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported_structured_output", param: "text.format" },
      });
      expect(fixture.canonical).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });

  test("fails closed when a completed upstream output is not convertible", async () => {
    for (const [text, overrides, expectedCode] of [
      ["   ", {}, "structured_output_validation_failed"],
      ['{"wrong":"value"}', {}, "structured_output_validation_failed"],
      ["", { reasoning: { text: "private reasoning" } }, "structured_output_validation_failed"],
      [
        "ignored",
        {
          toolCalls: [{ id: "call-1", name: "undeclared", input: "{}" }],
          finishReason: "tool_calls",
        },
        "structured_output_unexpected_tool_call",
      ],
      [
        "title",
        { codeReferences: [{ recommendationContentSpan: { start: 0, end: 5 } }] },
        "structured_output_validation_failed",
      ],
    ] as const) {
      const fixture = fidelityFixture();
      try {
        const response = await fixture.send(codexTitleRequest(false), {
          runPipeline: async () => canonicalCompletion(text, overrides),
        });
        const body = await response.json();
        expect(response.status).toBe(502);
        expect(body).toMatchObject({
          error: { type: "upstream_error", code: expectedCode, param: "text.format" },
        });
        expect(JSON.stringify(body)).not.toContain("private reasoning");
      } finally {
        fixture.database.close();
      }
    }
  });

  test("treats omitted store as local store=false without writing response state", async () => {
    const fixture = fidelityFixture();
    try {
      const request = codexTitleRequest(false);
      delete request.store;
      const response = await fixture.send(request);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body.store).toBe(false);
      expect(response.headers.get("X-Kiro-Compatibility")).toContain(
        "structured_output_store_defaulted_false",
      );
      expect(fixture.responseStore.get("fidelity-test", String(body.id))).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });
});

describe("local structured output request boundary", () => {
  test.each([
    ["store", true, "store"],
    ["previous_response_id", "resp_previous", "previous_response_id"],
    ["conversation", "conv_previous", "conversation"],
    ["background", true, "background"],
  ])("rejects %s before dispatch", async (field, value, expectedParam) => {
    const fixture = fidelityFixture();
    try {
      const request = codexTitleRequest(false);
      request[field] = value;
      const response = await fixture.send(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported_response_semantics", param: expectedParam },
      });
      expect(fixture.canonical).toHaveLength(0);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });

  test.each([
    {
      type: "function_call",
      id: "fc_history",
      call_id: "call_history",
      name: "lookup",
      arguments: "{}",
      status: "completed",
    },
    {
      type: "function_call_output",
      call_id: "call_history",
      output: "result",
      status: "completed",
    },
    { type: "reasoning", id: "rs_history", encrypted_content: "opaque-native" },
  ])("rejects historical item type $type before dispatch", async (item) => {
    const fixture = fidelityFixture();
    try {
      const request = codexTitleRequest(false);
      request.input = [item];
      const response = await fixture.send(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "unsupported_response_semantics", param: "input.0" },
      });
      expect(fixture.canonical).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });
});

describe("local structured streaming failures", () => {
  test("reports a typed validation failure without exposing unusable visible text", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await fixture.send(codexTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            canonical({
              type: "started",
              conversationId: "synthetic-conversation",
              model: "gpt-5.6-sol",
              createdAt: 1_700_000_000,
            }),
            canonical({ type: "text_delta", text: "   " }),
            canonical({
              type: "completed",
              finishReason: "stop",
              usage: {
                inputTokens: 11,
                outputTokens: 1,
                totalTokens: 12,
                reported: { inputTokens: 11, outputTokens: 1, totalTokens: 12 },
              },
            }),
          ]),
      });
      const wire = await response.text();
      const events = sseEvents(wire);

      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.in_progress",
        "response.failed",
      ]);
      expect(events.at(-1)).toMatchObject({
        response: {
          status: "failed",
          error: {
            type: "upstream_error",
            code: "structured_output_validation_failed",
            param: "text.format",
          },
          text: { format: TITLE_FORMAT },
        },
      });
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(events.some((event) => event.type === "response.output_text.delta")).toBe(false);
      expect(wire).not.toContain('"delta":"   "');
    } finally {
      fixture.database.close();
    }
  });

  test("publishes only one failed terminal for an unexpected tool call", async () => {
    const fixture = fidelityFixture();
    try {
      const response = await fixture.send(codexTitleRequest(true), {
        runPipeline: async () =>
          canonicalStream([
            canonical({
              type: "started",
              conversationId: "synthetic-conversation",
              model: "gpt-5.6-sol",
              createdAt: 1_700_000_000,
            }),
            canonical({ type: "text_delta", text: "private raw title" }),
            canonical({
              type: "tool_call_delta",
              index: 0,
              id: "private-call-id",
              name: "private-tool-name",
              arguments: "{}",
            }),
          ]),
      });
      const wire = await response.text();
      const events = sseEvents(wire);
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.in_progress",
        "response.failed",
      ]);
      expect(events.at(-1)).toMatchObject({
        response: {
          error: {
            type: "upstream_error",
            code: "structured_output_unexpected_tool_call",
            param: "text.format",
          },
          text: { format: TITLE_FORMAT },
        },
      });
      expect(wire).not.toContain("private raw title");
      expect(wire).not.toContain("private-call-id");
      expect(wire).not.toContain("private-tool-name");
    } finally {
      fixture.database.close();
    }
  });

  test("cancels upstream and fails without truncated JSON when the UTF-8 buffer exceeds 64 KiB", async () => {
    const fixture = fidelityFixture();
    let cancelled = 0;
    try {
      const response = await fixture.send(codexTitleRequest(true), {
        runPipeline: async () => {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `${canonical({
                      type: "started",
                      conversationId: "synthetic-conversation",
                      model: "gpt-5.6-sol",
                      createdAt: 1_700_000_000,
                    })}\n${canonical({ type: "text_delta", text: "x".repeat(64 * 1024 + 1) })}\n`,
                  ),
                );
              },
              cancel() {
                cancelled += 1;
              },
            }),
            {
              headers: {
                "Content-Type": "application/x-kiro-provider-output+ndjson; charset=utf-8",
              },
            },
          );
        },
      });
      const wire = await response.text();
      await Bun.sleep(1);
      const events = sseEvents(wire);
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.in_progress",
        "response.failed",
      ]);
      expect(events.at(-1)).toMatchObject({
        response: {
          error: {
            type: "upstream_error",
            code: "structured_output_buffer_exceeded",
            param: "text.format",
          },
          text: { format: TITLE_FORMAT },
        },
      });
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(events.some((event) => event.type === "response.output_text.delta")).toBe(false);
      expect(cancelled).toBe(1);
    } finally {
      fixture.database.close();
    }
  });
});

describe("local structured output real pipeline guardrails", () => {
  test.each([false, true])(
    "maps an actual upstream tool event without a second dispatch, stream=%s",
    async (stream) => {
      const fixture = fidelityFixture({
        config: { rate_limit_max_retries: 3, stream_max_attempts: 3 },
      });
      let sends = 0;
      try {
        const response = await fixture.send(codexTitleRequest(stream), {
          runPipeline: undefined,
          makeClient: () => ({
            async send() {
              sends += 1;
              return makeSdkResponse([
                {
                  toolUseEvent: {
                    toolUseId: "private-tool-id",
                    name: "private-tool-name",
                    input: "{}",
                    stop: true,
                  },
                },
              ]);
            },
          }),
        });
        if (stream) {
          const wire = await response.text();
          const events = sseEvents(wire);
          expect(response.status).toBe(200);
          expect(events.filter((event) => event.type === "response.failed")).toHaveLength(1);
          expect(events.some((event) => event.type === "response.completed")).toBe(false);
          expect(events.at(-1)).toMatchObject({
            response: {
              error: {
                type: "upstream_error",
                code: "structured_output_unexpected_tool_call",
                param: "text.format",
              },
            },
          });
          expect(wire).not.toContain("private-tool-id");
          expect(wire).not.toContain("private-tool-name");
        } else {
          const body = await response.json();
          expect(response.status).toBe(502);
          expect(body).toMatchObject({
            error: {
              type: "upstream_error",
              code: "structured_output_unexpected_tool_call",
              param: "text.format",
            },
          });
          expect(JSON.stringify(body)).not.toContain("private-tool-id");
          expect(JSON.stringify(body)).not.toContain("private-tool-name");
        }
        expect(sends).toBe(1);
      } finally {
        fixture.database.close();
      }
    },
  );
});

test.each([false, true])(
  "keeps the structured-output tool error when tool_choice=none, stream=%s",
  async (stream) => {
    const fixture = fidelityFixture();
    const request = codexTitleRequest(stream);
    request.tool_choice = "none";
    let sends = 0;
    try {
      const response = await fixture.send(request, {
        runPipeline: undefined,
        makeClient: () => ({
          async send() {
            sends += 1;
            return makeSdkResponse([
              {
                toolUseEvent: {
                  toolUseId: "private-tool-id",
                  name: "private-tool-name",
                  input: "{}",
                  stop: true,
                },
              },
            ]);
          },
        }),
      });
      if (stream) {
        const events = sseEvents(await response.text());
        expect(events.at(-1)).toMatchObject({
          type: "response.failed",
          response: {
            error: {
              type: "upstream_error",
              code: "structured_output_unexpected_tool_call",
              param: "text.format",
            },
          },
        });
        expect(events.some((event) => event.type === "response.completed")).toBe(false);
      } else {
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({
          error: {
            type: "upstream_error",
            code: "structured_output_unexpected_tool_call",
            param: "text.format",
          },
        });
      }
      expect(sends).toBe(1);
    } finally {
      fixture.database.close();
    }
  },
);

test.each([false, true])(
  "real pipeline produces one locally structured response with one dispatch, stream=%s",
  async (stream) => {
    const fixture = fidelityFixture({
      config: { rate_limit_max_retries: 3, stream_max_attempts: 3 },
    });
    let sends = 0;
    try {
      const response = await fixture.send(codexTitleRequest(stream), {
        runPipeline: undefined,
        makeClient: () => ({
          async send() {
            sends += 1;
            return makeSdkResponse([{ assistantResponseEvent: { content: "修复隔离标题" } }]);
          },
        }),
      });
      if (stream) {
        const events = sseEvents(await response.text());
        expect(events.at(-1)).toMatchObject({
          type: "response.completed",
          response: {
            status: "completed",
            text: { format: TITLE_FORMAT },
          },
        });
        const deltas = events
          .filter((event) => event.type === "response.output_text.delta")
          .map((event) => String(event.delta))
          .join("");
        expect(deltas).toBe('{"title":"修复隔离标题"}');
      } else {
        const body: unknown = await response.json();
        expect(response.status).toBe(200);
        expect(outputText(body)).toBe('{"title":"修复隔离标题"}');
      }
      expect(sends).toBe(1);
    } finally {
      fixture.database.close();
    }
  },
);

test("local structured buffering preserves deadline cleanup without exposing raw text", async () => {
  const fixture = fidelityFixture({ config: { request_timeout_ms: 20 } });
  let cancelled = 0;
  try {
    const response = await fixture.send(codexTitleRequest(true), {
      runPipeline: async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `${canonical({
                    type: "started",
                    conversationId: "deadline-conversation",
                    model: "gpt-5.6-sol",
                    createdAt: 1_700_000_000,
                  })}\n${canonical({ type: "text_delta", text: "private deadline title" })}\n`,
                ),
              );
            },
            cancel() {
              cancelled += 1;
            },
          }),
          {
            headers: {
              "Content-Type": "application/x-kiro-provider-output+ndjson; charset=utf-8",
            },
          },
        );
      },
    });
    const wire = await response.text();
    const events = sseEvents(wire);
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { error: { code: "request_deadline_exceeded" }, text: { format: TITLE_FORMAT } },
    });
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
    expect(wire).not.toContain("private deadline title");
    expect(cancelled).toBe(1);
  } finally {
    fixture.database.close();
  }
});

test("local structured buffering preserves client and consumer cancellation cleanup", async () => {
  for (const cancelKind of ["client", "consumer"] as const) {
    const fixture = fidelityFixture({ config: { request_timeout_ms: 1_000 } });
    const controller = new AbortController();
    let upstreamCancelled = 0;
    try {
      const response = await fixture.send(
        codexTitleRequest(true),
        {
          runPipeline: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(streamController) {
                  streamController.enqueue(
                    new TextEncoder().encode(
                      `${canonical({
                        type: "started",
                        conversationId: `${cancelKind}-conversation`,
                        model: "gpt-5.6-sol",
                        createdAt: 1_700_000_000,
                      })}\n${canonical({ type: "text_delta", text: "private cancelled title" })}\n`,
                    ),
                  );
                },
                cancel() {
                  upstreamCancelled += 1;
                },
              }),
              {
                headers: {
                  "Content-Type": "application/x-kiro-provider-output+ndjson; charset=utf-8",
                },
              },
            ),
        },
        controller.signal,
      );
      if (cancelKind === "client") {
        const pending = response.text();
        controller.abort(new DOMException("synthetic client close", "AbortError"));
        const wire = await pending;
        expect(wire).not.toContain("private cancelled title");
        expect(wire).not.toContain("response.completed");
      } else {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("missing response body");
        await reader.read();
        await reader.cancel("synthetic consumer close");
      }
      await Bun.sleep(1);
      expect(upstreamCancelled).toBe(1);
    } finally {
      fixture.database.close();
    }
  }
});

test("structured output audit records contain hashes and counts but no prompt, schema, or output", async () => {
  const audit = captureAuditEvents();
  const fixture = fidelityFixture();
  try {
    const request = codexTitleRequest(false);
    request.input = "PRIVATE_PROMPT_SENTINEL";
    request.text = {
      format: {
        type: "json_schema",
        name: "private_format_sentinel",
        strict: true,
        schema: {
          type: "object",
          properties: {
            privatePropertySentinel: { type: "string", minLength: 1, maxLength: 36 },
          },
          required: ["privatePropertySentinel"],
          additionalProperties: false,
        },
      },
    };
    const response = await fixture.send(request, {
      runPipeline: async () => canonicalCompletion("PRIVATE_OUTPUT_SENTINEL"),
    });
    expect(response.status).toBe(200);
    const records = audit.events();
    expect(audit.events("responses_route_selected")[0]).toMatchObject({
      local_profile: "single-string-object-v1",
      schema_hash: expect.any(String),
      property_hash: expect.any(String),
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("PRIVATE_PROMPT_SENTINEL");
    expect(serialized).not.toContain("PRIVATE_OUTPUT_SENTINEL");
    expect(serialized).not.toContain("privatePropertySentinel");
    expect(serialized).not.toContain("private_format_sentinel");
  } finally {
    audit.restore();
    fixture.database.close();
  }
});

test.each([false, true])(
  "local structured routing disables automatic SDK retry, stream=%s",
  async (stream) => {
    const fixture = fidelityFixture({
      config: { rate_limit_max_retries: 3, stream_max_attempts: 3 },
    });
    let sends = 0;
    try {
      const response = await fixture.send(codexTitleRequest(stream), {
        runPipeline: undefined,
        makeClient: () => ({
          async send() {
            sends += 1;
            throw Object.assign(new Error("synthetic upstream unavailable"), {
              name: "ServiceUnavailableException",
              $metadata: { httpStatusCode: 503 },
            });
          },
        }),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { type: "upstream_error", code: "ServiceUnavailableException" },
      });
      expect(sends).toBe(1);
    } finally {
      fixture.database.close();
    }
  },
);

test("buffer overflow releases the real pipeline account lease for the next request", async () => {
  const fixture = fidelityFixture({
    config: { account_inference_concurrency: 1, request_timeout_ms: 500 },
  });
  let sends = 0;
  const makeClient = () => ({
    async send() {
      sends += 1;
      return makeSdkResponse([
        {
          assistantResponseEvent: {
            content: sends === 1 ? "x".repeat(64 * 1024 + 1) : "second title",
          },
        },
      ]);
    },
  });
  try {
    const first = await fixture.send(codexTitleRequest(true), {
      runPipeline: undefined,
      makeClient,
    });
    const firstEvents = sseEvents(await first.text());
    expect(firstEvents.at(-1)).toMatchObject({
      type: "response.failed",
      response: {
        error: {
          type: "upstream_error",
          code: "structured_output_buffer_exceeded",
          param: "text.format",
        },
      },
    });

    const second = await fixture.send(codexTitleRequest(true), {
      runPipeline: undefined,
      makeClient,
    });
    const secondEvents = sseEvents(await second.text());
    expect(secondEvents.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
    expect(
      secondEvents
        .filter((event) => event.type === "response.output_text.delta")
        .map((event) => String(event.delta))
        .join(""),
    ).toBe('{"title":"second title"}');
    expect(sends).toBe(2);
  } finally {
    fixture.database.close();
  }
});
