/**
 * Probes the native KiroRuntime CreateResponse operation discovered in the
 * KAS 0.58.7 Smithy model. Outputs only status, structure, lengths, and hashes.
 */

import { createHash } from "node:crypto";
import { KIRO_CONSTANTS } from "../src/kiro/constants.js";
import { loadProbeAuth } from "./probe-v3-request-fields.js";

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index < 0 || process.argv[index + 1] === undefined
    ? fallback
    : (process.argv[index + 1] as string);
}

function hash16(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromResponse(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) return "";
  return value.output
    .filter(isRecord)
    .filter((item) => item.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content as unknown[])
    .filter(isRecord)
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function structuralSummary(
  value: Awaited<ReturnType<typeof requestNative>>,
): Readonly<Record<string, unknown>> {
  const output = isRecord(value.parsed) ? value.parsed.Output : undefined;
  return {
    status: value.response.status,
    content_type: value.response.headers.get("content-type"),
    body_bytes: value.bytes.byteLength,
    body_hash: hash16(value.bytes),
    top_keys: isRecord(value.parsed) ? Object.keys(value.parsed).sort() : [],
    output_kind: Array.isArray(output) ? "array" : output === null ? "null" : typeof output,
    output_keys: isRecord(output) ? Object.keys(output).sort() : [],
    output_chars: typeof output === "string" ? output.length : undefined,
    output_hash: typeof output === "string" ? hash16(output) : undefined,
    version_kind: isRecord(value.parsed) ? typeof value.parsed.Version : undefined,
  };
}

async function requestNative(
  method: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  endpoint: string,
  proxyUrl: string | undefined,
  body?: unknown,
): Promise<{
  readonly response: Response;
  readonly bytes: Uint8Array;
  readonly parsed?: unknown;
}> {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let parsed: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      parsed = undefined;
    }
  }
  return { response, bytes, ...(parsed === undefined ? {} : { parsed }) };
}

