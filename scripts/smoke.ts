const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_REASONING_MODEL = "gpt-5.6-sol-high";
// Anthropic Messages requires max_tokens, which the gateway accepts only for
// models with a probe-confirmed native output-token limit.
const DEFAULT_MESSAGES_MODEL = "claude-sonnet-5";
const PROMPT = "Reply with exactly: OK";
const LEGACY_DISABLED_CODE = "legacy_chat_completions_disabled";
const LEGACY_SKIP_NOTE =
  "legacy /v1/chat/completions is disabled (enable_legacy_chat_completions=false); skipped";

type Options = {
  readonly baseUrl: string;
  readonly key: string;
  readonly model: string;
  readonly reasoningModel: string;
  readonly messagesModel: string;
};

type MutableOptions = {
  baseUrl: string;
  key: string;
  model: string;
  reasoningModel: string;
  messagesModel: string;
};

type CheckOutcome = "passed" | "skipped";

type Check = {
  readonly name: string;
  readonly run: () => Promise<CheckOutcome>;
};

class SmokeError extends Error {
  readonly name = "SmokeError";
}

const HELP = `Usage: bun run scripts/smoke.ts [options]

Runs live end-to-end checks against a running kiro-provider gateway:
GET /v1/models, POST /v1/responses (JSON, SSE, and reasoning effort),
POST /v1/messages, and the legacy POST /v1/chat/completions checks. The legacy
checks are reported as skipped when the gateway answers 404
${LEGACY_DISABLED_CODE} (the default configuration).

Options:
  --base-url <url>          Gateway URL (default: ${DEFAULT_BASE_URL})
  --key <key>               Bearer key (env: KIRO_PROVIDER_SMOKE_KEY)
  --model <id>              Claude model (default: ${DEFAULT_MODEL})
  --reasoning-model <id>    Effort model (default: ${DEFAULT_REASONING_MODEL})
  --messages-model <id>     Anthropic Messages model; must accept max_tokens
                            (default: ${DEFAULT_MESSAGES_MODEL})
  --help                    Show this help

Environment fallbacks:
  KIRO_PROVIDER_BASE_URL
  KIRO_PROVIDER_HOST (used with KIRO_PROVIDER_PORT)
  KIRO_PROVIDER_PORT
  KIRO_PROVIDER_SMOKE_KEY
  KIRO_PROVIDER_SMOKE_MODEL
  KIRO_PROVIDER_SMOKE_REASONING_MODEL
  KIRO_PROVIDER_SMOKE_MESSAGES_MODEL`;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new SmokeError(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SmokeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new SmokeError(`${flag} requires a value`);
  return value;
}

type BaseUrlFlags = {
  readonly baseUrl?: string;
};

export function resolveBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  flags: BaseUrlFlags,
): string {
  const port = env.KIRO_PROVIDER_PORT;
  const host = env.KIRO_PROVIDER_HOST ?? "127.0.0.1";
  const value =
    flags.baseUrl ??
    env.KIRO_PROVIDER_BASE_URL ??
    (port === undefined ? DEFAULT_BASE_URL : `http://${host}:${port}`);
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof TypeError) throw new SmokeError(`Invalid --base-url: ${value}`);
    throw error;
  }
}

function parseOptions(args: readonly string[]): Options | null {
  if (args.includes("--help")) return null;

  const options: MutableOptions = {
    baseUrl: "",
    key: process.env.KIRO_PROVIDER_SMOKE_KEY ?? "",
    model: process.env.KIRO_PROVIDER_SMOKE_MODEL ?? DEFAULT_MODEL,
    reasoningModel: process.env.KIRO_PROVIDER_SMOKE_REASONING_MODEL ?? DEFAULT_REASONING_MODEL,
    messagesModel: process.env.KIRO_PROVIDER_SMOKE_MESSAGES_MODEL ?? DEFAULT_MESSAGES_MODEL,
  };
  const targets: Readonly<Record<string, keyof MutableOptions>> = {
    "--base-url": "baseUrl",
    "--key": "key",
    "--model": "model",
    "--reasoning-model": "reasoningModel",
    "--messages-model": "messagesModel",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const target = targets[flag];
    if (!target) throw new SmokeError(`Unknown option: ${flag}. Use --help for usage.`);
    const value =
      equalsIndex === -1 ? readFlagValue(args, index, flag) : argument.slice(equalsIndex + 1);
    if (value.trim().length === 0) throw new SmokeError(`${flag} requires a non-empty value`);
    options[target] = value;
    if (equalsIndex === -1) index += 1;
  }

  if (options.key.trim().length === 0) {
    throw new SmokeError("Missing API key. Set KIRO_PROVIDER_SMOKE_KEY or pass --key.");
  }
  options.baseUrl = resolveBaseUrl(
    process.env,
    options.baseUrl.length === 0 ? {} : { baseUrl: options.baseUrl },
  );
  return options;
}

