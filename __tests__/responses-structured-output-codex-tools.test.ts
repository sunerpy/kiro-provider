import { describe, expect, test } from "bun:test";
import { fidelityFixture } from "./responses-fidelity-helpers.js";
import { makeSdkResponse } from "./sdk-stream-test-helpers.js";

const tool = (name: string) => ({
  type: "function",
  name,
  description: "Synthetic metadata fixture tool",
  parameters: { type: "object", properties: {} },
});
const format = {
  type: "json_schema",
  name: "codex_output_schema",
  strict: true,
  schema: {
    type: "object",
    properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
    required: ["title"],
    additionalProperties: false,
  },
};
const request = (stream: boolean) => ({
  model: "gpt-5.6-sol",
  input: [{ type: "message", role: "user", content: "Name the synthetic sorting task." }],
  tools: [
    {
      type: "namespace",
      name: "collaboration",
      description: "Synthetic Codex metadata declarations",
      tools: Array.from({ length: 6 }, (_, i) => tool(`fixture_${i}`)),
    },
  ],
  tool_choice: "auto",
  reasoning: { effort: "low" },
  store: false,
  stream,
  text: { format },
});

describe("real Codex title declaration shape", () => {
  test("keeps malformed and hosted declarations fail-closed", async () => {
    const fixture = fidelityFixture();
    try {
      for (const tools of [
        [{ type: "web_search" }],
        [{ type: "function", name: "broken", parameters: "invalid" }],
      ]) {
        const response = await fixture.send({ ...request(false), tools });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            type: "invalid_request_error",
            code: expect.any(String),
            param: expect.stringMatching(/^tools/),
          },
        });
      }
      expect(fixture.canonical).toHaveLength(0);
    } finally {
      fixture.database.close();
    }
  });
  test.each([false, true])(
    "preserves the TUI collaboration namespace without allowing calls, stream=%s",
    async (stream) => {
      const fixture = fidelityFixture();
      try {
        const response = await fixture.send(
          request(stream),
          stream
            ? {
                runPipeline: async (options) => {
                  fixture.canonical.push(options.body);
                  const events = [
                    {
                      type: "started",
                      conversationId: "fixture",
                      model: "gpt-5.6-sol",
                      createdAt: 1,
                    },
                    { type: "text_delta", text: "Synthetic title" },
                    {
                      type: "completed",
                      finishReason: "stop",
                      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    },
                  ];
                  return new Response(
                    `${events
                      .map((event) => JSON.stringify({ canonicalOutputVersion: 1, ...event }))
                      .join("\n")}\n`,
                    { headers: { "Content-Type": "application/x-kiro-provider-output+ndjson" } },
                  );
                },
              }
            : {},
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kiro-compatibility")).toContain(
          "structured_output_tool_calls_rejected",
        );
        expect(fixture.canonical[0]?.tools).toHaveLength(6);
        expect(fixture.canonical[0]?.tools.map((value) => value.inputSchema)).toEqual(
          Array.from({ length: 6 }, () => ({ type: "object", properties: {} })),
        );
        const body = await response.text();
        expect(body).toContain(stream ? "response.completed" : '"status":"completed"');
        expect(body).toContain(stream ? "Synthetic title" : "OK");
      } finally {
        fixture.database.close();
      }
    },
  );

  test("accepts validated additional_tools declarations without treating them as history", async () => {
    const fixture = fidelityFixture();
    try {
      const base = request(false);
      const response = await fixture.send({
        ...base,
        tools: [],
        input: [
          { type: "additional_tools", role: "developer", tools: [tool("fixture_declared")] },
          ...base.input,
        ],
      });
      expect(response.status).toBe(200);
      expect(fixture.canonical[0]?.tools).toHaveLength(1);
      expect(response.headers.get("x-kiro-compatibility")).toContain(
        "structured_output_tool_calls_rejected",
      );
      await response.text();
    } finally {
      fixture.database.close();
    }
  });

  test.each([false, true])(
    "fails closed on a declared upstream call without a second dispatch, stream=%s",
    async (stream) => {
      const fixture = fidelityFixture();
      let sends = 0;
      try {
        const response = await fixture.send(
          { ...request(stream), tools: [tool("fixture_declared")] },
          {
            runPipeline: undefined,
            makeClient: () => ({
              send: async () => {
                sends++;
                return makeSdkResponse([
                  {
                    toolUseEvent: {
                      name: "fixture_declared",
                      toolUseId: "fixture_call",
                      input: "{}",
                      stop: true,
                    },
                  },
                  { metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1 } } },
                ]);
              },
            }),
          },
        );
        const body = await response.text();
        expect(body).toContain("structured_output_unexpected_tool_call");
        expect(body).not.toContain("response.completed");
        expect(body).not.toContain("response.function_call_arguments");
        expect(body).not.toContain("fixture_call");
        expect(sends).toBe(1);
      } finally {
        fixture.database.close();
      }
    },
  );
});
