import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config/schema.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import type { CodeWhispererRequest } from "../src/kiro/types.js";
import { workingDirectoryHash } from "../src/protocol/client-normalization.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { createApp } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const model = "claude-opus-5-5";
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AQID" },
};
const normalization = {
  "x-kiro-client-normalization": "claude-code-bash-v1",
  "x-kiro-working-directory-hash": workingDirectoryHash("/fixture/project"),
};

function longHistory(): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 124; index++) {
    messages.push({ role: "user", content: "synthetic-history" });
    messages.push({ role: "assistant", content: "synthetic-answer" });
  }
  messages.push({
    role: "assistant",
    content: [0, 1].map((index) => ({
      type: "tool_use",
      id: `fixture-call-${index}`,
      name: "FixtureTool",
      input: {},
    })),
  });
  messages.push({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "fixture-call-0", content: "result-zero" },
      {
        type: "tool_result",
        tool_use_id: "fixture-call-1",
        content: [{ type: "text", text: "result-one" }],
        is_error: true,
      },
      { type: "text", text: "before\r\n" },
      { type: "text", text: "context" },
      image,
      { type: "text", text: "after" },
    ],
  });
  return messages;
}

function fixture(options: { config?: Partial<Config>; block?: boolean } = {}) {
  const audit = captureAuditEvents();
  const f = fidelityFixture({
    config: {
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 3).toString("base64url")}`],
      ...options.config,
    },
  });
  for (const account of f.accounts)
    account.profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture";
  const inputs: CodeWhispererRequest[] = [];
  let cleanups = 0;
  const app = createApp(f.config, {
    accountManager: f.dependencies.accountManager,
    tokenRefresher: f.dependencies.tokenRefresher,
    affinityStore: f.database,
    reasoningReplayStore: new ReasoningReplayStore(f.database, f.config),
    makeClient: () => ({
      async send(command, sendOptions) {
        inputs.push(command.input as CodeWhispererRequest);
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              try {
                yield { reasoningContentEvent: { signature: "fixture-signed-reasoning" } };
                yield { assistantResponseEvent: { content: "ORDER_OK" } };
                if (options.block) {
                  const signal = sendOptions?.abortSignal;
                  await new Promise<void>((_resolve, reject) => {
                    const abort = () =>
                      reject(new DOMException("Synthetic cancellation", "AbortError"));
                    if (signal?.aborted) abort();
                    else signal?.addEventListener("abort", abort, { once: true });
                  });
                }
                yield {
                  metadataEvent: {
                    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                };
              } finally {
                cleanups++;
              }
            },
          },
        };
      },
    }),
  });
  return {
    inputs,
    audit,
    get cleanups() {
      return cleanups;
    },
    send(
      messages: Array<Record<string, unknown>>,
      stream = false,
      headers: Record<string, string> = normalization,
      signal?: AbortSignal,
    ) {
      return app(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          ...(signal ? { signal } : {}),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${f.config.api_keys[0]}`,
            ...headers,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            stream,
            thinking: { type: "adaptive", display: "omitted" },
            tools: [
              {
                name: "FixtureTool",
                description: "Return a synthetic fixture result",
                input_schema: { type: "object", properties: {} },
              },
            ],
            messages,
          }),
        }),
      );
    },
    close() {
      f.database.close();
      audit.restore();
    },
  };
}

