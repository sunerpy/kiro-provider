import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/schema.js";
import { transformToSdkRequest } from "../src/kiro/transform/request-sdk.js";
import type { InstructionReplayProjection } from "../src/protocol/canonical.js";
import { workingDirectoryHash } from "../src/protocol/client-normalization.js";
import { ReasoningReplayStore } from "../src/reasoning/replay-store.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

const model = "claude-fable-5-1";
const context = {
  tenantId: "fixture-tenant",
  model,
  accountId: "fixture-account",
  conversationId: "fixture-conversation",
  outputFingerprint: "fixture-output",
  protocol: "anthropic-messages" as const,
  region: "us-east-1",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture",
  runtimeProtocol: "kiro-runtime" as const,
  upstreamOperation: "GenerateAssistantResponse" as const,
};
const auth = {
  access: "fixture",
  refresh: "fixture",
  expires: 0,
  authMethod: "desktop" as const,
  region: "us-east-1" as const,
};

describe("authenticated instruction projection survives replay persistence", () => {
  for (const format of ["portable-v2", "database-v1"] as const) {
    test(`${format}: restart retains the authenticated client normalization context`, () => {
      const root = mkdtempSync(join(tmpdir(), "kiro-normalization-persistence-"));
      const config = ConfigSchema.parse({
        api_keys: ["fixture-key"],
        reasoning_replay_token_format: format,
        reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 8).toString("base64url")}`],
      });
      const normalization = {
        kind: "claude-code-bash-v1" as const,
        workingDirectoryHash: workingDirectoryHash("/fixture"),
      };
      let db = new AccountsDatabase(join(root, "accounts.db"));
      try {
        const before = new ReasoningReplayStore(db, config);
        const token = before.store(
          { text: "", signature: "fixture" },
          {
            ...context,
            outputFingerprint: "normalized-output",
            clientNormalization: normalization,
          },
        );
        if (!token) throw new Error("Missing fixture token");
        db.close();
        db = new AccountsDatabase(join(root, "accounts.db"));
        const after = new ReasoningReplayStore(db, config);
        const replayContext = {
          ...context,
          outputFingerprint: "raw-output",
          normalizedOutputFingerprint: "normalized-output",
          clientNormalization: normalization,
        };
        expect(after.resolveResponses(token, replayContext, 2).replay.content).toEqual({
          kind: "reasoning_text",
          text: "",
          signature: "fixture",
        });
        for (const changed of [
          { ...replayContext, tenantId: "other-tenant" },
          { ...replayContext, model: "claude-opus-5" },
          { ...replayContext, clientNormalization: undefined },
          {
            ...replayContext,
            clientNormalization: {
              ...normalization,
              workingDirectoryHash: workingDirectoryHash("/different"),
            },
          },
        ])
          expect(() => after.resolveResponses(token, changed, 2)).toThrow();
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test(`${format}: restart and oldest-thinking removal retain only the frozen historical prefix`, () => {
      const root = mkdtempSync(join(tmpdir(), "kiro-projection-persistence-"));
      const config = ConfigSchema.parse({
        api_keys: ["fixture-key"],
        reasoning_replay_token_format: format,
        reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 7).toString("base64url")}`],
      });
      let db = new AccountsDatabase(join(root, "accounts.db"));
      try {
        const before = new ReasoningReplayStore(db, config);
        const token = before.store(
          { text: "fixture reasoning", signature: "fixture-signature" },
          {
            ...context,
            instructionProjection: { version: 1, legacyPrefixMessages: 2 },
          },
        );
        if (!token) throw new Error("Missing fixture token");
        db.close();
        db = new AccountsDatabase(join(root, "accounts.db"));
        const after = new ReasoningReplayStore(db, config);
        const resolved = after.resolveResponses(token, context, 5);
        expect(resolved.replay.instructionProjection).toEqual({
          version: 1,
          legacyPrefixMessages: 2,
        });
        const body = canonicalRequest(
          [
            message("system", "LEADING"),
            message("user", "TASK"),
            message("assistant", "FIRST"),
            message("user", "RESULT"),
            message("system", "STEER"),
            message("assistant", "SECOND"),
            message("user", "FOLLOWUP"),
          ],
          { model, protocol: "anthropic-messages", projectionMode: "v3-auto" },
        );
        // Native capability may become available on the target account, but
        // authenticated old wire history must not be changed by that fact.
        const prepared = transformToSdkRequest(body, model, auth, true, 20000, {
          nativeSystemPromptEnabled: true,
          resolvedReasoningReplays: [resolved.replay],
        });
        const history = prepared.conversationState.history ?? [];
        expect(
          history.map(
            (item) => item.userInputMessage?.content ?? item.assistantResponseMessage?.content,
          ),
        ).toEqual([
          "LEADING",
          "I will follow these instructions.",
          "TASK",
          "FIRST",
          "RESULT\n\nSTEER",
          "SECOND",
        ]);
        expect(prepared.systemPrompt).toBeUndefined();
        expect(history.at(-1)?.assistantResponseMessage?.reasoningContent).toEqual({
          reasoningText: { text: "fixture reasoning", signature: "fixture-signature" },
        });
        expect(prepared.conversationState.currentMessage.userInputMessage?.content).toBe(
          "FOLLOWUP",
        );
        expect(prepared.diagnostics.projection.legacyPrefixMessages).toBe(2);
      } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    test(`${format}: modern records are not mistaken for unversioned history`, () => {
      const db = new AccountsDatabase(":memory:");
      try {
        const store = new ReasoningReplayStore(
          db,
          ConfigSchema.parse({
            api_keys: ["fixture-key"],
            reasoning_replay_token_format: format,
            reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 6).toString("base64url")}`],
          }),
        );
        const token = store.store(
          { text: "", signature: "fixture" },
          {
            ...context,
            instructionProjection: { version: 1 },
          },
        );
        if (!token) throw new Error("Missing fixture token");
        expect(store.resolveResponses(token, context, 2).replay.instructionProjection).toEqual({
          version: 1,
        });
      } finally {
        db.close();
      }
    });

    test(`${format}: invalid projection metadata cannot be written`, () => {
      const db = new AccountsDatabase(":memory:");
      try {
        const store = new ReasoningReplayStore(
          db,
          ConfigSchema.parse({
            api_keys: ["fixture-key"],
            reasoning_replay_token_format: format,
            reasoning_replay_keys: [`fixture:${Buffer.alloc(32, 5).toString("base64url")}`],
          }),
        );
        for (const value of [
          { version: 2 },
          { version: 1, legacyPrefixMessages: 0 },
          { version: 1, legacyPrefixMessages: -1 },
          { version: 1, legacyPrefixMessages: 1.5 },
        ]) {
          expect(() =>
            store.store(
              { text: "", signature: "fixture" },
              {
                ...context,
                instructionProjection: value as InstructionReplayProjection,
              },
            ),
          ).toThrow(expect.objectContaining({ code: "invalid_reasoning_replay" }));
        }
      } finally {
        db.close();
      }
    });
  }
});
