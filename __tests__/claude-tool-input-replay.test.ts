import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.js";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { claudeReplayRepairCandidates } from "../src/protocol/claude-replay-repair.js";
import { workingDirectoryHash } from "../src/protocol/client-normalization.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import {
  MESSAGES_FIXTURE_KEY,
  messagesFixture,
  messagesSseEvents,
} from "./messages-regression-helpers.js";

const declaredDirectory = "/fixture/original";
const executionDirectory = "/fixture/current";
const keyB = "fixture-other-tenant";
const signature = "fixture-upstream-signature";
const originalCommand = `cd ${executionDirectory} && printf fixture`;
const edit = { file_path: "/fixture/current/file.txt", old_string: "OLD", new_string: "NEW" };
const tools = [
  {
    name: "Bash",
    description: "Execute a synthetic command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description: "Edit a synthetic file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
];
const databases: AccountsDatabase[] = [];
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => {
  audit.restore();
  for (const d of databases.splice(0)) d.close();
});

function blocks(wire: string, stream: boolean): Array<Record<string, unknown>> {
  if (!stream) return JSON.parse(wire).content;
  const content: Array<Record<string, unknown>> = [];
  for (const event of messagesSseEvents(wire)) {
    const index = event.index as number;
    if (event.type === "content_block_start")
      content[index] = { ...(event.content_block as Record<string, unknown>) };
    if (event.type !== "content_block_delta") continue;
    const block = content[index],
      delta = event.delta as Record<string, unknown>;
    if (!block) throw new Error("Delta before block");
    if (delta.type === "signature_delta")
      block.signature = `${block.signature ?? ""}${delta.signature}`;
    if (delta.type === "thinking_delta")
      block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
    if (delta.type === "input_json_delta")
      block.arguments = `${block.arguments ?? ""}${delta.partial_json}`;
  }
  for (const block of content)
    if (block.type === "tool_use") {
      block.input = JSON.parse(String(block.arguments));
      delete block.arguments;
    }
  return content;
}