describe("Claude Code tool-result prefixes before direct image runs", () => {
  test.each([false, true])(
    "preserves the complete messages.249 request (stream=%s)",
    async (stream) => {
      const f = fixture();
      const messages = longHistory();
      const original = JSON.stringify(messages);
      try {
        const response = await f.send(messages, stream);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("ORDER_OK");
        expect(f.inputs).toHaveLength(1);
        expect(response.headers.get("x-kiro-client-normalization")).toBe("claude-code-bash-v1");
        const history = f.inputs[0]?.conversationState.history;
        expect(history).toHaveLength(252);
        expect(
          history?.[248]?.assistantResponseMessage?.toolUses?.map((call) => call.toolUseId),
        ).toEqual(["fixture-call-0", "fixture-call-1"]);
        expect(history?.slice(249)).toMatchObject([
          {
            userInputMessage: {
              content: "",
              userInputMessageContext: {
                toolResults: [
                  {
                    toolUseId: "fixture-call-0",
                    content: [{ text: "result-zero" }],
                    status: "success",
                  },
                  {
                    toolUseId: "fixture-call-1",
                    content: [{ text: "result-one" }],
                    status: "error",
                  },
                ],
              },
            },
          },
          { userInputMessage: { content: "before\r\ncontext" } },
          { userInputMessage: { content: "", images: [{ format: "png" }] } },
        ]);
        expect(f.inputs[0]?.conversationState.currentMessage.userInputMessage?.content).toBe(
          "after",
        );
        expect(JSON.stringify(messages)).toBe(original);
        expect(JSON.stringify(f.audit.events())).not.toContain("result-zero");
      } finally {
        f.close();
      }
    },
  );

  test("preserves signed continuation after the split turn becomes historical", async () => {
    const f = fixture();
    try {
      const messages = longHistory();
      const first = await f.send(messages);
      expect(first.status).toBe(200);
      const output = (await first.json()) as { content: Array<Record<string, unknown>> };
      expect(output.content.find((part) => part.type === "thinking")?.signature).toStartWith(
        "kr2_",
      );
      const next = await f.send([
        ...messages,
        { role: "assistant", content: output.content },
        { role: "user", content: "Resume the synthetic turn." },
      ]);
      expect(next.status).toBe(200);
      expect(await next.text()).toContain("ORDER_OK");
      expect(f.inputs).toHaveLength(2);
      expect(f.inputs[1]?.conversationState.history?.[253]?.assistantResponseMessage).toMatchObject(
        {
          content: "ORDER_OK",
          reasoningContent: { reasoningText: { text: "", signature: "fixture-signed-reasoning" } },
        },
      );
    } finally {
      f.close();
    }
  });

  test("preserves an intervening instruction before the tool-result segment", async () => {
    const f = fixture();
    try {
      const messages = longHistory();
      messages.splice(249, 0, { role: "system", content: "synthetic-instruction" });
      const response = await f.send(messages);
      expect(response.status).toBe(200);
      await response.text();
      expect(f.inputs[0]?.conversationState.history?.[249]?.userInputMessage).toMatchObject({
        content: "synthetic-instruction\n\n",
        userInputMessageContext: {
          toolResults: [{ toolUseId: "fixture-call-0" }, { toolUseId: "fixture-call-1" }],
        },
      });
      expect(f.inputs[0]?.conversationState.currentMessage.userInputMessage?.content).toBe("after");
    } finally {
      f.close();
    }
  });

  test.each([{}, { ...normalization, "x-kiro-working-directory-hash": "invalid" }])(
    "rejects missing or invalid normalization context before dispatch: %j",
    async (headers) => {
      const f = fixture();
      try {
        const response = await f.send(longHistory(), false, headers);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
        expect(f.inputs).toHaveLength(0);
      } finally {
        f.close();
      }
    },
  );

  test.each([15, 16])(
    "counts the tool-result prefix in the 16-run limit (suffix=%s)",
    async (count) => {
      const f = fixture();
      try {
        const messages = longHistory();
        const current = messages[249] as Record<string, unknown>;
        current.content = [
          ...(current.content as unknown[]).slice(0, 2),
          ...Array.from({ length: count }, (_, index) =>
            index % 2 === 0 ? { type: "text", text: "marker" } : image,
          ),
        ];
        const response = await f.send(messages);
        expect(response.status).toBe(count === 15 ? 200 : 400);
        await response.text();
        expect(f.inputs).toHaveLength(count === 15 ? 1 : 0);
      } finally {
        f.close();
      }
    },
  );

  test.each(["authentication", "non-leading-result", "lifted-image"])(
    "rejects %s before dispatch",
    async (kind) => {
      const f = fixture();
      try {
        const messages = longHistory();
        const content = messages[249]?.content as Array<Record<string, unknown>>;
        if (kind === "non-leading-result") content.unshift({ type: "text", text: "leading" });
        if (kind === "lifted-image") content[0] = { ...content[0], content: [image] };
        const response = await f.send(
          messages,
          false,
          kind === "authentication" ? { ...normalization, authorization: "" } : normalization,
        );
        expect(response.status).toBe(kind === "authentication" ? 401 : 400);
        await response.text();
        expect(f.inputs).toHaveLength(0);
      } finally {
        f.close();
      }
    },
  );

  test("keeps a historical cache checkpoint only on the last projected run", () => {
    const messages = longHistory();
    const content = messages[249]?.content as Array<Record<string, unknown>>;
    content[content.length - 1] = { ...content.at(-1), cache_control: { type: "ephemeral" } };
    messages.push(
      { role: "assistant", content: "historical-answer" },
      { role: "user", content: "next" },
    );
    const adapted = adaptAnthropicMessagesRequest(
      { model, max_tokens: 1024, messages },
      {},
      "v3-auto",
    );
    if (!adapted.ok) throw new Error("Invalid synthetic request");
    const prepared = transformToSdkRequest(
      adapted.value.body,
      model,
      {
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() + 3600000,
        authMethod: "desktop",
        region: "us-east-1",
      },
      false,
      20000,
      {
        splitInterleavedUserImages: true,
        promptCaching: {
          mode: "explicit-checkpoints",
          supported: true,
          minimumTokens: 1,
          maximumCheckpoints: 4,
        },
      },
    );
    const runs = prepared.conversationState.history?.slice(249, 253);
    expect(runs?.map((run) => run.userInputMessage?.cachePoint)).toEqual([
      undefined,
      undefined,
      undefined,
      { type: "default" },
    ]);
    expect(prepared.conversationState.currentMessage.userInputMessage?.cachePoint).toBeUndefined();
  });

  test("cancels a split request after streaming starts and completes upstream cleanup", async () => {
    const f = fixture({ block: true });
    const controller = new AbortController();
    try {
      const response = await f.send(longHistory(), true, normalization, controller.signal);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing synthetic stream");
      await reader.read();
      controller.abort();
      await reader.cancel();
      for (let i = 0; i < 100 && f.audit.events("request_admission_released").length === 0; i++)
        await Bun.sleep(5);
      expect(f.inputs).toHaveLength(1);
      expect(f.cleanups).toBe(1);
      expect(f.audit.events("request_admission_released")).toMatchObject([
        { active_requests: 0, reserved_body_bytes: 0 },
      ]);
    } finally {
      controller.abort();
      f.close();
    }
  });

  test("terminates an accepted split stream on timeout without retrying", async () => {
    const f = fixture({
      block: true,
      config: { request_timeout_ms: 100, stream_idle_timeout_ms: 40 },
    });
    try {
      const response = await f.send(longHistory(), true);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"error"');
      for (let i = 0; i < 100 && f.audit.events("request_admission_released").length === 0; i++)
        await Bun.sleep(5);
      expect(f.inputs).toHaveLength(1);
      expect(f.cleanups).toBe(1);
      expect(f.audit.events("request_admission_released")).toMatchObject([
        { active_requests: 0, reserved_body_bytes: 0 },
      ]);
    } finally {
      f.close();
    }
  });
});
