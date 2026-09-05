/**
 * Live black-box verification through the standard OpenAI Responses surface.
 *
 * It validates request-boundary projection without depending on Zuno or
 * another Agent runtime. The provider log is read incrementally so every case
 * proves request_id, SDK dispatch count, effort, terminal witness, and absence
 * of provider errors.
 *
 * Usage:
 *   bun run scripts/responses-live-e2e.ts --confirm \
 *     --endpoint http://127.0.0.1:18787/v1 \
 *     --config /tmp/isolated-provider/config.json \
 *     --log-file /tmp/provider.log \
 *     --out /tmp/responses-live-e2e.json
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

type AuditEvent = Readonly<Record<string, unknown>>;

interface Options {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly logFile: string;
  readonly out?: string;
  readonly repetitions: number;
  readonly confirm: boolean;
}

interface CaseResult {
  readonly name: string;
  readonly expectedStatus: number;
  readonly status: number;
  readonly passed: boolean;
  readonly outputChars: number;
  readonly outputHash: string;
  readonly requestId?: string;
  readonly sdkDispatches: number;
  readonly terminals: number;
  readonly allTerminalsWitnessed: boolean;
  readonly providerErrors: number;
  readonly efforts: readonly string[];
  readonly accountHashes: readonly string[];
  readonly suffixActions: readonly string[];
  readonly errorCode?: string;
  readonly errorParam?: string;
  readonly durationMs: number;
}

interface LiveReport {
  readonly schema_version: 1;
  readonly endpoint: string;
  readonly cases: readonly CaseResult[];
  readonly allPassed: boolean;
}

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const INLINE_TEXT = "data:text/plain;base64,U3ludGhldGljIGRvY3VtZW50Lg==";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function parseOptions(): Options {
  const endpoint = argument("--endpoint");
  const directApiKey = argument("--api-key");
  const configPath = argument("--config");
  const logFile = argument("--log-file");
  if (!endpoint || (!directApiKey && !configPath) || !logFile) {
    throw new Error("--endpoint, --log-file, and one of --api-key/--config are required");
  }
  const config: unknown = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : undefined;
  const configApiKey =
    isRecord(config) && Array.isArray(config.api_keys)
      ? config.api_keys.find((candidate) => typeof candidate === "string")
      : undefined;
  const apiKey = directApiKey ?? configApiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("--config must contain a non-empty API key");
  }
  const repetitions = Number(argument("--n", "3"));
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error("--n must be a positive integer");
  }
  return {
    endpoint: endpoint.replace(/\/+$/u, ""),
    apiKey,
    logFile,
    ...(argument("--out") ? { out: argument("--out") } : {}),
    repetitions,
    confirm: process.argv.includes("--confirm"),
  };
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) return "";
  const chunks: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("");
}

function errorDetails(value: unknown): { code?: string; param?: string } {
  if (!isRecord(value) || !isRecord(value.error)) return {};
  return {
    ...(typeof value.error.code === "string" ? { code: value.error.code } : {}),
    ...(typeof value.error.param === "string" ? { param: value.error.param } : {}),
  };
}

function readNewEvents(path: string, offset: number): AuditEvent[] {
  const bytes = readFileSync(path);
  return new TextDecoder()
    .decode(bytes.subarray(Math.min(offset, bytes.length)))
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

function summarizeEvents(events: readonly AuditEvent[]): {
  requestId?: string;
  sdkDispatches: number;
  terminals: number;
  allTerminalsWitnessed: boolean;
  providerErrors: number;
  efforts: string[];
  accountHashes: string[];
  suffixActions: string[];
} {
  const requestId = events.map((event) => stringValue(event.request_id)).find(Boolean);
  const correlated = requestId
    ? events.filter((event) => stringValue(event.request_id) === requestId)
    : events;
  const terminals = correlated.filter((event) => event.event === "sdk_stream_terminal");
  const errorNames = new Set([
    "request_transform_rejected",
    "sdk_stream_upstream_error",
    "pipeline_internal_error",
  ]);
  return {
    ...(requestId ? { requestId } : {}),
    sdkDispatches: correlated.filter((event) => event.event === "sdk_dispatch_started").length,
    terminals: terminals.length,
    allTerminalsWitnessed:
      terminals.length > 0 && terminals.every((event) => event.completion_witnessed === true),
    providerErrors: correlated.filter((event) => errorNames.has(stringValue(event.event))).length,
    efforts: [
      ...new Set(correlated.map((event) => stringValue(event.effort)).filter(Boolean)),
    ].sort(),
    accountHashes: [
      ...new Set(correlated.map((event) => stringValue(event.account_hash)).filter(Boolean)),
    ].sort(),
    suffixActions: [
      ...new Set(correlated.map((event) => stringValue(event.suffix_action)).filter(Boolean)),
    ].sort(),
  };
}

async function executeCase(
  options: Options,
  name: string,
  body: Record<string, unknown>,
  expectedStatus: number,
  validate: (body: unknown, events: ReturnType<typeof summarizeEvents>) => boolean,
): Promise<CaseResult> {
  const offset = statSync(options.logFile).size;
  const started = Date.now();
  const response = await fetch(`${options.endpoint}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  await Bun.sleep(50);
  const summary = summarizeEvents(readNewEvents(options.logFile, offset));
  const text = outputText(responseBody);
  const error = errorDetails(responseBody);
  return {
    name,
    expectedStatus,
    status: response.status,
    passed: response.status === expectedStatus && validate(responseBody, summary),
    outputChars: text.length,
    outputHash: hash16(text),
    ...summary,
    ...(error.code ? { errorCode: error.code } : {}),
    ...(error.param ? { errorParam: error.param } : {}),
    durationMs: Date.now() - started,
  };
}

function success(
  expectedSuffixAction?: string,
  expectedEffort?: string,
): (body: unknown, events: ReturnType<typeof summarizeEvents>) => boolean {
  return (_body, events) =>
    events.sdkDispatches === 1 &&
    events.terminals === 1 &&
    events.allTerminalsWitnessed &&
    events.providerErrors === 0 &&
    (expectedSuffixAction === undefined || events.suffixActions.includes(expectedSuffixAction)) &&
    (expectedEffort === undefined || events.efforts.includes(expectedEffort));
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (!options.confirm) {
    throw new Error("live Responses E2E requires --confirm");
  }
  const cases: CaseResult[] = [];
  cases.push(
    await executeCase(
      options,
      "trailing-instruction-after-assistant",
      {
        model: "claude-opus-5",
        stream: false,
        input: [
          { role: "user", content: "Synthetic question." },
          { role: "assistant", content: "Synthetic completed answer." },
          {
            role: "developer",
            content: "Reply with exactly RESPONSES_TRAILING_OK and nothing else.",
          },
        ],
        reasoning: { effort: "xhigh" },
      },
      200,
      success("synthetic_user", "xhigh"),
    ),
  );
  cases.push(
    await executeCase(
      options,
      "structured-tool-result-with-trailing-instruction",
      {
        model: "gpt-5.6-sol",
        stream: false,
        tools: [
          {
            type: "function",
            name: "synthetic_echo",
            description: "Echo one synthetic test result.",
            parameters: { type: "object", properties: {} },
          },
        ],
        input: [
          {
            role: "user",
            content: "Use the synthetic tool once.",
          },
          {
            role: "assistant",
            content: "I will call the synthetic tool.",
          },
          {
            type: "function_call",
            call_id: "call_synthetic_1",
            name: "synthetic_echo",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_synthetic_1",
            output: "synthetic result",
          },
          {
            role: "developer",
            content: "Reply with exactly RESPONSES_TOOL_RESULT_OK and nothing else.",
          },
        ],
        reasoning: { effort: "xhigh" },
      },
      200,
      success("append_tool", "xhigh"),
    ),
  );
  cases.push(
    await executeCase(
      options,
      "empty-text-with-image-document-and-trailing-instruction",
      {
        model: "claude-opus-5",
        stream: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "" },
              { type: "input_image", image_url: ONE_PIXEL_PNG },
              {
                type: "input_file",
                filename: "synthetic.txt",
                file_data: INLINE_TEXT,
              },
            ],
          },
          {
            role: "developer",
            content: "Reply with exactly RESPONSES_ATTACHMENTS_OK and nothing else.",
          },
        ],
        reasoning: { effort: "xhigh" },
      },
      200,
      success("append_user", "xhigh"),
    ),
  );
  cases.push(
    await executeCase(
      options,
      "assistant-ending-rejection",
      {
        model: "gpt-5.6-sol",
        stream: false,
        input: [{ role: "assistant", content: "Synthetic assistant prefill." }],
      },
      400,
      (body, events) => {
        const error = errorDetails(body);
        return (
          error.code === "missing_current_input" &&
          error.param === "input.0" &&
          events.sdkDispatches === 0 &&
          events.terminals === 0 &&
          events.providerErrors === 1
        );
      },
    ),
  );

  for (const model of ["gpt-5.6-sol", "claude-opus-5"]) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const order = repetition % 2 === 1 ? ["max", "xhigh"] : ["xhigh", "max"];
      for (const effort of order) {
        cases.push(
          await executeCase(
            options,
            `effort-${model}-${effort}-r${repetition}`,
            {
              model,
              stream: false,
              input: `Reply with exactly RESPONSES_EFFORT_${model}_${effort}_${repetition} and nothing else.`,
              reasoning: { effort },
            },
            200,
            success(undefined, effort),
          ),
        );
      }
    }
  }

  const report: LiveReport = {
    schema_version: 1,
    endpoint: options.endpoint,
    cases,
    allPassed: cases.every((result) => result.passed),
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, rendered, { mode: 0o600 });
  else process.stdout.write(rendered);
  process.exitCode = report.allPassed ? 0 : 1;
}

if (import.meta.main) await main();
