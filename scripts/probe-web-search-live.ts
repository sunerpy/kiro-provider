/**
 * Live hosted web search matrix against an isolated gateway (see
 * scripts/prepare-web-search-gateway.ts).
 *
 *   bun run scripts/probe-web-search-live.ts --base-url http://127.0.0.1:18879/ \
 *     --provider-config <isolated config.json> --out <evidence.json> \
 *     --phase first|resume --state <private continuation file> \
 *     [--gateway-log <gateway stderr>] [--models gpt-5.6-sol,claude-opus-5-5] [--label source]
 *
 * `first` runs fresh searches (Responses through the official OpenAI SDK and
 * Messages over HTTP; stream and non-stream; pure and mixed tool groups) and
 * keeps the returned conversations in a private state file. Restart the
 * gateway, then `resume` replays every conversation for the next user turn,
 * a Codex-shaped replay, an effort-alias and a real model switch, and a
 * tampered history. Evidence holds only enums, counts, booleans and hashes;
 * the state file holds model output and must stay private and be deleted.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI from "openai";
import { ConfigSchema } from "../src/config/schema.js";

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

const repository = resolve(import.meta.dir, "..");
const outside = (path: string | undefined): path is string =>
  path !== undefined && !resolve(path).startsWith(`${repository}/`);

function revision(): Json {
  const run = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe" }).stdout;
  const hash = createHash("sha256");
  hash.update(run(["diff", "HEAD", "--binary"]));
  const untracked = new TextDecoder()
    .decode(run(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of untracked) {
    hash.update(`\0${file}\0`);
    hash.update(readFileSync(resolve(repository, file)));
  }
  return {
    head: new TextDecoder().decode(run(["rev-parse", "HEAD"])).trim(),
    worktree_sha256: hash.digest("hex"),
    untracked_files: untracked.length,
  };
}

function counts(values: readonly unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[String(value)] = (result[String(value)] ?? 0) + 1;
  return result;
}

const SEARCH_PROMPT =
  "What is the latest stable release of the Bun JavaScript runtime and what is one notable change in it? Use the web search tool, then answer in two sentences and cite the release notes with a markdown link.";
const MIXED_PROMPT =
  "Do two things at once, in the same response and in parallel: (1) use the web search tool to find the latest stable release of the TypeScript compiler, and (2) call get_build_marker with an empty object. After both results arrive, reply with the TypeScript version and the build marker.";
const FOLLOW_UP = "Summarize your previous answer in one sentence, keeping the citation.";
const MARKER = "KWS_MARKER_7731";

function responsesSummary(response: Json, headers?: Headers): Row {
  const output = (response.output as Json[] | undefined) ?? [];
  const calls = output.filter((item) => item.type === "web_search_call");
  const messages = output.filter((item) => item.type === "message");
  const parts = messages.flatMap((item) => (item.content as Json[] | undefined) ?? []);
  return {
    status: response.status,
    output_types: output.map((item) => item.type),
    search_statuses: counts(calls.map((call) => call.status)),
    sources: calls.reduce(
      (sum, call) => sum + (((call.action as Json | undefined)?.sources as unknown[]) ?? []).length,
      0,
    ),
    citations: parts.reduce((sum, part) => sum + ((part.annotations as unknown[]) ?? []).length, 0),
    cited_urls_are_sources: parts.every((part) =>
      ((part.annotations as Json[]) ?? []).every(
        (annotation) =>
          calls.some((call) =>
            (((call.action as Json | undefined)?.sources as Json[]) ?? []).some(
              (source) => source.url === annotation.url,
            ),
          ) || (calls[0]?.action as Json | undefined)?.sources === undefined,
      ),
    ),
    reasoning_tokens: output.filter(
      (item) => item.type === "reasoning" && typeof item.encrypted_content === "string",
    ).length,
    function_calls: output.filter((item) => item.type === "function_call").length,
    has_text: parts.some((part) => typeof part.text === "string" && part.text.length > 0),
    marker_seen: parts.some((part) => String(part.text ?? "").includes(MARKER)),
    transport: headers?.get("x-kiro-transport") ?? null,
    model_replay_mode: headers?.get("x-kiro-reasoning-model-replay-mode") ?? null,
  };
}

function messagesSummary(body: Json, headers?: Headers): Row {
  const content = (body.content as Json[] | undefined) ?? [];
  const results = content.filter((block) => block.type === "web_search_tool_result");
  return {
    stop_reason: body.stop_reason,
    block_types: content.map((block) => block.type),
    result_entries: results.reduce(
      (sum, block) => sum + (Array.isArray(block.content) ? block.content.length : 0),
      0,
    ),
    result_errors: results
      .filter((block) => !Array.isArray(block.content))
      .map((block) => (block.content as Json).error_code),
    citations: content.reduce(
      (sum, block) => sum + (Array.isArray(block.citations) ? block.citations.length : 0),
      0,
    ),
    sealed_entries: results.every(
      (block) =>
        !Array.isArray(block.content) ||
        block.content.every((entry: Json) => String(entry.encrypted_content).startsWith("kws1_")),
    ),
    thinking_tokens: content.filter(
      (block) => block.type === "thinking" && /^kr[0-9]_/.test(String(block.signature)),
    ).length,
    web_search_requests: ((body.usage as Json | undefined)?.server_tool_use as Json | undefined)
      ?.web_search_requests,
    marker_seen: content.some((block) => String(block.text ?? "").includes(MARKER)),
    model_replay_mode: headers?.get("x-kiro-reasoning-model-replay-mode") ?? null,
  };
}

async function main(): Promise<void> {
  const base = new URL(option("--base-url") ?? "http://invalid");
  assert(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port !== "" &&
      base.port !== "8787",
    "isolated_gateway_required",
  );
  const configPath = option("--provider-config");
  const out = option("--out");
  const statePath = option("--state");
  const phase = option("--phase");
  assert(configPath && outside(out) && outside(statePath), "external_paths_required");
  assert(phase === "first" || phase === "resume", "phase_required");
  const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  assert(config.port !== 8787 && config.web_search_enabled, "isolated_web_search_config_required");
  const apiKey = config.api_keys[0];
  assert(typeof apiKey === "string", "probe_key_required");
  const models = (option("--models") ?? "gpt-5.6-sol,claude-opus-5-5").split(",");
  const openai = new OpenAI({
    baseURL: `${base.origin}/v1`,
    apiKey,
    maxRetries: 0,
    timeout: 600_000,
  });
  const rows: Row[] = [];
  const record = (row: Row) => {
    rows.push(row);
    process.stderr.write(`${JSON.stringify({ case: row.case, ok: row.ok })}\n`);
  };

  const messages = async (
    body: Json,
    model: string,
  ): Promise<{ status: number; body: Json; headers: Headers; events?: Json[] }> => {
    // Bounded like the gateway's own request deadline; Bun's implicit fetch
    // timeout would otherwise give up on a slow non-stream answer first. A
    // transport failure is recorded as status 0 instead of ending the run.
    const response = await fetch(`${base.origin}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(model.startsWith("gpt-") ? { "x-kiro-output-token-limit-mode": "advisory" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(900_000),
      timeout: false,
    } as RequestInit).catch(() => undefined);
    if (response === undefined) return { status: 0, body: {}, headers: new Headers() };
    if (body.stream !== true || !response.ok) {
      const text = await response.text().catch(() => "");
      let parsed: Json = {};
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed, headers: response.headers };
    }
    const events = (await response.text().catch(() => ""))
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Json);
    // Accumulate exactly as an SDK would.
    const blocks: Json[] = [];
    const json = new Map<number, string>();
    let stop: unknown;
    let usage: unknown;
    for (const event of events) {
      if (event.type === "content_block_start")
        blocks[Number(event.index)] = { ...(event.content_block as Json) };
      if (event.type === "content_block_delta") {
        const block = blocks[Number(event.index)] as Json;
        const delta = event.delta as Json;
        if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
        if (delta.type === "thinking_delta")
          block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
        if (delta.type === "signature_delta") block.signature = delta.signature;
        if (delta.type === "citations_delta")
          block.citations = [...((block.citations as unknown[]) ?? []), delta.citation];
        if (delta.type === "input_json_delta")
          json.set(
            Number(event.index),
            `${json.get(Number(event.index)) ?? ""}${delta.partial_json}`,
          );
      }
      if (event.type === "content_block_stop" && json.has(Number(event.index))) {
        (blocks[Number(event.index)] as Json).input = JSON.parse(
          json.get(Number(event.index)) as string,
        );
      }
      if (event.type === "message_delta") {
        stop = (event.delta as Json).stop_reason;
        usage = event.usage;
      }
    }
    return {
      status: response.status,
      body: { content: blocks, stop_reason: stop, usage },
      headers: response.headers,
      events,
    };
  };

  const messagesBody = (model: string, history: Json[], extra: Json = {}) => ({
    model,
    max_tokens: 8192,
    thinking: { type: "adaptive", display: "omitted" },
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    messages: history,
    ...extra,
  });
  const buildTool = {
    name: "get_build_marker",
    description: "Return the current build marker string",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  };
  const responsesFunction = {
    type: "function" as const,
    name: "get_build_marker",
    description: "Return the current build marker string",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: false,
  };

  if (phase === "first") {
    const state: Json = { conversations: [] };
    const conversations = state.conversations as Json[];
    for (const model of models) {
      for (const stream of [false, true]) {
        const input = [{ role: "user", content: SEARCH_PROMPT }];
        const request = {
          model,
          store: false,
          input,
          tools: [{ type: "web_search" as const }],
          include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
        } as const;
        const started = Date.now();
        try {
          let response: Json;
          const events: Json[] = [];
          if (stream) {
            const streamed = await openai.responses.create({ ...request, stream: true } as never);
            for await (const event of streamed as unknown as AsyncIterable<Json>)
              events.push(event);
            response = (events.at(-1)?.response as Json) ?? {};
          } else {
            response = (await openai.responses.create(request as never)) as unknown as Json;
          }
          const summary = responsesSummary(response);
          record({
            case: `responses:${model}:search:${stream ? "stream" : "json"}`,
            ok:
              response.status === "completed" &&
              (summary.output_types as unknown[]).includes("web_search_call"),
            duration_ms: Date.now() - started,
            ...summary,
            ...(stream
              ? {
                  event_counts: counts(events.map((event) => event.type)),
                  sequence_monotonic: events.every(
                    (event, index) => event.sequence_number === index,
                  ),
                  terminals: events.filter(
                    (event) =>
                      event.type === "response.completed" || event.type === "response.failed",
                  ).length,
                }
              : {}),
          });
          conversations.push({
            protocol: "responses",
            model,
            stream,
            input,
            output: response.output,
          });
        } catch (error) {
          record({
            case: `responses:${model}:search:${stream ? "stream" : "json"}`,
            ok: false,
            error: (error as { status?: number }).status ?? "exception",
          });
        }
      }
      // Mixed hosted + function group, then the function output continuation.
      try {
        const input: Json[] = [{ role: "user", content: MIXED_PROMPT }];
        const tools = [{ type: "web_search" as const }, responsesFunction];
        const first = (await openai.responses.create({
          model,
          store: false,
          input,
          tools,
          include: ["reasoning.encrypted_content"],
        } as never)) as unknown as Json;
        const firstSummary = responsesSummary(first);
        // A client answers every function call of the group.
        const calls = ((first.output as Json[]) ?? []).filter(
          (item) => item.type === "function_call",
        );
        let continued: Row = {};
        if (calls.length > 0) {
          const next = (await openai.responses.create({
            model,
            store: false,
            tools,
            include: ["reasoning.encrypted_content"],
            input: [
              ...input,
              ...((first.output as Json[]) ?? []),
              ...calls.map((call) => ({
                type: "function_call_output",
                call_id: call.call_id,
                output: MARKER,
              })),
            ],
          } as never)) as unknown as Json;
          continued = responsesSummary(next);
        }
        record({
          case: `responses:${model}:mixed`,
          ok: first.status === "completed",
          function_calls: calls.length,
          mixed_group:
            (firstSummary.output_types as unknown[]).includes("web_search_call") &&
            calls.length > 0,
          first: firstSummary,
          continuation: continued,
        });
      } catch (error) {
        record({
          case: `responses:${model}:mixed`,
          ok: false,
          error: (error as { status?: number }).status ?? "exception",
        });
      }
      for (const stream of [false, true]) {
        const history = [{ role: "user", content: SEARCH_PROMPT }];
        const started = Date.now();
        const result = await messages(messagesBody(model, history, { stream }), model);
        const summary = messagesSummary(result.body, result.headers);
        record({
          case: `messages:${model}:search:${stream ? "stream" : "json"}`,
          ok:
            result.status === 200 &&
            (summary.block_types as unknown[]).includes("web_search_tool_result"),
          status: result.status,
          duration_ms: Date.now() - started,
          ...summary,
          ...(result.events
            ? {
                message_stops: result.events.filter((event) => event.type === "message_stop")
                  .length,
                errors: result.events.filter((event) => event.type === "error").length,
              }
            : {}),
        });
        if (result.status === 200)
          conversations.push({
            protocol: "messages",
            model,
            stream,
            history,
            content: result.body.content,
          });
      }
      // Mixed: deferred search, then the tool_result continuation.
      const mixedHistory: Json[] = [{ role: "user", content: MIXED_PROMPT }];
      const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }, buildTool];
      const first = await messages(messagesBody(model, mixedHistory, { tools }), model);
      const firstSummary = messagesSummary(first.body);
      const clientCalls = ((first.body.content as Json[]) ?? []).filter(
        (block) => block.type === "tool_use",
      );
      let continuation: Row = {};
      if (first.status === 200 && clientCalls.length > 0) {
        const next = await messages(
          messagesBody(
            model,
            [
              ...mixedHistory,
              { role: "assistant", content: first.body.content },
              {
                role: "user",
                content: clientCalls.map((call) => ({
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: MARKER,
                })),
              },
            ],
            { tools },
          ),
          model,
        );
        continuation = { status: next.status, ...messagesSummary(next.body) };
      }
      record({
        case: `messages:${model}:mixed`,
        ok: first.status === 200,
        client_calls: clientCalls.length,
        deferred:
          firstSummary.stop_reason === "tool_use" &&
          (firstSummary.block_types as unknown[]).includes("server_tool_use") &&
          !(firstSummary.block_types as unknown[]).includes("web_search_tool_result"),
        first: firstSummary,
        continuation,
        continuation_starts_with_result:
          Array.isArray(continuation.block_types) &&
          continuation.block_types[0] === "web_search_tool_result",
      });
    }
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  } else {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { conversations: Json[] };
    const aliasOf = (model: string) => `${model}-low`;
    const otherOf = (model: string) =>
      model.startsWith("gpt-") ? "claude-opus-5-5" : "gpt-5.6-sol";
    for (const conversation of state.conversations) {
      const model = String(conversation.model);
      const tag = `${conversation.protocol}:${model}:${conversation.stream ? "stream" : "json"}`;
      if (conversation.protocol === "responses") {
        const output = conversation.output as Json[];
        const codex = output.map((item) => {
          if (item.type === "web_search_call") {
            return {
              type: "web_search_call",
              id: item.id,
              status: item.status,
              action: { type: "search", query: (item.action as Json).query },
            };
          }
          if (item.type === "message") {
            return {
              type: "message",
              role: "assistant",
              content: ((item.content as Json[]) ?? []).map((part) => ({
                type: "output_text",
                text: part.text,
              })),
            };
          }
          if (item.type === "reasoning")
            return { type: "reasoning", summary: [], encrypted_content: item.encrypted_content };
          return item;
        });
        for (const [variant, items, target] of [
          ["follow-up", output, model],
          ["codex-shape", codex, model],
          ["effort-alias", output, aliasOf(model)],
          ["model-switch", output, otherOf(model)],
        ] as const) {
          try {
            const raw = await openai.responses
              .create({
                model: target,
                store: false,
                tools: [{ type: "web_search" }],
                include: ["reasoning.encrypted_content"],
                input: [
                  ...(conversation.input as Json[]),
                  ...(items as Json[]),
                  { role: "user", content: FOLLOW_UP },
                ],
              } as never)
              .withResponse();
            const summary = responsesSummary(raw.data as unknown as Json, raw.response.headers);
            record({
              case: `responses:${tag}:${variant}`,
              ok: (raw.data as unknown as Json).status === "completed",
              target_model: target,
              ...summary,
            });
          } catch (error) {
            record({
              case: `responses:${tag}:${variant}`,
              ok: false,
              target_model: target,
              error: (error as { status?: number }).status ?? "exception",
            });
          }
        }
        const tampered = structuredClone(output);
        const call = tampered.find((item) => item.type === "web_search_call");
        if (call) (call.action as Json).query = "tampered query";
        try {
          await openai.responses.create({
            model,
            store: false,
            tools: [{ type: "web_search" }],
            input: [
              ...(conversation.input as Json[]),
              ...tampered,
              { role: "user", content: FOLLOW_UP },
            ],
          } as never);
          record({ case: `responses:${tag}:tampered`, ok: false, error: "accepted" });
        } catch (error) {
          record({
            case: `responses:${tag}:tampered`,
            ok: (error as { status?: number }).status === 400,
            status: (error as { status?: number }).status,
          });
        }
      } else {
        const content = conversation.content as Json[];
        const history = conversation.history as Json[];
        for (const [variant, target] of [
          ["follow-up", model],
          ["effort-alias", aliasOf(model)],
          ["model-switch", otherOf(model)],
        ] as const) {
          const result = await messages(
            messagesBody(target, [
              ...history,
              { role: "assistant", content },
              { role: "user", content: FOLLOW_UP },
            ]),
            target,
          );
          record({
            case: `messages:${tag}:${variant}`,
            ok: result.status === 200,
            status: result.status,
            target_model: target,
            ...messagesSummary(result.body, result.headers),
          });
        }
        const tampered = structuredClone(content);
        const result = tampered.find((block) => block.type === "web_search_tool_result");
        const entries = Array.isArray(result?.content) ? (result?.content as Json[]) : [];
        if (entries[0]) entries[0].encrypted_content = `${entries[0].encrypted_content}x`;
        const rejected = await messages(
          messagesBody(model, [
            ...history,
            { role: "assistant", content: tampered },
            { role: "user", content: FOLLOW_UP },
          ]),
          model,
        );
        record({
          case: `messages:${tag}:tampered`,
          ok: entries.length === 0 || rejected.status === 400,
          status: rejected.status,
          had_entries: entries.length > 0,
        });
      }
    }
  }

  const logPath = option("--gateway-log");
  const log = logPath ? readFileSync(logPath, "utf8").split("\n") : [];
  const events = log.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Json;
      return typeof parsed.event === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const evidence = {
    schema_version: 1,
    phase,
    label: option("--label") ?? "source",
    revision: revision(),
    gateway: { port: Number(base.port) },
    models,
    rows,
    passed: rows.filter((row) => row.ok === true).length,
    failed: rows.filter((row) => row.ok !== true).map((row) => row.case),
    gateway_events: {
      web_search_call_finished: counts(
        events
          .filter((event) => event.event === "web_search_call_finished")
          .map(
            (event) =>
              `${event.protocol}:${event.outcome}${event.error_code ? `:${event.error_code}` : ""}`,
          ),
      ),
      web_search_rejected: counts(
        events.filter((event) => event.event === "web_search_rejected").map((event) => event.code),
      ),
      web_search_turn_deferred: counts(
        events
          .filter((event) => event.event === "web_search_turn_deferred")
          .map((event) => event.reason),
      ),
      responses_route_selected: counts(
        events
          .filter((event) => event.event === "responses_route_selected")
          .map((event) => `${event.transport}:${event.reason}`),
      ),
    },
  };
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(
    `${JSON.stringify({ phase, passed: evidence.passed, failed: evidence.failed })}\n`,
  );
}

await main();
