import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import {
  CANONICAL_OUTPUT_STREAM_CONTENT_TYPE,
  CANONICAL_OUTPUT_VERSION,
  type CanonicalCompletion,
} from "../src/protocol/output.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import {
  anthropicMessageResponse,
  anthropicSseAdapter,
} from "../src/server/anthropic/response-adapter.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Anthropic portable replay end-to-end", () => {
  test("emits a real kr2 signature and resolves it on the next Messages turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-anthropic-kr2-"));
    roots.push(root);
    const config = ConfigSchema.parse({
      api_keys: ["sk-test"],
      reasoning_replay_keys: [`active:${Buffer.alloc(32, 9).toString("base64url")}`],
      reasoning_replay_token_format: "portable-v2",
    });
    const database = new AccountsDatabase(join(root, "accounts.db"));
    const store = new ReasoningReplayStore(database, config);
    const outputFingerprint = assistantOutputFingerprint({ text: "answer", toolCalls: [] });
    const token = store.store(
      { text: "private", signature: "native-signature" },
      {
        tenantId: "tenant-a",
        model: "claude-sonnet-5",
        accountId: "account-a",
        conversationId: "conversation-a",
        outputFingerprint,
        protocol: "anthropic-messages",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source",
        runtimeProtocol: "kiro-runtime",
        upstreamOperation: "GenerateAssistantResponse",
      },
    );
    expect(token).toStartWith("kr2_");
    if (!token) throw new TypeError("missing portable replay token");
    const completion: CanonicalCompletion = {
      canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
      conversationId: "conversation-a",
      model: "claude-sonnet-5",
      createdAt: Date.now(),
      text: "answer",
      reasoning: {
        text: "private",
        signature: "native-signature",
        encryptedContent: token,
      },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const publicResponse = anthropicMessageResponse(completion, "claude-sonnet-5", {
      thinkingDisplay: "omitted",
    });
    const publicBody = (await publicResponse.json()) as {
      content: Array<{ type: string; thinking?: string; signature?: string; text?: string }>;
    };
    expect(publicBody.content[0]).toEqual({ type: "thinking", thinking: "", signature: token });

    const adapted = adaptAnthropicMessagesRequest(
      {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        thinking: { type: "adaptive", display: "omitted" },
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: publicBody.content },
          { role: "user", content: "next" },
        ],
      },
      {},
      "v3-auto",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new TypeError(adapted.message);
    const replay = adapted.value.body.reasoningReplays[0];
    expect(replay?.lookup).toEqual({ kind: "anthropic-token", signature: token });
    if (!replay || replay.lookup.kind !== "anthropic-token") throw new TypeError("missing replay");
    expect(
      store.resolveResponses(
        replay.lookup.signature,
        {
          tenantId: "tenant-a",
          model: "claude-sonnet-5",
          outputFingerprint: replay.outputFingerprint,
        },
        replay.insertBeforeMessage,
      ),
    ).toMatchObject({
      portable: true,
      replay: {
        content: { kind: "reasoning_text", text: "private", signature: "native-signature" },
      },
    });
    database.close();
  });

  test("replays a tool turn after Messages normalizes JSON argument whitespace", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-anthropic-kr2-tool-"));
    roots.push(root);
    const config = ConfigSchema.parse({
      api_keys: ["sk-test"],
      reasoning_replay_keys: [`active:${Buffer.alloc(32, 8).toString("base64url")}`],
      reasoning_replay_token_format: "portable-v2",
    });
    const database = new AccountsDatabase(join(root, "accounts.db"));
    const store = new ReasoningReplayStore(database, config);
    const toolCalls = [{ id: "tool-id", name: "emit_marker", input: '{ "marker" : "M" }' }];
    const outputFingerprint = assistantOutputFingerprint({ text: "", toolCalls });
    const token = store.store(
      { text: "", signature: "native-signature" },
      {
        tenantId: "tenant-a",
        model: "claude-sonnet-5",
        accountId: "account-a",
        conversationId: "conversation-a",
        outputFingerprint,
        protocol: "anthropic-messages",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source",
        runtimeProtocol: "kiro-runtime",
        upstreamOperation: "GenerateAssistantResponse",
      },
    );
    if (!token) throw new TypeError("missing portable replay token");
    const publicResponse = anthropicMessageResponse(
      {
        canonicalOutputVersion: CANONICAL_OUTPUT_VERSION,
        conversationId: "conversation-a",
        model: "claude-sonnet-5",
        createdAt: Date.now(),
        text: "",
        reasoning: { text: "", signature: "native-signature", encryptedContent: token },
        toolCalls,
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      "claude-sonnet-5",
      { thinkingDisplay: "omitted" },
    );
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as {
      content: Array<Record<string, unknown>>;
    };
    const adapted = adaptAnthropicMessagesRequest(
      {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        thinking: { type: "adaptive", display: "omitted" },
        tools: [
          {
            name: "emit_marker",
            description: "Return a marker",
            input_schema: { type: "object" },
          },
        ],
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: publicBody.content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-id", content: "M" }],
          },
        ],
      },
      {},
      "v3-auto",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new TypeError(adapted.message);
    const replay = adapted.value.body.reasoningReplays[0];
    if (!replay || replay.lookup.kind !== "anthropic-token") throw new TypeError("missing replay");
    expect(replay.outputFingerprint).toBe(outputFingerprint);
    expect(
      store.resolveResponses(
        replay.lookup.signature,
        {
          tenantId: "tenant-a",
          model: "claude-sonnet-5",
          outputFingerprint: replay.outputFingerprint,
        },
        replay.insertBeforeMessage,
      ),
    ).toMatchObject({
      replay: {
        content: { kind: "reasoning_text", text: "", signature: "native-signature" },
      },
    });
    database.close();
  });

  test("streams a real kr2 signature and resolves it on the next Messages turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-anthropic-kr2-sse-"));
    roots.push(root);
    const config = ConfigSchema.parse({
      api_keys: ["sk-test"],
      reasoning_replay_keys: [`active:${Buffer.alloc(32, 7).toString("base64url")}`],
      reasoning_replay_token_format: "portable-v2",
    });
    const database = new AccountsDatabase(join(root, "accounts.db"));
    const store = new ReasoningReplayStore(database, config);
    const outputFingerprint = assistantOutputFingerprint({ text: "answer", toolCalls: [] });
    const token = store.store(
      { text: "private", signature: "native-signature" },
      {
        tenantId: "tenant-a",
        model: "claude-sonnet-5",
        accountId: "account-a",
        conversationId: "conversation-a",
        outputFingerprint,
        protocol: "anthropic-messages",
        region: "us-east-1",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source",
        runtimeProtocol: "kiro-runtime",
        upstreamOperation: "GenerateAssistantResponse",
      },
    );
    if (!token) throw new TypeError("missing portable replay token");

    const canonical = (event: Readonly<Record<string, unknown>>): string =>
      JSON.stringify({ canonicalOutputVersion: CANONICAL_OUTPUT_VERSION, ...event });
    const upstream = new Response(
      `${[
        canonical({
          type: "started",
          conversationId: "conversation-a",
          model: "claude-sonnet-5",
          createdAt: Date.now(),
        }),
        canonical({ type: "reasoning_delta", text: "private" }),
        canonical({ type: "reasoning_signature", signature: "native-signature" }),
        canonical({ type: "text_delta", text: "answer" }),
        canonical({ type: "reasoning_encrypted", encryptedContent: token }),
        canonical({
          type: "completed",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      ].join("\n")}\n`,
      { headers: { "Content-Type": CANONICAL_OUTPUT_STREAM_CONTENT_TYPE } },
    );
    const response = anthropicSseAdapter(upstream, {
      model: "claude-sonnet-5",
      inputTokens: 1,
      thinkingDisplay: "omitted",
      signals: {
        combined: new AbortController().signal,
        deadline: new AbortController().signal,
        client: new AbortController().signal,
      },
      finalize: () => undefined,
    });
    const frames = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
    const signatureDelta = frames.find(
      (frame) =>
        frame.type === "content_block_delta" &&
        typeof frame.delta === "object" &&
        frame.delta !== null &&
        "type" in frame.delta &&
        frame.delta.type === "signature_delta",
    );
    expect(signatureDelta).toMatchObject({ delta: { signature: token } });
    expect(JSON.stringify(frames)).not.toContain("private");
    expect(JSON.stringify(frames)).not.toContain("native-signature");

    const adapted = adaptAnthropicMessagesRequest(
      {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        thinking: { type: "adaptive", display: "omitted" },
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: token },
              { type: "text", text: "answer" },
            ],
          },
          { role: "user", content: "next" },
        ],
      },
      {},
      "v3-auto",
    );
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new TypeError(adapted.message);
    const replay = adapted.value.body.reasoningReplays[0];
    if (!replay || replay.lookup.kind !== "anthropic-token") throw new TypeError("missing replay");
    expect(
      store.resolveResponses(
        replay.lookup.signature,
        {
          tenantId: "tenant-a",
          model: "claude-sonnet-5",
          outputFingerprint: replay.outputFingerprint,
        },
        replay.insertBeforeMessage,
      ),
    ).toMatchObject({
      portable: true,
      replay: {
        content: { kind: "reasoning_text", text: "private", signature: "native-signature" },
      },
    });
    database.close();
  });
});
