/**
 * Real OpenAI SDK acceptance, using synthetic data and an isolated local provider.
 * Keeps semantic assertions and sanitized request/response examples for comparison.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  Response as SDKResponse,
  Tool,
} from "openai/resources/responses/responses";

type Body = Omit<ResponseCreateParamsNonStreaming, "stream">;
type Trace = {
  request: unknown;
  status: number;
  transport: string | null;
  compatibility: string | null;
  response?: unknown;
  duration_ms?: number;
  events?: Record<string, number>;
};
type Result = {
  model: string;
  case: string;
  passed: boolean;
  checks: string[];
  observations: string[];
  error?: string;
  traces: Trace[];
};
const arg = (key: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(key);
  return index < 0 ? fallback : process.argv[index + 1];
};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const finalInteger = (text: string): string | undefined => text.match(/\d+/gu)?.at(-1);
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "encrypted_content" && typeof child === "string"
        ? {
            prefix: child.startsWith("kr1_") ? "kr1_" : "upstream",
            bytes: child.length,
            sha256: sha(child),
          }
        : key === "type" || key === "arguments" || key === "input"
          ? sanitize(child)
          : key === "content" && Array.isArray(child)
            ? child.map((part) =>
                part?.type === "reasoning_text"
                  ? { type: part.type, text_chars: String(part.text ?? "").length }
                  : sanitize(part),
              )
            : key === "summary" && Array.isArray(child)
              ? child.map((part) => ({
                  type: part.type,
                  text_chars: String(part.text ?? "").length,
                }))
              : sanitize(child),
    ]),
  );
}
const inputOf = (body: Body): ResponseInput =>
  typeof body.input === "string" ? [{ role: "user", content: body.input }] : (body.input ?? []);
function replayOutput(response: SDKResponse): ResponseInput {
  return response.output.map((item) => {
    switch (item.type) {
      case "message":
      case "reasoning":
      case "function_call":
      case "custom_tool_call":
        return item;
      default:
        throw new Error(`Unexpected output item for this probe: ${item.type}`);
    }
  });
}
function functionCall(response: SDKResponse, name: string) {
  const call = response.output.find((item) => item.type === "function_call" && item.name === name);
  if (!call || call.type !== "function_call") throw new Error(`Expected function call ${name}`);
  return call;
}

async function main(): Promise<void> {
  const configPath = arg("--config");
  const destination = arg("--out");
  if (!process.argv.includes("--confirm") || !configPath || !destination)
    throw new Error("--confirm --config and --out are required");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { api_keys: string[] };
  const endpoint = arg("--endpoint", "http://127.0.0.1:18787/v1") as string;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))
    throw new Error("This acceptance script requires an isolated loopback endpoint");
  const models = (
    arg(
      "--models",
      "claude-opus-5,claude-sonnet-5,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna",
    ) as string
  ).split(",");
  const features = new Set(
    (arg("--features", "nullable,history,tools,custom,reasoning,effort") as string).split(","),
  );
  const results: Result[] = [];
  let traces: Trace[] = [];
  let observations: string[] = [];
  const sdk = new OpenAI({
    apiKey: config.api_keys[0],
    baseURL: endpoint,
    maxRetries: 0,
    timeout: 200_000,
    fetch: async (input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      const raw =
        request.method === "POST"
          ? await request.clone().json()
          : { method: request.method, path: new URL(request.url).pathname };
      const response = await fetch(request);
      traces.push({
        request: sanitize(raw),
        status: response.status,
        transport: response.headers.get("x-kiro-transport"),
        compatibility: response.headers.get("x-kiro-compatibility"),
      });
      return response;
    },
  });
  const create = async (body: Body, streaming = false): Promise<SDKResponse> => {
    const start = Date.now();
    let response: SDKResponse;
    const events: Record<string, number> = {};
    if (streaming) {
      const stream = sdk.responses.stream(body);
      let sequence = -1;
      stream.on("event", (event) => {
        events[event.type] = (events[event.type] ?? 0) + 1;
        if ("sequence_number" in event) {
          if (event.sequence_number <= sequence) throw new Error("Non-increasing SSE sequence");
          sequence = event.sequence_number;
        }
      });
      response = await stream.finalResponse();
      if (events["response.completed"] !== 1 || events["response.failed"])
        throw new Error("SDK did not receive exactly one successful terminal event");
    } else response = await sdk.responses.create(body);
    const trace = traces.at(-1);
    if (trace) {
      trace.response = sanitize(response);
      trace.duration_ms = Date.now() - start;
      if (streaming) trace.events = events;
    }
    if (response.status !== "completed") throw new Error(`Response status ${response.status}`);
    return response;
  };
  const save = () =>
    writeFileSync(
      destination,
      `${JSON.stringify(
        {
          schema_version: 1,
          sdk: "openai@7.13.0",
          generated_at: new Date().toISOString(),
          label: arg("--label", "candidate"),
          models,
          features: [...features],
          results,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  const run = async (
    model: string,
    name: string,
    task: (check: (ok: unknown, description: string) => void) => Promise<void>,
  ) => {
    traces = [];
    observations = [];
    const checks: string[] = [];
    let error: string | undefined;
    try {
      await task((ok, description) => {
        checks.push(`${ok ? "PASS" : "FAIL"}: ${description}`);
        if (!ok) throw new Error(description);
      });
    } catch (failure) {
      error =
        failure instanceof OpenAI.APIError
          ? `HTTP ${failure.status}: ${failure.code ?? failure.type}`
          : failure instanceof Error
            ? failure.message
            : "Unknown failure";
    }
    const result = {
      model,
      case: name,
      passed: !error,
      checks,
      observations,
      ...(error ? { error } : {}),
      traces,
    };
    results.push(result);
    save();
    console.log(JSON.stringify({ model, case: name, passed: result.passed, checks, error }));
  };
  for (const model of models) {
    if (features.has("strict"))
      await run(model, "strict-admission", async (check) => {
        const response = await create({
          model,
          input: "Reply exactly SDK_OK",
          reasoning: { effort: "low" },
        });
        check(
          response.output_text.trim() === "SDK_OK",
          "a supported request succeeds in strict mode",
        );
        const functionTool = {
          type: "function",
          name: "echo",
          description: "Echo text",
          parameters: { type: "object" },
          strict: false,
        };
        const rejected: Array<[Record<string, unknown>, string, string]> = [
          [{ text: { verbosity: "low" } }, "unsupported_response_semantics", "text.verbosity"],
          [
            { reasoning: { context: "all_turns" } },
            "unsupported_response_semantics",
            "reasoning.context",
          ],
          [
            { parallel_tool_calls: false, tools: [functionTool] },
            "unsupported_response_semantics",
            "parallel_tool_calls",
          ],
          [
            { tools: [{ ...functionTool, strict: true }] },
            "unsupported_strict_tools",
            "tools.0.strict",
          ],
          [
            {
              tools: [
                {
                  type: "custom",
                  name: "grammar",
                  description: "Grammar",
                  format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
                },
              ],
            },
            "unsupported_response_semantics",
            "tools.0.format",
          ],
          [{ made_up_control: true }, "unsupported_parameter", "made_up_control"],
        ];
        for (const [extra, code, param] of rejected) {
          let error: unknown;
          try {
            await sdk.responses.create({ model, input: "Hi", ...extra } as Body);
          } catch (value) {
            error = value;
          }
          check(
            error instanceof OpenAI.APIError &&
              error.status === 400 &&
              error.code === code &&
              error.param === param,
            `strict rejection identifies ${param}`,
          );
        }
      });
    if (features.has("nullable"))
      await run(model, "nullable-and-input-items", async (check) => {
        const first = await create({
          model,
          input: [{ role: "user", content: "Reply exactly SDK_OK" }],
          instructions: null,
          previous_response_id: null,
          temperature: null,
          max_output_tokens: null,
        });
        check(first.output_text.trim() === "SDK_OK", "nullable request gives the requested answer");
        check(
          JSON.stringify((await sdk.responses.retrieve(first.id)).output) ===
            JSON.stringify(first.output),
          "Retrieve preserves the complete output",
        );
        const items = await sdk.responses.inputItems.list(first.id);
        check(
          items.data[0]?.type === "message" && Array.isArray(items.data[0].content),
          "input_items exposes standard message content blocks",
        );
        const repeat = await sdk.responses.inputItems.list(first.id);
        check(repeat.data[0]?.id === items.data[0]?.id, "input_items IDs are stable");
      });
    if (features.has("history"))
      await run(model, "previous-response-history", async (check) => {
        const marker = `MEM_${randomUUID().replaceAll("-", "")}`;
        const first = await create({
          model,
          input: `Remember the exact synthetic test marker ${marker}. Reply only ACK.`,
          reasoning: { effort: "low" },
        });
        const second = await create(
          {
            model,
            previous_response_id: first.id,
            input: "What was the exact marker? Reply only the marker.",
            reasoning: { effort: "low" },
          },
          true,
        );
        check(
          second.output_text.includes(marker),
          "previous_response_id restores content absent from the new input",
        );
        const manual = await create({
          model,
          input: [
            { role: "user", content: `Remember ${marker}; reply only ACK.` },
            ...replayOutput(first),
            { role: "user", content: "Reply only the remembered marker." },
          ],
          reasoning: { effort: "low" },
        });
        check(
          manual.output_text.includes(marker),
          "complete output can also be replayed through next.input",
        );
        await sdk.responses.delete(first.id);
        try {
          await sdk.responses.create({ model, input: "Continue", previous_response_id: first.id });
          check(false, "deleted ID is rejected");
        } catch (error) {
          check(
            error instanceof OpenAI.APIError &&
              error.status === 404 &&
              error.code === "response_not_found",
            "deleted ID cannot continue",
          );
        }
        const third = await create({
          model,
          previous_response_id: second.id,
          input: "Repeat that marker exactly.",
          reasoning: { effort: "low" },
        });
        check(
          third.output_text.includes(marker),
          "a committed descendant survives deletion of its ancestor",
        );
      });
    for (const streaming of [false, true]) {
      if (features.has("tools"))
        await run(model, `namespace-tool-${streaming ? "sse" : "json"}`, async (check) => {
          const tools: Tool[] = [
            {
              type: "namespace",
              name: "catalog",
              description: "Synthetic local inventory",
              tools: [
                {
                  type: "function",
                  name: "lookup",
                  description: "Return the price in cents for a SKU",
                  parameters: {
                    type: "object",
                    properties: { sku: { type: "string" } },
                    required: ["sku"],
                    additionalProperties: false,
                  },
                  strict: false,
                },
              ],
            },
          ];
          const firstBody: Body = {
            model,
            input:
              "Call catalog.lookup exactly once for SKU p42, then use its returned price. Do not invent a price.",
            tools,
            reasoning: { effort: "low" },
          };
          const first = await create(firstBody, streaming);
          const call = functionCall(first, "lookup");
          check(
            call.namespace === "catalog" && JSON.parse(call.arguments).sku === "p42",
            "namespace and JSON arguments are restored",
          );
          check(
            first.output.filter((item) => item.type === "function_call").length === 1,
            "exactly one intended tool call",
          );
          const second = await create(
            {
              model,
              previous_response_id: first.id,
              input: [
                {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: '{"sku":"p42","price_cents":1267}',
                },
                {
                  role: "user",
                  content:
                    "Now buy seven units. Add tax by rounding 13 percent of the subtotal to the nearest integer cent. Reply only the final integer total in cents. Do not call any tools.",
                },
              ],
              reasoning: { effort: "low" },
            },
            streaming,
          );
          check(
            finalInteger(second.output_text) === "10022",
            "tool result drives the correct seven-unit taxed total",
          );
          if (second.output_text.trim() !== "10022")
            observations.push(
              "The total is correct, but the model added explanation despite the requested terse format.",
            );
          check(
            !second.output.some((item) => item.type === "function_call"),
            "removed tools are not invoked again",
          );
          check(
            !JSON.stringify(traces).match(/kiro_(?:ns|custom)_[0-9a-f]+/u),
            "no internal tool alias is exposed",
          );
        });
      if (features.has("custom"))
        await run(model, `custom-tool-${streaming ? "sse" : "json"}`, async (check) => {
          const raw = 'alpha\\beta\n{"quote":"x"}\n雪🌐';
          const firstBody: Body = {
            model,
            input: `Use the emit custom tool once. Its raw input must be the exact decoded string of this JSON string literal: ${JSON.stringify(raw)}`,
            tools: [
              {
                type: "custom",
                name: "emit",
                description: "Accept exact raw text",
                format: { type: "text" },
              },
            ],
            reasoning: { effort: "low" },
          };
          const first = await create(firstBody, streaming);
          const call = first.output.find((item) => item.type === "custom_tool_call");
          check(
            call?.type === "custom_tool_call" && call.name === "emit" && call.input === raw,
            "custom input preserves newline, slash, quotes and Unicode bytes",
          );
          if (!call || call.type !== "custom_tool_call") throw new Error("Missing custom call");
          const marker = `TOOL_${randomUUID().slice(0, 12)}`;
          const second = await create(
            {
              model,
              previous_response_id: first.id,
              input: [
                { type: "custom_tool_call_output", call_id: call.call_id, output: marker },
                { role: "user", content: "Reply only the exact tool result just received." },
              ],
              reasoning: { effort: "low" },
            },
            streaming,
          );
          check(
            second.output_text.trim() === marker,
            "custom result is paired by call_id and used by the model",
          );
          const manual = await create(
            {
              model,
              input: [
                ...inputOf(firstBody),
                ...replayOutput(first),
                { type: "custom_tool_call_output", call_id: call.call_id, output: marker },
                { role: "user", content: "Reply only the exact tool result just received." },
              ],
              reasoning: { effort: "low" },
            },
            streaming,
          );
          check(
            manual.output_text.trim() === marker,
            "complete custom output, including any opaque reasoning, replays through next.input",
          );
        });
    }
    if (features.has("reasoning") && model.startsWith("claude-"))
      await run(model, "private-reasoning-full-output-replay", async (check) => {
        const reasoningModel = `${model}-max`;
        const body: Body = {
          model: reasoningModel,
          store: false,
          input:
            "First determine how many binary strings of length 12 contain exactly four 1s with no adjacent 1s. Verify your calculation independently. Then call lookup exactly once with SKU p42 and that integer as answer. Wait for the tool result before calculating the total for seven units with 13 percent tax rounded to the nearest cent.",
          tools: [
            {
              type: "function",
              name: "lookup",
              description: "Look up price in cents",
              parameters: {
                type: "object",
                properties: { sku: { type: "string" }, answer: { type: "integer" } },
                required: ["sku", "answer"],
              },
              strict: false,
            },
          ],
        };
        const first = await create(body, true);
        const call = functionCall(first, "lookup");
        check(
          JSON.parse(call.arguments).sku === "p42" && JSON.parse(call.arguments).answer === 126,
          "reasoning turn calls the intended tool with valid arguments",
        );
        const signed = first.output.some(
          (item) => item.type === "reasoning" && item.encrypted_content?.startsWith("kr1_"),
        );
        if (signed || model === "claude-opus-5")
          check(signed, "store:false returns a real signed replay token without include");
        else
          observations.push(
            "No signed reasoning envelope was returned for this model/turn; signed replay is not claimed by this case.",
          );
        const second = await create(
          {
            model: reasoningModel,
            store: false,
            tools: body.tools,
            tool_choice: "none",
            input: [
              ...inputOf(body),
              ...replayOutput(first),
              {
                type: "function_call_output",
                call_id: call.call_id,
                output: '{"sku":"p42","price_cents":1267}',
              },
              { role: "user", content: "Reply only the final integer total in cents." },
            ],
          },
          true,
        );
        check(
          finalInteger(second.output_text) === "10022",
          "full reasoning/tool output replays without include and solves the task",
        );
        check(traces.at(-1)?.transport === "stateless", "kr1 replay stays in its owning transport");
      });
    if (features.has("effort") && model.startsWith("gpt-")) {
      for (const effort of ["low", "high"] as const)
        await run(model, `effort-${effort}-without-visible-reasoning`, async (check) => {
          // Independent integer oracle: number of length-12 bit strings with four
          // ones and no adjacent ones is C(9,4) = 126.
          const response = await create(
            {
              model: `${model}-xhigh`,
              reasoning: { effort },
              input:
                "How many binary strings of length 12 contain exactly four 1s and have no adjacent 1s? Reply only the integer.",
            },
            true,
          );
          check(
            response.output_text.trim() === "126",
            "independent combinatorial oracle matches the answer",
          );
          check(
            response.reasoning?.effort === effort,
            "upstream effective effort matches the explicit value over the xhigh alias",
          );
          check(
            response.output.every(
              (item) => item.type !== "reasoning" || !item.encrypted_content?.startsWith("kr1_"),
            ),
            "native GPT output is preserved without inventing provider replay tokens",
          );
          observations.push(
            "Visible reasoning is not required. Any upstream opaque reasoning and usage counters are preserved in the trace.",
          );
        });
    }
  }
  if (!results.every((result) => result.passed) && !process.argv.includes("--allow-failures"))
    process.exitCode = 1;
}

await main();
