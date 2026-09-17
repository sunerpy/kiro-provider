import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { runChatCompletion } from "../src/core/pipeline.js";
import { accountQueueDepth, acquireAccountQueue } from "../src/core/pipeline-runtime.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { fidelityFixture } from "./responses-fidelity-helpers.js";

const PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/verified";
const OTHER_PROFILE = "arn:aws:codewhisperer:us-east-1:123456789012:profile/unverified";
let audit: ReturnType<typeof captureAuditEvents>;
beforeEach(() => {
  audit = captureAuditEvents();
});
afterEach(() => audit.restore());

function fixture(model: string, targetProfile = PROFILE, requireLegacyPrefix = false) {
  const f = fidelityFixture({
    config: {
      request_timeout_ms: 1000,
      stream_idle_timeout_ms: 500,
      reasoning_replay_account_failover: "verified",
      account_inference_concurrency: 1,
      reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 8).toString("base64url")}`],
    },
  });
  const [owner, target] = f.accounts;
  if (!owner || !target) throw new Error("Missing fixture accounts");
  owner.profileArn = PROFILE;
  target.profileArn = targetProfile;
  const store = new ReasoningReplayStore(f.database, f.config);
  const token = store.store(
    { text: "synthetic signed reasoning", signature: "synthetic-native-signature" },
    {
      tenantId: "fidelity-test",
      model,
      accountId: owner.id,
      conversationId: "source-conversation",
      outputFingerprint: assistantOutputFingerprint({
        text: "",
        toolCalls: [{ id: "fixture-call", name: "fixture_record", input: '{"value":19}' }],
      }),
      protocol: "anthropic-messages",
      region: "us-east-1",
      profileArn: PROFILE,
      runtimeProtocol: "kiro-runtime",
      upstreamOperation: "GenerateAssistantResponse",
    },
  );
  if (!token) throw new Error("Missing fixture replay token");
  const sent: Array<{ accountId: string; command: GenerateAssistantResponseCommand }> = [];
  const dependencies: RouteDependencies = {
    ...f.dependencies,
    reasoningReplayStore: store,
    runPipeline: runChatCompletion,
    makeClient: (_auth, _region, _effort, _endpoint, _proxy, accountId) => ({
      async send(command) {
        if (!accountId) throw new Error("Missing selected fixture account");
        sent.push({ accountId, command });
        if (
          requireLegacyPrefix &&
          command.input.conversationState?.history?.[1]?.assistantResponseMessage?.content !==
            "I will follow these instructions."
        ) {
          throw {
            name: "ValidationException",
            message: "Thinking block is bound to a different conversation prefix",
            reason: "THINKING_SIGNATURE_INVALID",
            $metadata: { httpStatusCode: 400 },
          };
        }
        return {
          generateAssistantResponseResponse: {
            async *[Symbol.asyncIterator]() {
              yield {
                reasoningContentEvent: {
                  text: "generated fixture thinking",
                  signature: "generated-fixture-signature",
                },
              };
              yield { assistantResponseEvent: { content: "RECORDED_19" } };
              yield {
                metadataEvent: {
                  tokenUsage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
                },
              };
            },
          },
        };
      },
    }),
  };
  return {
    ...f,
    owner,
    target,
    sent,
    send(
      stream: boolean,
      signal?: AbortSignal,
      tenantId = "fidelity-test",
      followup?: readonly Record<string, unknown>[],
    ) {
      return handleMessages(
        new Request("http://fixture/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "fixture-family",
            "x-claude-code-agent-id": "fixture-child",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            stream,
            thinking: { type: "adaptive", display: "omitted" },
            system: "Keep the synthetic fixture stable.",
            tools: [
              {
                name: "fixture_record",
                description: "Record a synthetic value",
                input_schema: {
                  type: "object",
                  properties: { value: { type: "integer" } },
                  required: ["value"],
                },
              },
            ],
            messages: [
              { role: "user", content: "Record 19." },
              {
                role: "assistant",
                content: [
                  ...(followup ? [] : [{ type: "thinking", thinking: "", signature: token }]),
                  {
                    type: "tool_use",
                    id: "fixture-call",
                    name: "fixture_record",
                    input: { value: 19 },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "fixture-call", content: "Recorded." },
                ],
              },
              ...(followup ?? []),
            ],
          }),
          signal,
        }),
        f.config,
        { ...dependencies, tenantId },
      );
    },
  };
}

describe("verified Fable replay shares idle capacity within the tested profile", () => {
  test("continues an authenticated pre-fix token with its original historical projection", async () => {
    const f = fixture("claude-fable-5-1", PROFILE, true);
    try {
      const response = await f.send(false);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("RECORDED_19");
      expect(f.sent).toHaveLength(1);
      const history = f.sent[0]?.command.input.conversationState?.history;
      expect(history?.[0]?.userInputMessage?.content).toBe("Keep the synthetic fixture stable.");
      expect(history?.[1]?.assistantResponseMessage?.content).toBe(
        "I will follow these instructions.",
      );
      expect(history?.[2]?.userInputMessage?.content).toBe("Record 19.");
      expect(history?.[3]?.assistantResponseMessage?.reasoningContent).toEqual({
        reasoningText: {
          text: "synthetic signed reasoning",
          signature: "synthetic-native-signature",
        },
      });
    } finally {
      f.database.close();
    }
  });

  test("carries the frozen prefix in new encrypted output after the oldest thinking is removed", async () => {
    const f = fixture("claude-fable-5-1", PROFILE, true);
    try {
      const first = await f.send(false);
      expect(first.status).toBe(200);
      const body = (await first.json()) as { content: Array<Record<string, unknown>> };
      expect(body.content.find((block) => block.type === "thinking")?.signature).toStartWith(
        "kr2_",
      );
      const second = await f.send(false, undefined, "fidelity-test", [
        { role: "assistant", content: body.content },
        { role: "user", content: "Follow up using the recorded value." },
      ]);
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("RECORDED_19");
      expect(f.sent).toHaveLength(2);
      const state = f.sent[1]?.command.input.conversationState;
      expect(state?.history?.[1]?.assistantResponseMessage?.content).toBe(
        "I will follow these instructions.",
      );
      expect(state?.history?.[3]?.assistantResponseMessage?.reasoningContent).toBeUndefined();
      expect(state?.history?.at(-1)?.assistantResponseMessage?.reasoningContent).toEqual({
        reasoningText: {
          text: "generated fixture thinking",
          signature: "generated-fixture-signature",
        },
      });
    } finally {
      f.database.close();
    }
  });

  for (const model of ["claude-fable-5-1"]) {
    for (const stream of [false, true]) {
      test(`${model} stream=${stream}: child tool replay uses a free account and preserves signed history`, async () => {
        const f = fixture(model);
        const owner = f.owner.id;
        const releaseOwner = await acquireAccountQueue(owner, new AbortController().signal);
        try {
          const response = await f.send(stream);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("RECORDED_19");
          expect(f.sent).toHaveLength(1);
          expect(f.sent[0]?.accountId).toBe(f.target.id);
          const state = f.sent[0]?.command.input.conversationState;
          if (!state) throw new Error("Missing dispatched fixture state");
          expect(state.currentMessage?.userInputMessage?.modelId).toBe("claude-fable-5.1");
          expect(state.conversationId).not.toBe("source-conversation");
          expect(
            state.history?.find((entry) => entry.assistantResponseMessage?.reasoningContent)
              ?.assistantResponseMessage?.reasoningContent,
          ).toEqual({
            reasoningText: {
              text: "synthetic signed reasoning",
              signature: "synthetic-native-signature",
            },
          });
          expect(
            state.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults,
          ).toEqual([
            {
              toolUseId: "fixture-call",
              status: "success",
              content: [{ text: "Recorded." }],
            },
          ]);
          expect(accountQueueDepth(f.target.id)).toBe(0);
        } finally {
          releaseOwner();
          f.database.close();
        }
      });
    }
  }

  test("a different profile cannot borrow the owner's signed history while it is busy", async () => {
    const f = fixture("claude-fable-5-1", OTHER_PROFILE);
    const releaseOwner = await acquireAccountQueue(f.owner.id, new AbortController().signal);
    const cancel = new AbortController();
    const pending = f.send(false, cancel.signal);
    try {
      await Bun.sleep(25);
      expect(f.sent).toHaveLength(0);
      cancel.abort();
      expect((await pending).status).toBe(499);
      expect(accountQueueDepth(f.target.id)).toBe(0);
    } finally {
      cancel.abort();
      releaseOwner();
      await pending;
      f.database.close();
    }
  });

  test("changing tenant never reaches account selection or the upstream", async () => {
    const f = fixture("claude-fable-5-1");
    try {
      const response = await f.send(false, undefined, "another-tenant");
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          message: "Reasoning replay context does not match tenant, model, or assistant output",
        },
      });
      expect(f.sent).toHaveLength(0);
      expect(f.selections).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });
});