function headers(key: string): Readonly<Record<string, string>> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function requireSuccess(response: Response): Promise<void> {
  if (response.status === 200) return;
  const detail = await response.text();
  throw new SmokeError(`HTTP ${response.status} ${response.statusText}: ${detail}`);
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  await requireSuccess(response);
  return response.json();
}

type SseFrame = {
  readonly event: string | null;
  readonly data: string;
};

function parseSseFrame(frame: string): SseFrame {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    } else {
      throw new SmokeError(`Malformed SSE line: ${JSON.stringify(line)}`);
    }
  }
  if (data.length === 0) throw new SmokeError(`SSE frame without data: ${JSON.stringify(frame)}`);
  return { event, data: data.join("\n") };
}

async function readSseFrames(
  response: Response,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  if (!response.body) throw new SmokeError("streaming response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    buffer += decoder.decode(result.value, { stream: !result.done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      onFrame(parseSseFrame(buffer.slice(0, boundary)));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (result.done) break;
  }
  if (buffer.trim().length > 0)
    throw new SmokeError(`Unterminated SSE frame: ${JSON.stringify(buffer)}`);
}

async function checkModels(options: Options): Promise<CheckOutcome> {
  const body = requireRecord(
    await requestJson(`${options.baseUrl}/v1/models`, {
      headers: headers(options.key),
    }),
    "models response",
  );
  if (body.object !== "list") throw new SmokeError('models response object must be "list"');
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new SmokeError("models response data must be a non-empty array");
  }
  const ids = data.map((item, index) => {
    const model = requireRecord(item, `data[${index}]`);
    if (model.object !== "model") throw new SmokeError(`data[${index}].object must be "model"`);
    return requireNonEmptyString(model.id, `data[${index}].id`);
  });
  console.log(`    Models (${ids.length}): ${ids.join(", ")}`);
  return "passed";
}

function responsesBody(model: string, stream: boolean, reasoningEffort?: "high"): string {
  return JSON.stringify({
    model,
    stream,
    input: PROMPT,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  });
}

function responseOutputItems(
  response: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const output = response.output;
  if (!Array.isArray(output)) throw new SmokeError("response.output must be an array");
  return output.map((item, index) => requireRecord(item, `output[${index}]`));
}

