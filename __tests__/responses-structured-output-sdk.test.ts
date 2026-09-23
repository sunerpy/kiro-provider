import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { ResponsesDependencies } from "../src/server/routes/responses.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const FORMAT = {
  type: "json_schema",
  name: "metadata_result",
  strict: true,
  schema: {
    type: "object",
    properties: { value: { type: "string", minLength: 1, maxLength: 36 } },
    required: ["value"],
    additionalProperties: false,
  },
} as const;

const canonical = (event: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ canonicalOutputVersion: 1, ...event });

function sdkClient(
  fixture: ReturnType<typeof fidelityFixture>,
  overrides: Partial<ResponsesDependencies> = {},
): OpenAI {
  return new OpenAI({
    apiKey: "sk-structured-sdk-fixture",
    baseURL: "http://gateway/v1",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      return handleResponses(request, fixture.config, { ...fixture.dependencies, ...overrides });
    },
  });
}

const request: ResponseCreateParamsNonStreaming = {
  model: "gpt-5.6-sol",
  input: "Generate synthetic metadata",
  store: false,
  tools: [],
  text: { format: FORMAT },
};

async function expectApiError(
  promise: Promise<unknown>,
  expected: { readonly code: string; readonly param: string },
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toMatchObject({ status: 400, ...expected });
    return;
  }
  throw new Error(`expected API error ${expected.code}`);
}

describe("official OpenAI SDK bounded structured output", () => {
  test("responses.create and responses.parse return the locally enforced object", async () => {
    const fixture = fidelityFixture();
    try {
      const sdk = sdkClient(fixture);
      const created = await sdk.responses.create(request);
      expect(created.output_text).toBe('{"value":"OK"}');
      expect(created.text?.format).toEqual(FORMAT);
      expect((created as unknown as { readonly store: boolean }).store).toBe(false);
      expect(JSON.parse(created.output_text)).toEqual({ value: "OK" });

      const parsed = await sdk.responses.parse(request);
      expect(parsed.output_text).toBe('{"value":"OK"}');
      expect(parsed.output_parsed).toEqual({ value: "OK" });
      const message = parsed.output.find((item) => item.type === "message");
      expect(message?.content[0]).toMatchObject({
        type: "output_text",
        text: '{"value":"OK"}',
        parsed: { value: "OK" },
      });
    } finally {
      fixture.database.close();
    }
  });

  test("responses.stream receives no bare model delta and assembles the final JSON", async () => {
    const fixture = fidelityFixture();
    try {
      const stream = sdkClient(fixture, {
        runPipeline: async () =>
          new Response(
            `${[
              canonical({
                type: "started",
                conversationId: "sdk-structured",
                model: "gpt-5.6-sol",
                createdAt: 1_700_000_000,
              }),
              canonical({ type: "text_delta", text: "plain upstream metadata" }),
              canonical({
                type: "completed",
                finishReason: "stop",
                usage: {
                  inputTokens: 3,
                  outputTokens: 4,
                  totalTokens: 7,
                  reported: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
                },
              }),
            ].join("\n")}\n`,
            {
              headers: {
                "Content-Type": "application/x-kiro-provider-output+ndjson; charset=utf-8",
              },
            },
          ),
      }).responses.stream({ ...request, stream: true });
      const deltas: string[] = [];
      stream.on("response.output_text.delta", (event) => deltas.push(event.delta));
      const completed = await stream.finalResponse();

      expect(deltas.join("")).toBe('{"value":"plain upstream metadata"}');
      expect(deltas).not.toContain("plain upstream metadata");
      expect(completed.output_text).toBe('{"value":"plain upstream metadata"}');
      expect(completed.text?.format).toEqual(FORMAT);
      expect(completed.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    } finally {
      fixture.database.close();
    }
  });

  test("complex schemas and strict fidelity remain typed SDK errors", async () => {
    const compatible = fidelityFixture();
    const strict = fidelityFixture({ config: { responses_fidelity_mode: "strict" } });
    try {
      const complex = {
        ...request,
        text: {
          format: {
            ...FORMAT,
            schema: {
              type: "object",
              properties: {
                value: FORMAT.schema.properties.value,
                extra: FORMAT.schema.properties.value,
              },
              required: ["value", "extra"],
              additionalProperties: false,
            },
          },
        },
      } as ResponseCreateParamsNonStreaming;
      await expectApiError(sdkClient(compatible).responses.create(complex), {
        code: "unsupported_structured_output",
        param: "text.format",
      });
      await expectApiError(sdkClient(strict).responses.create(request), {
        code: "unsupported_response_semantics",
        param: "text.format",
      });
      expect(compatible.canonical).toHaveLength(0);
      expect(strict.canonical).toHaveLength(0);
    } finally {
      compatible.database.close();
      strict.database.close();
    }
  });
});
