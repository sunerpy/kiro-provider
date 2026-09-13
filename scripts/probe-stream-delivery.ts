/**
 * Isolated, real HTTP acceptance using the pinned official OpenAI SDK.
 * No tool is executed. A second, explicit request supplies a fixed fixture result.
 * No SDK retries, autonomous agent loops, or production state modifications.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  Response as SDKResponse,
  Tool,
} from "openai/resources/responses/responses";

const option = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const configPath = option("--config");
const destination = option("--out");
const endpoint = option("--endpoint", "http://127.0.0.1:18791/v1") as string;
if (!process.argv.includes("--confirm") || !configPath || !destination)
  throw new Error("--confirm, --config and --out are required");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname) ||
  new URL(endpoint).port === "8787"
)
  throw new Error("Use a separate loopback provider, never the production port");

const config = JSON.parse(readFileSync(configPath, "utf8")) as { api_keys: string[] };
const sdk = new OpenAI({
  baseURL: endpoint,
  apiKey: config.api_keys[0],
  maxRetries: 0,
  timeout: 180_000,
});
const results: Record<string, unknown>[] = [];
const save = (): void =>
  writeFileSync(
    destination,
    `${JSON.stringify(
      {
        schema_version: 1,
        sdk_version: "7.13.0",
        tools_executed: 0,
        automatic_follow_on: false,
        results,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const outputText = (response: SDKResponse): string =>
  response.output
    .flatMap((item) => (item.type === "message" ? item.content : []))
    .map((part) => (part.type === "output_text" ? part.text : ""))
    .join("");
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function replay(response: SDKResponse): ResponseInput {
  return response.output.map((item) => {
    if (!["message", "function_call", "custom_tool_call", "reasoning"].includes(item.type))
      throw new Error(`Unexpected fixture output type: ${item.type}`);
    return item as ResponseInput[number];
  });
}

async function generate(body: ResponseCreateParamsStreaming) {
  const started = performance.now();
  const { data: stream, response } = await sdk.responses.create(body).withResponse();
  const headersMs = Math.round(performance.now() - started);
  let terminal: SDKResponse | undefined;
  let firstDeltaMs: number | undefined;
  let firstToolDeltaMs: number | undefined;
  let toolDoneMs: number | undefined;
  let events = 0;
  let doneCalls = 0;
  const argumentDeltas = new Map<string, string>();
  const itemIds = new Set<string>();
  let priorSequence = -1;
  for await (const event of stream) {
    events += 1;
    assert(event.sequence_number > priorSequence, "SSE sequence numbers must increase");
    priorSequence = event.sequence_number;
    if (event.type.endsWith(".delta")) firstDeltaMs ??= Math.round(performance.now() - started);
    if (event.type === "response.output_item.added") {
      assert(!itemIds.has(event.item.id as string), "Duplicate output item identity");
      itemIds.add(event.item.id as string);
    }
    if (
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.custom_tool_call_input.delta"
    ) {
      firstToolDeltaMs ??= Math.round(performance.now() - started);
      argumentDeltas.set(event.item_id, (argumentDeltas.get(event.item_id) ?? "") + event.delta);
    }
    if (
      event.type === "response.function_call_arguments.done" ||
      event.type === "response.custom_tool_call_input.done"
    ) {
      doneCalls += 1;
      toolDoneMs = Math.round(performance.now() - started);
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      assert(!terminal, "More than one terminal response");
      terminal = event.response;
    }
  }
  assert(terminal, "No terminal response");
  assert(
    terminal.status === "completed",
    `Terminal ${terminal.status}: ${JSON.stringify(terminal.error)}`,
  );
  return {
    response: terminal,
    argumentDeltas,
    trace: {
      request_id: response.headers.get("x-request-id"),
      transport: response.headers.get("x-kiro-transport"),
      compatibility: response.headers.get("x-kiro-compatibility"),
      status: response.status,
      headers_ms: headersMs,
      first_delta_ms: firstDeltaMs,
      first_tool_delta_ms: firstToolDeltaMs,
      tool_done_ms: toolDoneMs,
      elapsed_ms: Math.round(performance.now() - started),
      events,
      tool_done_count: doneCalls,
      usage: terminal.usage,
      output_types: terminal.output.map((item) => item.type),
      reasoning: terminal.output
        .filter((item) => item.type === "reasoning")
        .map((item) => ({
          summary_chars: item.summary.reduce((sum, part) => sum + part.text.length, 0),
          replay_prefix: item.encrypted_content?.startsWith("kr1_")
            ? "kr1_"
            : item.encrypted_content
              ? "upstream"
              : null,
          replay_sha256: item.encrypted_content ? hash(item.encrypted_content) : null,
        })),
    },
  };
}

async function toolRoundTrip(
  model: string,
  iteration: number,
  kind: "function" | "namespace" | "custom",
) {
  const marker = `STREAM_${iteration}_${randomUUID().slice(0, 8)}`;
  const payload = '中文 "quote" \\backslash\nsecond line';
  const parameters = {
    type: "object",
    properties: {
      marker: { type: "string", const: marker },
      payload: { type: "string", const: payload },
    },
    required: ["marker", "payload"],
    additionalProperties: false,
  };
  const declaration = {
    type: "function" as const,
    name: "capture_fixture",
    description: "Capture the provided fixture; returns value 41",
    parameters,
    strict: false,
  };
  const tools: Tool[] =
    kind === "namespace"
      ? [
          {
            type: "namespace",
            name: "fixture",
            description: "Synthetic fixture",
            tools: [declaration],
          },
        ]
      : kind === "custom"
        ? [
            {
              type: "custom",
              name: "capture_fixture",
              description: "Capture raw fixture text; returns value 41",
              format: { type: "text" },
            },
          ]
        : [declaration];
  const customInput = `${marker}\n${payload}`;
  const input: ResponseInput = [
    {
      role: "user",
      content:
        `Call ${kind === "namespace" ? "fixture." : ""}capture_fixture exactly once, with ` +
        (kind === "custom"
          ? `this complete raw string: ${JSON.stringify(customInput)}`
          : `these exact JSON arguments: ${JSON.stringify({ marker, payload })}`) +
        `. When its result arrives, reply only ACK:${marker}: followed by the result's integer value. Do not call any other tool.`,
    },
  ];
  const body: ResponseCreateParamsStreaming = {
    model,
    store: false,
    stream: true,
    reasoning: { effort: "max" },
    include: ["reasoning.encrypted_content"],
    input,
    tools,
  };
  const first = await generate(body);
  const calls = first.response.output.filter(
    (item) => item.type === "function_call" || item.type === "custom_tool_call",
  );
  assert(calls.length === 1, "Expected one complete tool call");
  const call = calls[0];
  assert(call && call.name === "capture_fixture", "Public tool name was changed");
  const argumentsText = call.type === "custom_tool_call" ? call.input : call.arguments;
  assert(
    first.argumentDeltas.get(call.id as string) === argumentsText,
    "Deltas differ from completed arguments",
  );
  assert(first.trace.tool_done_count === 1, "Tool completion must be emitted exactly once");
  if (call.type === "custom_tool_call")
    assert(argumentsText === customInput, "Custom escaping changed");
  else {
    const parsed = JSON.parse(argumentsText);
    assert(parsed.marker === marker && parsed.payload === payload, "Function arguments changed");
    if (kind === "namespace") assert(call.namespace === "fixture", "Namespace was lost");
  }
  const output: ResponseInput[number] =
    call.type === "custom_tool_call"
      ? { type: "custom_tool_call_output", call_id: call.call_id, output: '{"value":41}' }
      : { type: "function_call_output", call_id: call.call_id, output: '{"value":41}' };
  // This is an explicit test turn with a canned result, not tool execution.
  const second = await generate({ ...body, input: [...input, ...replay(first.response), output] });
  assert(
    outputText(second.response).trim() === `ACK:${marker}:41`,
    "The replay lost the call/result or original instruction",
  );
  assert(
    !second.response.output.some(
      (item) => item.type === "function_call" || item.type === "custom_tool_call",
    ),
    "The replay repeated the tool",
  );
  return {
    model,
    case: `${kind}-round-trip`,
    iteration,
    passed: true,
    requested_effort: "max",
    headers_before_tool_done: (first.trace.tool_done_ms ?? -1) >= first.trace.headers_ms,
    arguments: kind === "custom" ? customInput : JSON.parse(argumentsText),
    reply: outputText(second.response),
    traces: [first.trace, second.trace],
  };
}

const models = (
  option(
    "--models",
    "gpt-5.6-sol,claude-opus-5,claude-sonnet-5,gpt-5.6-terra,gpt-5.6-luna",
  ) as string
).split(",");
const repetitions = Number(option("--repetitions", "3"));
assert(
  Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 3,
  "Use 1..3 repetitions",
);
async function record(model: string, name: string, run: () => Promise<Record<string, unknown>>) {
  try {
    results.push(await run());
  } catch (error) {
    results.push({
      model,
      case: name,
      passed: false,
      status: error instanceof OpenAI.APIError ? error.status : null,
      request_id: error instanceof OpenAI.APIError ? error.requestID : null,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1_024),
    });
  }
  save();
  const result = results.at(-1);
  console.log(
    JSON.stringify({ model, case: name, passed: result?.passed, status: result?.status }),
  );
}
if (!process.argv.includes("--chat-only")) {
  for (const model of models) {
    for (let iteration = 1; iteration <= repetitions; iteration++)
      await record(model, `function-round-trip-${iteration}`, () =>
        toolRoundTrip(model, iteration, "function"),
      );
    await record(model, "native-control", async () => {
      const result = await generate({
        model,
        input: "Reply exactly NATIVE_CONTROL_OK",
        stream: true,
        reasoning: { effort: "low" },
      });
      assert(
        outputText(result.response).trim() === "NATIVE_CONTROL_OK",
        "Native control content mismatch",
      );
      return { model, case: "native-control", passed: true, trace: result.trace };
    });
  }
  for (const kind of ["namespace", "custom"] as const)
    await record("gpt-5.6-sol", kind, () => toolRoundTrip("gpt-5.6-sol", 1, kind));
  await record("gpt-5.6-sol", "cancel-after-headers", async () => {
    const { data: stream, response } = await sdk.responses
      .create({
        model: "gpt-5.6-sol",
        store: false,
        stream: true,
        reasoning: { effort: "max" },
        input: "List the integers from 1 to 10000, one per line. Start immediately.",
      })
      .withResponse();
    let events = 0;
    for await (const _event of stream) {
      events += 1;
      stream.controller.abort();
      break;
    }
    assert(events === 1, "Cancellation did not stop consumption at the first event");
    return {
      model: "gpt-5.6-sol",
      case: "cancel-after-headers",
      passed: true,
      events,
      request_id: response.headers.get("x-request-id"),
    };
  });
}

async function chatRoundTrip(model: string, iteration: number) {
  const marker = `CHAT_${iteration}_${randomUUID().slice(0, 8)}`;
  const payload = '中文 "quote" \\backslash\nsecond line';
  const tools: ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "capture_fixture",
        description: "Capture the exact fixture; returns value 41",
        parameters: {
          type: "object",
          properties: {
            marker: { type: "string", const: marker },
            payload: { type: "string", const: payload },
          },
          required: ["marker", "payload"],
          additionalProperties: false,
        },
      },
    },
  ];
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "user",
      content:
        `Call capture_fixture once with ${JSON.stringify({ marker, payload })}. ` +
        `After its result, reply only ACK:${marker}: followed by its integer value.`,
    },
  ];
  const create = async (input: ChatCompletionMessageParam[]) => {
    const started = performance.now();
    const { data: stream, response } = await sdk.chat.completions
      .create({
        model,
        reasoning_effort: "max",
        stream: true,
        stream_options: { include_usage: true },
        messages: input,
        tools,
      })
      .withResponse();
    const trace = {
      request_id: response.headers.get("x-request-id"),
      headers_ms: Math.round(performance.now() - started),
      first_tool_delta_ms: null as number | null,
      elapsed_ms: 0,
      role_chunks: 0,
      finish_chunks: 0,
    };
    let text = "";
    const calls = new Map<
      number,
      { id: string; type: "function"; function: { name: string; arguments: string } }
    >();
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta.role) trace.role_chunks += 1;
      if (choice.finish_reason) trace.finish_chunks += 1;
      text += choice.delta.content ?? "";
      for (const delta of choice.delta.tool_calls ?? []) {
        trace.first_tool_delta_ms ??= Math.round(performance.now() - started);
        let call = calls.get(delta.index);
        if (!call) {
          assert(delta.id && delta.function?.name, "Chat tool identity missing at start");
          call = {
            id: delta.id,
            type: "function",
            function: { name: delta.function.name, arguments: "" },
          };
          calls.set(delta.index, call);
        } else {
          assert(!delta.id || delta.id === call.id, "Chat call ID changed");
          assert(
            !delta.function?.name || delta.function.name === call.function.name,
            "Chat tool name changed",
          );
        }
        call.function.arguments += delta.function?.arguments ?? "";
      }
    }
    trace.elapsed_ms = Math.round(performance.now() - started);
    assert(
      trace.role_chunks === 1 && trace.finish_chunks === 1,
      "Chat lifecycle was duplicated or incomplete",
    );
    return { calls: [...calls.values()], text, trace };
  };
  const first = await create(messages);
  assert(first.calls.length === 1, "Expected one Chat tool call");
  const call = first.calls[0];
  assert(call && call.function.name === "capture_fixture", "Chat public tool identity changed");
  const parsed = JSON.parse(call.function.arguments);
  assert(parsed.marker === marker && parsed.payload === payload, "Chat parameters changed");
  const next = await create([
    ...messages,
    { role: "assistant", content: null, tool_calls: first.calls },
    { role: "tool", tool_call_id: call.id, content: '{"value":41}' },
  ]);
  assert(
    next.calls.length === 0 && next.text.trim() === `ACK:${marker}:41`,
    "Chat history replay lost the call/result",
  );
  return {
    model,
    case: "chat-tool-round-trip",
    iteration,
    passed: true,
    arguments: parsed,
    reply: next.text,
    traces: [first.trace, next.trace],
  };
}

if (process.argv.includes("--chat-only") || process.argv.includes("--chat")) {
  for (const model of models) {
    for (let iteration = 1; iteration <= repetitions; iteration++)
      await record(model, `chat-tool-round-trip-${iteration}`, () =>
        chatRoundTrip(model, iteration),
      );
  }
}