async function probe(
  name: string,
  headers: Readonly<Record<string, string>>,
  body: string,
  endpoint: string,
  proxyUrl?: string,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown;
    if (contentType.includes("json") || contentType.includes("text")) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        parsed = undefined;
      }
    }
    const text = textFromResponse(parsed);
    return {
      name,
      status: response.status,
      content_type: contentType,
      duration_ms: Math.round(performance.now() - startedAt),
      body_bytes: bytes.byteLength,
      body_hash: hash16(bytes),
      json: parsed !== undefined,
      top_keys: isRecord(parsed) ? Object.keys(parsed).sort() : [],
      response_object: isRecord(parsed) ? parsed.object : undefined,
      response_status: isRecord(parsed) ? parsed.status : undefined,
      output_item_types:
        isRecord(parsed) && Array.isArray(parsed.output)
          ? parsed.output
              .filter(isRecord)
              .map((item) => item.type)
              .filter((type): type is string => typeof type === "string")
          : [],
      text_chars: text.length,
      text_hash: hash16(text),
      marker_present: text.includes("CREATE_RESPONSE_OK"),
    };
  } catch (error) {
    return {
      name,
      status: 0,
      code:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : typeof error,
      duration_ms: Math.round(performance.now() - startedAt),
    };
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    throw new Error("Live probes require --confirm");
  }
  const account = loadProbeAuth();
  const proxyUrl = argument("--proxy") || undefined;
  const model = argument("--model", "gpt-5.6-sol");
  const endpoint = KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", account.auth.region);
  const body = JSON.stringify({
    model,
    input: "Reply with exactly CREATE_RESPONSE_OK.",
    stream: false,
  });
  const common = {
    Authorization: `Bearer ${account.auth.access}`,
    "User-Agent": "KiroCLI/2.21.1 KAS/0.58.7",
    "x-amzn-kiro-origin": "AI_EDITOR",
    ...(account.auth.profileArn ? { "x-amzn-kiro-profile": account.auth.profileArn } : {}),
  };
  if (process.argv.includes("--methods-only")) {
    const headers = { ...common, "Content-Type": "application/json" };
    const body = { model, input: "Synthetic extended-method probe." };
    const [inputTokens, compact] = await Promise.all([
      requestNative("POST", "/v1/responses/input_tokens", headers, endpoint, proxyUrl, body),
      requestNative("POST", "/v1/responses/compact", headers, endpoint, proxyUrl, body),
    ]);
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 1,
          model,
          account_hash: hash16(account.id),
          input_tokens: structuralSummary(inputTokens),
          compact: structuralSummary(compact),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (process.argv.includes("--deep")) {
    const headers = { ...common, "Content-Type": "application/json" };
    const marker = `NATIVE_DEEP_${crypto.randomUUID().slice(0, 8)}`;
    const first = await requestNative("POST", "/v1/responses", headers, endpoint, proxyUrl, {
      model,
      instructions: `Remember the synthetic marker ${marker}.`,
      input: "Reply with exactly FIRST_OK.",
      stream: false,
      store: true,
    });
    const firstId =
      isRecord(first.parsed) && typeof first.parsed.id === "string" ? first.parsed.id : undefined;
    const second =
      firstId === undefined
        ? undefined
        : await requestNative("POST", "/v1/responses", headers, endpoint, proxyUrl, {
            model,
            previous_response_id: firstId,
            input: "Reply with only the synthetic marker from the previous response.",
            stream: false,
            store: true,
          });
    const retrieved =
      firstId === undefined
        ? undefined
        : await requestNative(
            "GET",
            `/v1/responses/${encodeURIComponent(firstId)}`,
            headers,
            endpoint,
            proxyUrl,
          );
    const inputItems =
      firstId === undefined
        ? undefined
        : await requestNative(
            "GET",
            `/v1/responses/${encodeURIComponent(firstId)}/input_items`,
            headers,
            endpoint,
            proxyUrl,
          );
    const tool = await requestNative("POST", "/v1/responses", headers, endpoint, proxyUrl, {
      model,
      input: "Call synthetic_echo with value 7.",
      tools: [
        {
          type: "function",
          name: "synthetic_echo",
          description: "Return a synthetic number",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
          },
          strict: false,
        },
      ],
      tool_choice: "auto",
      stream: false,
      store: false,
    });
    const streamed = await requestNative("POST", "/v1/responses", headers, endpoint, proxyUrl, {
      model,
      input: "Reply with exactly STREAM_OK.",
      stream: true,
      store: false,
    });
    const inputTokens = await requestNative(
      "POST",
      "/v1/responses/input_tokens",
      headers,
      endpoint,
      proxyUrl,
      {
        model,
        input: "Synthetic input-token probe.",
      },
    );
    const compact = await requestNative(
      "POST",
      "/v1/responses/compact",
      headers,
      endpoint,
      proxyUrl,
      {
        model,
        input: "Synthetic compaction probe.",
      },
    );
    const fieldBodies: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ["instructions", { instructions: "Reply exactly FIELD_OK." }],
      ["temperature", { temperature: 0 }],
      ["top_p", { top_p: 0.9 }],
      ["max_output_tokens", { max_output_tokens: 512 }],
      ["truncation_disabled", { truncation: "disabled" }],
      ["truncation_auto", { truncation: "auto" }],
      ["reasoning_xhigh", { reasoning: { effort: "xhigh" } }],
      ["store_false", { store: false }],
      ["service_tier", { service_tier: "default" }],
      ["text_format", { text: { format: { type: "json_object" } } }],
    ];
    const fieldResults: Record<string, unknown> = {};
    for (const [name, fields] of fieldBodies) {
      fieldResults[name] = await requestNative(
        "POST",
        "/v1/responses",
        headers,
        endpoint,
        proxyUrl,
        {
          model,
          input: "Reply with exactly FIELD_OK.",
          stream: false,
          ...fields,
        },
      );
    }
    const streamText = new TextDecoder().decode(streamed.bytes);
    const streamEvents = streamText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line.slice(6));
          return isRecord(parsed) && typeof parsed.type === "string" ? [parsed.type] : [];
        } catch {
          return [];
        }
      });
    const deleted =
      firstId === undefined
        ? undefined
        : await requestNative(
            "DELETE",
            `/v1/responses/${encodeURIComponent(firstId)}`,
            headers,
            endpoint,
            proxyUrl,
          );
    const summary = (value: Awaited<ReturnType<typeof requestNative>> | undefined) => {
      if (!value) return { status: 0 };
      const text = textFromResponse(value.parsed);
      return {
        status: value.response.status,
        content_type: value.response.headers.get("content-type"),
        body_bytes: value.bytes.byteLength,
        body_hash: hash16(value.bytes),
        top_keys: isRecord(value.parsed) ? Object.keys(value.parsed).sort() : [],
        object: isRecord(value.parsed) ? value.parsed.object : undefined,
        response_status: isRecord(value.parsed) ? value.parsed.status : undefined,
        error_reason: isRecord(value.parsed) ? value.parsed.reason : undefined,
        error_message:
          isRecord(value.parsed) && typeof value.parsed.message === "string"
            ? value.parsed.message
            : undefined,
        store: isRecord(value.parsed) ? value.parsed.store : undefined,
        previous_response_id: isRecord(value.parsed)
          ? value.parsed.previous_response_id
          : undefined,
        output_item_types:
          isRecord(value.parsed) && Array.isArray(value.parsed.output)
            ? value.parsed.output
                .filter(isRecord)
                .map((item) => item.type)
                .filter((type): type is string => typeof type === "string")
            : [],
        text_chars: text.length,
        text_hash: hash16(text),
        marker_present: text.includes(marker),
      };
    };
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 1,
          model,
          account_hash: hash16(account.id),
          first_id_hash: firstId === undefined ? null : hash16(firstId),
          first: summary(first),
          continuation: summary(second),
          retrieve: summary(retrieved),
          input_items: summary(inputItems),
          tool: summary(tool),
          stream: {
            ...summary(streamed),
            event_count: streamEvents.length,
            event_types: [...new Set(streamEvents)],
            marker_present: streamText.includes("STREAM_OK"),
          },
          input_tokens: summary(inputTokens),
          compact: summary(compact),
          fields: Object.fromEntries(
            Object.entries(fieldResults).map(([name, value]) => [
              name,
              summary(value as Awaited<ReturnType<typeof requestNative>>),
            ]),
          ),
          delete: summary(deleted),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const results = await Promise.all([
    probe(
      "aws-json-target",
      {
        ...common,
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "KiroRuntimeService.CreateResponse",
      },
      body,
      endpoint,
      proxyUrl,
    ),
    probe(
      "aws-json-no-target",
      {
        ...common,
        "Content-Type": "application/x-amz-json-1.0",
      },
      body,
      endpoint,
      proxyUrl,
    ),
    probe(
      "application-json",
      {
        ...common,
        "Content-Type": "application/json",
      },
      body,
      endpoint,
      proxyUrl,
    ),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        model,
        account_hash: hash16(account.id),
        results,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) await main();