function responseOutputText(items: readonly Readonly<Record<string, unknown>>[]): string {
  const texts: string[] = [];
  for (const [index, item] of items.entries()) {
    if (item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) throw new SmokeError(`output[${index}].content must be an array`);
    for (const part of content) {
      const block = requireRecord(part, `output[${index}].content[]`);
      if (block.type === "output_text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("");
}

function parseCompletedResponse(body: unknown): Readonly<Record<string, unknown>> {
  const response = requireRecord(body, "responses body");
  if (response.object !== "response") throw new SmokeError('response object must be "response"');
  if (response.status !== "completed") {
    throw new SmokeError(
      `response status must be "completed", received ${JSON.stringify(response.status)}`,
    );
  }
  return response;
}

async function checkResponses(options: Options): Promise<CheckOutcome> {
  const response = parseCompletedResponse(
    await requestJson(`${options.baseUrl}/v1/responses`, {
      method: "POST",
      headers: headers(options.key),
      body: responsesBody(options.model, false),
    }),
  );
  const text = requireNonEmptyString(
    responseOutputText(responseOutputItems(response)),
    "response output_text",
  );
  const usage = requireRecord(response.usage, "usage");
  console.log(`    Output: ${JSON.stringify(text)}`);
  console.log(`    Usage: ${JSON.stringify(usage)}`);
  return "passed";
}

async function checkResponsesStreaming(options: Options): Promise<CheckOutcome> {
  const response = await fetch(`${options.baseUrl}/v1/responses`, {
    method: "POST",
    headers: headers(options.key),
    body: responsesBody(options.model, true),
  });
  await requireSuccess(response);
  const state = { text: "", events: 0, completed: 0 };
  await readSseFrames(response, (frame) => {
    const parsed: unknown = JSON.parse(frame.data);
    const event = requireRecord(parsed, "Responses SSE event");
    const type = requireNonEmptyString(event.type, "event.type");
    if (type === "error" || type === "response.failed") {
      throw new SmokeError(`Responses stream error event: ${frame.data}`);
    }
    if (frame.event !== null && frame.event !== type) {
      throw new SmokeError(`SSE event name ${frame.event} does not match payload type ${type}`);
    }
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      state.text += event.delta;
    }
    if (type === "response.completed") {
      parseCompletedResponse(event.response);
      state.completed += 1;
    }
    state.events += 1;
  });
  if (state.events === 0) throw new SmokeError("stream returned no events");
  if (state.completed !== 1) {
    throw new SmokeError(`expected exactly one response.completed, received ${state.completed}`);
  }
  requireNonEmptyString(state.text, "assembled streaming output_text");
  console.log(`    Output (${state.events} events): ${JSON.stringify(state.text)}`);
  return "passed";
}

async function checkResponsesReasoning(options: Options): Promise<CheckOutcome> {
  const response = parseCompletedResponse(
    await requestJson(`${options.baseUrl}/v1/responses`, {
      method: "POST",
      headers: headers(options.key),
      body: responsesBody(options.reasoningModel, false, "high"),
    }),
  );
  const items = responseOutputItems(response);
  const text = requireNonEmptyString(responseOutputText(items), "response output_text");
  const reasoningItems = items.filter((item) => item.type === "reasoning").length;
  console.log("    Requested reasoning.effort: high");
  if (reasoningItems > 0) {
    console.log(`    Reasoning items: ${reasoningItems}`);
  } else {
    console.log("    NOTE: model returned no reasoning output item");
  }
  console.log(`    Output: ${JSON.stringify(text)}`);
  return "passed";
}

function messagesBody(model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: PROMPT }],
  });
}

async function checkMessages(options: Options): Promise<CheckOutcome> {
  const body = requireRecord(
    await requestJson(`${options.baseUrl}/v1/messages`, {
      method: "POST",
      headers: headers(options.key),
      body: messagesBody(options.messagesModel),
    }),
    "messages response",
  );
  if (body.type !== "message") throw new SmokeError('messages response type must be "message"');
  if (body.role !== "assistant") throw new SmokeError('messages response role must be "assistant"');
  const content = body.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new SmokeError("messages response content must be a non-empty array");
  }
  const text = content
    .map((block, index) => {
      const record = requireRecord(block, `content[${index}]`);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
  requireNonEmptyString(text, "message text content");
  const usage = requireRecord(body.usage, "usage");
  console.log(`    Content: ${JSON.stringify(text)}`);
  console.log(`    Stop reason: ${JSON.stringify(body.stop_reason)}`);
  console.log(`    Usage: ${JSON.stringify(usage)}`);
  return "passed";
}

function chatBody(model: string, stream: boolean, reasoningEffort?: "high"): string {
  return JSON.stringify({
    model,
    stream,
    messages: [{ role: "user", content: PROMPT }],
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  });
}

async function legacyChatResponse(options: Options, body: string): Promise<Response | "disabled"> {
  const response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(options.key),
    body,
  });
  if (response.status !== 404) return response;
  const detail = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    parsed = undefined;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  if (error?.code === LEGACY_DISABLED_CODE) return "disabled";
  throw new SmokeError(`HTTP 404 ${response.statusText}: ${detail}`);
}

function skipLegacy(): CheckOutcome {
  console.log(`    ${LEGACY_SKIP_NOTE}`);
  return "skipped";
}

function parseCompletion(body: unknown): Readonly<Record<string, unknown>> {
  const completion = requireRecord(body, "completion response");
  if (completion.object !== "chat.completion") {
    throw new SmokeError('completion response object must be "chat.completion"');
  }
  const choices = completion.choices;
  if (!Array.isArray(choices) || !choices[0])
    throw new SmokeError("completion has no first choice");
  return requireRecord(requireRecord(choices[0], "choices[0]").message, "choices[0].message");
}

async function checkNonStreaming(options: Options): Promise<CheckOutcome> {
  const response = await legacyChatResponse(options, chatBody(options.model, false));
  if (response === "disabled") return skipLegacy();
  await requireSuccess(response);
  const body: unknown = await response.json();
  const content = requireNonEmptyString(parseCompletion(body).content, "message.content");
  const usage = requireRecord(requireRecord(body, "completion response").usage, "usage");
  console.log(`    Content: ${JSON.stringify(content)}`);
  console.log(`    Usage: ${JSON.stringify(usage)}`);
  return "passed";
}