async function roundTrip(
  shape: "bash" | "edit",
  stream: boolean,
  alteration?:
    | "argument"
    | "id"
    | "tenant"
    | "directory"
    | "hint"
    | "missing-context"
    | "no-provenance",
) {
  const config = ConfigSchema.parse({
    api_keys: [MESSAGES_FIXTURE_KEY, keyB],
    anthropic_thinking_display_mode: "omitted",
    reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 19).toString("base64url")}`],
  });
  const database = new AccountsDatabase(":memory:");
  databases.push(database);
  const store = new ReasoningReplayStore(database, config);
  const originalInputs =
    shape === "bash"
      ? [{ command: originalCommand, description: "Synthetic directory check." }]
      : [
          edit,
          { ...edit, file_path: "/fixture/current/second.txt" },
          { ...edit, file_path: "/fixture/current/third.txt" },
        ];
  const f = messagesFixture([], {
    config: { ...config },
    dependencies: { reasoningReplayStore: store, affinityStore: database },
    stream: (): AsyncIterable<SdkStreamEvent> =>
      (async function* () {
        try {
          if (f.inputs.length === 1) {
            yield { reasoningContentEvent: { text: "", signature } };
            for (const [index, input] of originalInputs.entries())
              yield {
                toolUseEvent: {
                  toolUseId: `fixture-call-${index}`,
                  name: shape === "bash" ? "Bash" : "Edit",
                  input: JSON.stringify(input),
                  stop: true,
                },
              };
          } else yield { assistantResponseEvent: { content: "REPLAY_RESTORED" } };
          yield {
            metadataEvent: { tokenUsage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } },
          };
        } finally {
          f.state.iteratorClosed++;
        }
      })(),
  });
  const send = (messages: unknown[], next = false) =>
    f.app(
      new Request("http://fixture/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kiro-output-token-limit-mode": "advisory",
          "x-api-key": next && alteration === "tenant" ? keyB : MESSAGES_FIXTURE_KEY,
          ...((next && alteration === "missing-context") ||
          (!next && alteration === "no-provenance")
            ? {}
            : {
                "x-kiro-client-normalization": "claude-code-bash-v1",
                "x-kiro-working-directory-hash": workingDirectoryHash(
                  next && alteration === "directory" ? "/fixture/other" : declaredDirectory,
                ),
              }),
        },
        body: JSON.stringify({
          model: "claude-opus-5-5",
          stream,
          max_tokens: 4096,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "max" },
          system: `Primary working directory: ${next && alteration === "hint" ? "/fixture/wrong" : executionDirectory}`,
          tools: next ? [] : tools,
          messages,
        }),
      }),
    );
  const initial = [{ role: "user", content: "Run the synthetic tools." }];
  const first = await send(initial);
  if (first.status !== 200)
    throw new Error(`Synthetic initial request failed: ${await first.text()}`);
  expect(first.status).toBe(200);
  const content = blocks(await first.text(), stream);
  const calls = content.filter((b) => b.type === "tool_use");
  expect(calls).toHaveLength(originalInputs.length);
  for (const call of calls) {
    const input = call.input as Record<string, unknown>;
    if (shape === "bash") input.command = "printf fixture";
    else input.replace_all = false;
    if (alteration === "argument") {
      if (shape === "bash") input.command = "printf changed";
      else input.new_string = "DIFFERENT";
    }
    if (alteration === "id") call.id = `different-${call.id}`;
  }
  const second = await send(
    [
      ...initial,
      { role: "assistant", content },
      {
        role: "user",
        content: calls.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: "Synthetic result.",
        })),
      },
    ],
    true,
  );
  const wire = await second.text();
  return { second, wire, f, originalInputs };
}

describe("Authenticated Claude tool input replay repairs", () => {
  test("bounds candidate work including oversized IDs and escaped prefixes", () => {
    const context = {
      kind: "claude-code-bash-v1" as const,
      workingDirectoryHash: workingDirectoryHash(declaredDirectory),
    };
    const huge = {
      text: "",
      toolCalls: [
        {
          id: "x".repeat((8 << 20) + 1),
          name: "Edit",
          input: JSON.stringify({ ...edit, replace_all: false }),
        },
      ],
    };
    expect(claudeReplayRepairCandidates(huge, context, [])).toEqual([]);
    const malformed = { text: "", toolCalls: [{ id: "fixture", name: "Bash", input: "{" }] };
    expect(claudeReplayRepairCandidates(malformed, context, [])).toEqual([]);
    const output = {
      text: "",
      toolCalls: [
        { id: "fixture", name: "Bash", input: JSON.stringify({ command: "printf fixture" }) },
      ],
    };
    const directories = ["/one", "/two", "/three", "/four", "/five"];
    const messages = [
      {
        role: "system" as const,
        path: "system",
        toolCalls: [],
        content: [
          {
            type: "text" as const,
            path: "system",
            text: directories
              .map((directory) => `Primary working directory: ${directory}`)
              .join("\n"),
          },
        ],
      },
    ];
    const candidates = claudeReplayRepairCandidates(output, context, messages);
    expect(candidates.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(candidates)).not.toContain("/five");
    expect(
      claudeReplayRepairCandidates(output, context, [
        {
          role: "system",
          path: "system",
          toolCalls: [],
          content: [
            {
              type: "text",
              path: "system",
              text: `Primary working directory: /${"x".repeat(4097)}`,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });
  for (const stream of [false, true])
    for (const shape of ["bash", "edit"] as const) {
      test(`restores the fully authenticated original output (${shape}/${stream})`, async () => {
        const { second, wire, f, originalInputs } = await roundTrip(shape, stream);
        expect(second.status).toBe(200);
        expect(wire).toContain("REPLAY_RESTORED");
        expect(wire).not.toContain("event: error");
        expect(f.inputs).toHaveLength(2);
        expect(f.state.iteratorClosed).toBe(2);
        const previous = f.inputs[1]?.conversationState?.history
          ?.filter((message) => message.assistantResponseMessage)
          .at(-1)?.assistantResponseMessage;
        expect(previous?.reasoningContent).toEqual({ reasoningText: { text: "", signature } });
        expect(previous?.toolUses?.map((call) => call.input)).toEqual(originalInputs);
        expect(audit.events("reasoning_replay_client_shape_restored")).toHaveLength(1);
        for (const value of [originalCommand, signature, "file.txt", "Synthetic directory check."])
          expect(JSON.stringify(audit.events())).not.toContain(value);
      });
    }
  for (const shape of ["bash", "edit"] as const)
    for (const alteration of [
      "argument",
      "id",
      "tenant",
      "directory",
      "missing-context",
      "no-provenance",
    ] as const) {
      test(`rejects changed ${alteration} (${shape}) before another dispatch`, async () => {
        const { second, f } = await roundTrip(shape, false, alteration);
        expect(second.status).toBe(400);
        expect(f.inputs).toHaveLength(1);
        expect(audit.events("reasoning_replay_client_shape_restored")).toHaveLength(0);
      });
    }
  test("does not invent a directory when its hint cannot authenticate", async () => {
    const { second, f } = await roundTrip("bash", false, "hint");
    expect(second.status).toBe(400);
    expect(f.inputs).toHaveLength(1);
  });
});
