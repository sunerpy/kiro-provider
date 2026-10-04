/** Live full-history SDK matrix. Requires an isolated gateway and emits counts/verdicts only. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import OpenAI from "openai";
import type { ResponseInput, Response as SDKResponse } from "openai/resources/responses/responses";
import { mintV3ReplayFixture } from "../__tests__/legacy-replay-token-helpers.js";
import { ConfigSchema } from "../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../src/reasoning/keyring.js";
import { decodePortableReplayToken } from "../src/reasoning/replay-token.js";
import { checkApiKey } from "../src/server/auth-gate.js";
import { parseResponsesRequest } from "../src/server/request-schema.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
async function main() {
  const base = new URL(option("--base-url") ?? "http://invalid");
  assert(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port &&
      base.port !== "8787" &&
      base.pathname === "/",
    "isolated_gateway_required",
  );
  const configPath = option("--provider-config");
  const out = option("--out");
  assert(
    configPath && out && !resolve(out).startsWith(`${resolve(import.meta.dir, "..")}/`),
    "isolated_config_and_external_evidence_required",
  );
  const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const apiKey = config.api_keys[0];
  assert(typeof apiKey === "string", "probe_key_required");
  const client = new OpenAI({
    baseURL: `${base.origin}/v1`,
    apiKey,
    maxRetries: 0,
    timeout: 120_000,
  });
  const rows: Array<Record<string, unknown>> = [];
  const keyring = loadReasoningReplayKeyring(config);
  const tenant = checkApiKey(
    new Request(base.toString(), { headers: { authorization: `Bearer ${apiKey}` } }),
    config.api_keys,
  );
  assert(tenant.ok, "probe_tenant_missing");
  const tools: OpenAI.Responses.Tool[] = [
    {
      type: "function",
      name: "probe_marker",
      description: "Return the supplied fixture marker",
      parameters: {
        type: "object",
        properties: { marker: { type: "string", const: "SOURCE_INPUT_ONLY" } },
        required: ["marker"],
        additionalProperties: false,
      },
      strict: false,
    },
  ];
  const input: ResponseInput = [
    {
      role: "user",
      content:
        (option("--seed") === "simple"
          ? "Compute 143 times 157 and verify the arithmetic internally, then call probe_marker exactly once. When the tool result arrives, reply only with the returned marker. Do not call any other tool."
          : "Find the smallest positive integer n with remainders 5 mod 17, 7 mod 19, 11 mod 23, and 13 mod 29. Verify all four remainders carefully in your reasoning, then call probe_marker exactly once. When the tool result arrives, reply only with the returned marker. Do not call any other tool.") +
        ' Call with exactly {"marker":"SOURCE_INPUT_ONLY"} and no other arguments.',
    },
  ];
  async function generate(
    model: string,
    effort: "max" | "low",
    stream: boolean,
    history: ResponseInput,
  ) {
    const { data, response } = await client.responses
      .create({
        model,
        store: false,
        stream,
        reasoning: { effort },
        include: ["reasoning.encrypted_content"],
        tools,
        input: history,
      })
      .withResponse();
    let completed: SDKResponse | undefined;
    if (stream) {
      let sequence = -1;
      let terminal = 0;
      for await (const event of data as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>) {
        assert(event.sequence_number === sequence + 1, "invalid_sse_sequence");
        sequence = event.sequence_number;
        assert(event.type !== "error" && event.type !== "response.failed", "stream_failed");
        if (event.type === "response.completed") {
          terminal += 1;
          completed = event.response;
        }
      }
      assert(terminal === 1, "missing_or_duplicate_terminal");
    } else completed = data as SDKResponse;
    assert(completed, "missing_response");
    return {
      output: completed.output,
      compatibility: response.headers.get("x-kiro-reasoning-model-replay-mode"),
    };
  }
  for (const stream of [false, true]) {
    if (option("--stream") !== undefined && option("--stream") !== String(stream)) continue;
    for (const source of ["claude-opus-5-5", "claude-opus-5-5-max", "gpt-5.6-sol"]) {
      if (option("--source") !== undefined && option("--source") !== source) continue;
      const first = await generate(source, "max", stream, input);
      const calls = first.output.filter((item) => item.type === "function_call");
      assert(calls.length === 1 && calls[0]?.name === "probe_marker", "initial_tool_call_missing");
      const reasoning = first.output.filter(
        (item) => item.type === "reasoning" && item.encrypted_content?.startsWith("kr2_"),
      );
      assert(reasoning.length > 0, "initial_encrypted_reasoning_missing");
      const replay = [
        ...input,
        ...(first.output as ResponseInput),
        {
          type: "function_call_output" as const,
          call_id: calls[0].call_id,
          output: "MODEL_SWITCH_TOOL_OK",
        },
      ];
      const targets =
        source === "gpt-5.6-sol"
          ? ["claude-opus-5-5"]
          : ["claude-opus-5-5", "claude-opus-5-5-low", "claude-opus-5", "claude-fable-5-1"];
      const parsed = parseResponsesRequest({
        model: source,
        store: false,
        stream: false,
        tools,
        input: replay,
        include: ["reasoning.encrypted_content"],
      });
      assert(parsed.ok, "legacy_context_projection_failed");
      const adapted = adaptResponsesRequest(parsed.value, "legacy-user-prefix");
      assert(adapted.ok, "legacy_context_projection_failed");
      const oldReplay = structuredClone(replay);
      for (const [index, item] of oldReplay.entries()) {
        if (item.type !== "reasoning" || !item.encrypted_content) continue;
        const context = adapted.body.reasoningReplays.find(
          (entry) =>
            entry.lookup.kind === "responses-token" &&
            entry.lookup.encryptedContent === item.encrypted_content,
        );
        assert(context, "legacy_context_projection_failed");
        const decoded = decodePortableReplayToken(
          item.encrypted_content,
          {
            tenantId: tenant.tenantId,
            model: source,
            outputFingerprint: context.outputFingerprint,
          },
          keyring,
        );
        assert(!decoded.legacy, "legacy_context_projection_failed");
        const capture =
          decoded.content.kind === "reasoning_text"
            ? { text: decoded.content.text, signature: decoded.content.signature }
            : { text: "", redactedContent: decoded.content.bytes };
        oldReplay[index] = {
          ...item,
          encrypted_content: mintV3ReplayFixture(
            capture,
            {
              tenantId: tenant.tenantId,
              model: source,
              outputFingerprint: context.outputFingerprint,
              accountId: decoded.accountId,
              conversationId: decoded.conversationId,
              ...decoded.provenance,
            },
            keyring.active.key,
            Date.now(),
            false,
            keyring.active.id,
          ),
        };
      }
      for (const target of targets)
        if (option("--target") === undefined || option("--target") === target)
          for (const version of [4, 3]) {
            const second = await generate(
              target,
              "low",
              stream,
              version === 4 ? replay : oldReplay,
            );
            const text = second.output
              .flatMap((item) =>
                item.type === "message"
                  ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))
                  : [],
              )
              .join("")
              .trim();
            const omitted = source === "gpt-5.6-sol" || !target.startsWith("claude-opus-5-5");
            const row = {
              source,
              token_version: version,
              target,
              stream,
              effort: "low",
              encrypted_reasoning_count: reasoning.length,
              tool_count: calls.length,
              marker_preserved: text === "MODEL_SWITCH_TOOL_OK",
              compatibility: second.compatibility,
              pass:
                text === "MODEL_SWITCH_TOOL_OK" &&
                second.compatibility === (omitted ? "incompatible-omitted" : null),
            };
            rows.push(row);
            writeFileSync(
              out,
              JSON.stringify({ schema_version: 1, gateway_port: base.port, rows }, null, 2),
            );
            assert(row.pass, "model_switch_semantic_failure");
            process.stdout.write(`${JSON.stringify(row)}\n`);
          }
    }
  }
  assert(rows.length > 0, "invalid_probe_selection");
}
void main().catch((error) => {
  const allowed = new Set([
    "isolated_gateway_required",
    "isolated_config_and_external_evidence_required",
    "probe_key_required",
    "probe_tenant_missing",
    "invalid_sse_sequence",
    "stream_failed",
    "missing_or_duplicate_terminal",
    "missing_response",
    "initial_tool_call_missing",
    "initial_encrypted_reasoning_missing",
    "legacy_context_projection_failed",
    "model_switch_semantic_failure",
    "invalid_probe_selection",
  ]);
  process.stderr.write(
    `${JSON.stringify({
      pass: false,
      code:
        error instanceof OpenAI.APIError
          ? "upstream_request_failed"
          : error instanceof Error && allowed.has(error.message)
            ? error.message
            : "probe_failed",
      ...(error instanceof OpenAI.APIError ? { status: error.status ?? null } : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