function consumeChatFrame(
  frame: SseFrame,
  state: { content: string; chunks: number; done: number },
): void {
  if (frame.data === "[DONE]") {
    state.done += 1;
    return;
  }
  const parsed: unknown = JSON.parse(frame.data);
  const chunk = requireRecord(parsed, "SSE chunk");
  if ("error" in chunk) throw new SmokeError(`SSE error frame: ${frame.data}`);
  if (chunk.object !== "chat.completion.chunk") {
    throw new SmokeError('SSE chunk object must be "chat.completion.chunk"');
  }
  const choices = chunk.choices;
  if (!Array.isArray(choices)) throw new SmokeError("SSE chunk choices must be an array");
  const first = choices[0];
  if (first) {
    const delta = requireRecord(requireRecord(first, "SSE choice").delta, "SSE delta");
    if (typeof delta.content === "string") state.content += delta.content;
  }
  state.chunks += 1;
}

async function checkStreaming(options: Options): Promise<CheckOutcome> {
  const response = await legacyChatResponse(options, chatBody(options.model, true));
  if (response === "disabled") return skipLegacy();
  await requireSuccess(response);
  const state = { content: "", chunks: 0, done: 0 };
  await readSseFrames(response, (frame) => consumeChatFrame(frame, state));
  if (state.chunks === 0) throw new SmokeError("stream returned no JSON chunks");
  if (state.done !== 1) throw new SmokeError(`expected exactly one [DONE], received ${state.done}`);
  requireNonEmptyString(state.content, "assembled streaming content");
  console.log(`    Content (${state.chunks} chunks): ${JSON.stringify(state.content)}`);
  return "passed";
}

async function checkReasoning(options: Options): Promise<CheckOutcome> {
  const response = await legacyChatResponse(
    options,
    chatBody(options.reasoningModel, false, "high"),
  );
  if (response === "disabled") return skipLegacy();
  await requireSuccess(response);
  const message = parseCompletion(await response.json());
  const content = requireNonEmptyString(message.content, "message.content");
  const reasoning = message.reasoning_content;
  console.log("    Requested reasoning_effort: high");
  if (typeof reasoning === "string" && reasoning.trim().length > 0) {
    console.log(`    Reasoning: ${JSON.stringify(reasoning)}`);
  } else {
    console.log("    NOTE: model returned no reasoning_content");
  }
  console.log(`    Content: ${JSON.stringify(content)}`);
  return "passed";
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  if (!options) {
    console.log(HELP);
    return;
  }
  console.log(`Kiro provider smoke test: ${options.baseUrl}`);
  console.log(
    `Models: chat=${options.model}, reasoning=${options.reasoningModel}, messages=${options.messagesModel}`,
  );
  const checks: readonly Check[] = [
    { name: "GET /v1/models", run: () => checkModels(options) },
    { name: "Non-streaming Responses", run: () => checkResponses(options) },
    { name: "Streaming Responses", run: () => checkResponsesStreaming(options) },
    { name: "Thinking / effort Responses", run: () => checkResponsesReasoning(options) },
    { name: "Non-streaming Anthropic Messages", run: () => checkMessages(options) },
    { name: "Legacy non-streaming chat completion", run: () => checkNonStreaming(options) },
    { name: "Legacy streaming chat completion", run: () => checkStreaming(options) },
    { name: "Legacy thinking / effort chat completion", run: () => checkReasoning(options) },
  ];
  const totals = { passed: 0, skipped: 0, failed: 0 };
  for (const [index, check] of checks.entries()) {
    console.log(`\n[${index + 1}/${checks.length}] ${check.name}`);
    try {
      const outcome = await check.run();
      totals[outcome] += 1;
      console.log(`  ${outcome === "passed" ? "PASS" : "SKIP"} ${check.name}`);
    } catch (error) {
      totals.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAIL ${check.name}: ${message}`);
    }
  }
  console.log(
    `\nSummary: ${totals.passed} passed, ${totals.skipped} skipped, ${totals.failed} failed (${checks.length} checks)`,
  );
  if (totals.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL smoke setup: ${message}`);
    process.exitCode = 1;
  });
}
