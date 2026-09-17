import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { createApp } from "../src/server/app.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const cwd = "/fixture/project";
const cwdHash = (value: string): string =>
  createHash("sha256").update("kiro-provider-working-directory-v1\0").update(value).digest("hex");
const command = `cd ${cwd} && printf fixture`;
const tools = [
  {
    name: "Bash",
    description: "Run a fixture command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

async function roundTrip(
  options: {
    normalized?: boolean;
    nextCwd?: string;
    nextCommand?: string;
    nextTenant?: string;
    initialCommand?: string;
    changeId?: boolean;
    format?: "portable-v2" | "database-v1";
  } = {},
) {
  const audit = captureAuditEvents();
  const f = fidelityFixture({
    config: {
      api_keys: ["fixture-tenant-a", "fixture-tenant-b"],
      reasoning_replay_token_format: options.format ?? "portable-v2",
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 2).toString("base64url")}`],
    },
  });
  let dispatches = 0;
  for (const account of f.accounts)
    account.profileArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture";
  const app = createApp(f.config, {
    accountManager: f.dependencies.accountManager,
    tokenRefresher: f.dependencies.tokenRefresher,
    affinityStore: f.database,
    reasoningReplayStore: new ReasoningReplayStore(f.database, f.config),
    makeClient: () => ({
      async send() {
        const first = ++dispatches === 1;
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator](): AsyncGenerator<SdkStreamEvent> {
              if (first) {
                yield { reasoningContentEvent: { signature: "synthetic-signed-reasoning" } };
                yield {
                  toolUseEvent: {
                    toolUseId: "fixture-call",
                    name: "Bash",
                    stop: true,
                    input: JSON.stringify({ command: options.initialCommand ?? command }),
                  },
                };
              } else yield { assistantResponseEvent: { content: "REPLAY_OK" } };
              yield {
                metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
              };
            },
          },
        };
      },
    }),
  });
  const send = (messages: unknown[], next = false) =>
    app(
      new Request("http://fixture/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${next ? (options.nextTenant ?? "fixture-tenant-a") : "fixture-tenant-a"}`,
          "x-claude-code-session-id": "fixture-session",
          ...(options.normalized
            ? {
                "x-kiro-client-normalization": "claude-code-bash-v1",
                "x-kiro-working-directory-hash": cwdHash(next ? (options.nextCwd ?? cwd) : cwd),
              }
            : {}),
        },
        body: JSON.stringify({
          model: "claude-fable-5-1",
          max_tokens: 1024,
          stream: false,
          thinking: { type: "adaptive", display: "omitted" },
          tools,
          messages,
        }),
      }),
    );
  try {
    const initial = [{ role: "user", content: "Run the fixture command." }];
    const first = await send(initial);
    expect(first.status).toBe(200);
    const result = (await first.json()) as { content: Array<Record<string, unknown>> };
    expect(result.content.find((block) => block.type === "thinking")?.signature).toStartWith(
      options.format === "database-v1" ? "kr1_" : "kr2_",
    );
    const tool = result.content.find((block) => block.type === "tool_use");
    if (!tool) throw new Error("Missing fixture tool call");
    tool.input = { command: options.nextCommand ?? "printf fixture" };
    if (options.changeId) tool.id = "another-call";
    const second = await send(
      [
        ...initial,
        { role: "assistant", content: result.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: tool.id, content: "fixture" }],
        },
      ],
      true,
    );
    return { status: second.status, text: await second.text(), dispatches };
  } finally {
    f.database.close();
    audit.restore();
  }
}

describe("Claude Bash history normalization with authenticated working-directory context", () => {
  test("rejects invalid or incomplete normalization headers before dispatch", async () => {
    const audit = captureAuditEvents();
    const f = fidelityFixture();
    let dispatches = 0;
    const app = createApp(f.config, {
      accountManager: f.dependencies.accountManager,
      tokenRefresher: f.dependencies.tokenRefresher,
      makeClient: () => ({
        send: async () => {
          dispatches++;
          throw new Error("must not dispatch");
        },
      }),
    });
    try {
      const cases: Array<Record<string, string>> = [
        { "x-kiro-client-normalization": "other", "x-kiro-working-directory-hash": cwdHash(cwd) },
        { "x-kiro-client-normalization": "claude-code-bash-v1" },
        { "x-kiro-working-directory-hash": cwdHash(cwd) },
        {
          "x-kiro-client-normalization": "claude-code-bash-v1",
          "x-kiro-working-directory-hash": "bad",
        },
      ];
      for (const headers of cases) {
        const response = await app(
          new Request("http://fixture/v1/messages", {
            method: "POST",
            headers: {
              authorization: `Bearer ${f.config.api_keys[0]}`,
              "content-type": "application/json",
              ...headers,
            },
            body: JSON.stringify({
              model: "claude-fable-5-1",
              max_tokens: 1024,
              messages: [{ role: "user", content: "fixture" }],
            }),
          }),
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("Invalid client normalization context");
      }
      expect(dispatches).toBe(0);
    } finally {
      f.database.close();
      audit.restore();
    }
  });

  test("replays an omitted-thinking tool turn after the real client's redundant cd rewrite", async () => {
    const result = await roundTrip({ normalized: true });
    expect(result.status).toBe(200);
    expect(result.text).toContain("REPLAY_OK");
    expect(result.dispatches).toBe(2);
  });

  test("retains strict matching when the client did not opt in", async () => {
    const result = await roundTrip();
    expect(result.status).toBe(400);
    expect(result.dispatches).toBe(1);
  });
  test("retains authenticated normalization in database-backed replay", async () => {
    const result = await roundTrip({ normalized: true, format: "database-v1" });
    expect(result.status).toBe(200);
    expect(result.dispatches).toBe(2);
  });

  for (const options of [
    { nextCwd: "/different" },
    { nextCommand: "printf different" },
    { nextTenant: "fixture-tenant-b" },
    { changeId: true },
    { initialCommand: "cd /different && printf fixture" },
  ]) {
    test(`rejects a non-equivalent continuation: ${Object.keys(options)[0]}`, async () => {
      const result = await roundTrip({ normalized: true, ...options });
      expect(result.status).toBe(400);
      expect(result.dispatches).toBe(1);
    });
  }
});
