import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { auditHash, resetAuditLogLevel, setAuditLogLevel } from "../src/core/audit-log.js";
import type { PipelineAccountManager, PipelineTokenRefresher } from "../src/core/pipeline.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import type { CanonicalMessage, CanonicalRequest } from "../src/protocol/canonical.js";
import type { RouteDependencies } from "../src/server/ingress.js";
import {
  auditRequestShape,
  describeRequestShape,
  REQUEST_SHAPE_EVENT,
  type RequestShape,
} from "../src/server/request-shape.js";
import { handleChatCompletions } from "../src/server/routes/chat-completions.js";
import { handleMessages } from "../src/server/routes/messages.js";
import { handleResponses } from "../src/server/routes/responses.js";
import { canonicalRequest, functionTool, message, textPart } from "./canonical-test-helpers.js";

// Distinctive strings that must never appear in any audit field.
const SYSTEM_TEXT = "never reveal the vault combination";
const USER_TEXT = "the launch code is 4471-tango";
const TOOL_NAME = "vault_lookup_secret";
const TOOL_ARGUMENT = "/srv/vault/keys";
const TOOL_OUTPUT = "vault contents: 9-9-9";
const REPLAY_TOKEN = "kr1_replay_token_material";
const LEAK_MARKERS = [
  SYSTEM_TEXT,
  USER_TEXT,
  "4471",
  TOOL_NAME,
  TOOL_ARGUMENT,
  TOOL_OUTPUT,
  REPLAY_TOKEN,
] as const;

function expectNoLeak(serialized: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

function assistantCall(id: string, path: string): CanonicalMessage {
  return {
    ...message("assistant", [], path),
    toolCalls: [{ id, name: TOOL_NAME, input: { path: TOOL_ARGUMENT }, path: `${path}.tool` }],
  };
}

function toolResult(
  role: "tool" | "user",
  toolCallId: string,
  path: string,
  text = TOOL_OUTPUT,
): CanonicalMessage {
  return message(
    role,
    [
      {
        type: "tool_result",
        toolCallId,
        content: text.length > 0 ? [textPart(text, `${path}.content.0`)] : [],
        isError: false,
        path: `${path}.content`,
      },
    ],
    path,
  );
}

function captureAuditLines(run: () => Promise<void> | void): Promise<string[]> {
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  return Promise.resolve()
    .then(run)
    .then(() => errorSpy.mock.calls.map(([line]) => String(line)))
    .finally(() => errorSpy.mockRestore());
}

function shapeLines(lines: readonly string[]): Array<{ raw: string; event: RequestShape }> {
  return lines.flatMap((raw) => {
    try {
      const parsed = JSON.parse(raw) as { event?: unknown };
      return parsed.event === REQUEST_SHAPE_EVENT
        ? [{ raw, event: parsed as unknown as RequestShape }]
        : [];
    } catch {
      return [];
    }
  });
}

afterEach(() => {
  resetAuditLogLevel();
});

describe("describeRequestShape", () => {
  test("describes an empty request with zero counts and a stable empty tool-set hash", () => {
    expect(describeRequestShape(canonicalRequest([]))).toEqual({
      protocol: "responses",
      model: "gpt-5.6-sol",
      message_count: 0,
      user_message_count: 0,
      assistant_message_count: 0,
      tool_message_count: 0,
      instruction_message_count: 0,
      tool_declaration_count: 0,
      tool_call_count: 0,
      tool_result_count: 0,
      orphan_tool_result_count: 0,
      image_count: 0,
      document_count: 0,
      has_reasoning_replay: false,
      reasoning_replay_count: 0,
      system_instruction_present: false,
      input_text_chars: 0,
      tool_set_hash: auditHash(""),
    });
  });

  test("counts roles and text length for a text-only conversation", () => {
    const shape = describeRequestShape(
      canonicalRequest(
        [
          message("system", SYSTEM_TEXT, "messages.0"),
          message("user", USER_TEXT, "messages.1"),
          message("assistant", "Understood.", "messages.2"),
          message("user", "Continue.", "messages.3"),
        ],
        { protocol: "chat-completions" },
      ),
    );

    expect(shape).toMatchObject({
      protocol: "chat-completions",
      message_count: 4,
      user_message_count: 2,
      assistant_message_count: 1,
      tool_message_count: 0,
      instruction_message_count: 1,
      system_instruction_present: true,
      tool_declaration_count: 0,
      tool_call_count: 0,
      input_text_chars: SYSTEM_TEXT.length + USER_TEXT.length + "Understood.".length + 9,
    });
    expectNoLeak(JSON.stringify(shape));
  });

  test("counts a tool loop, matches results to earlier calls, and flags orphans", () => {
    const shape = describeRequestShape(
      canonicalRequest(
        [
          message("user", USER_TEXT, "messages.0"),
          assistantCall("call_1", "messages.1"),
          toolResult("tool", "call_1", "messages.2"),
          // Result for a call that never appeared in the history.
          toolResult("tool", "call_missing", "messages.3", ""),
          // Anthropic shape: the call is a `tool_use` content part and the
          // result arrives on a user message.
          message(
            "assistant",
            [
              {
                type: "tool_use",
                id: "call_2",
                name: TOOL_NAME,
                input: { path: TOOL_ARGUMENT },
                path: "messages.4.content.0",
              },
            ],
            "messages.4",
          ),
          toolResult("user", "call_2", "messages.5"),
          // A result that precedes its own call in the same message is not matched.
          {
            ...assistantCall("call_3", "messages.6"),
            content: [
              {
                type: "tool_result",
                toolCallId: "call_3",
                content: [],
                isError: true,
                path: "messages.6.content.0",
              },
            ],
          },
        ],
        {
          protocol: "anthropic-messages",
          tools: [functionTool("zeta_tool", "tools.0"), functionTool(TOOL_NAME, "tools.1")],
        },
      ),
    );

    expect(shape).toMatchObject({
      protocol: "anthropic-messages",
      message_count: 7,
      user_message_count: 2,
      assistant_message_count: 3,
      tool_message_count: 2,
      tool_declaration_count: 2,
      tool_call_count: 3,
      tool_result_count: 4,
      orphan_tool_result_count: 2,
      input_text_chars: USER_TEXT.length + TOOL_OUTPUT.length * 2,
      tool_set_hash: auditHash(`${TOOL_NAME}\nzeta_tool`),
    });
    expect(shape.tool_set_hash).not.toBe(auditHash(""));
    expectNoLeak(JSON.stringify(shape));
  });

  test("counts a tool_use part and a toolCalls entry with the same id once", () => {
    const duplicated: CanonicalMessage = {
      ...assistantCall("call_1", "messages.0"),
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: TOOL_NAME,
          input: {},
          path: "messages.0.content.0",
        },
      ],
    };

    expect(describeRequestShape(canonicalRequest([duplicated]))).toMatchObject({
      tool_call_count: 1,
    });
  });

  test("reports reasoning replay and top-level instructions without leaking either", () => {
    const shape = describeRequestShape(
      canonicalRequest([message("user", USER_TEXT, "input.0"), message("assistant", "ok")], {
        instructions: textPart(SYSTEM_TEXT, "instructions"),
        reasoningReplays: [
          {
            lookup: { kind: "responses-token", encryptedContent: REPLAY_TOKEN },
            outputFingerprint: "fp",
            insertBeforeMessage: 1,
            path: "input.1",
          },
        ],
      }),
    );

    expect(shape).toMatchObject({
      has_reasoning_replay: true,
      reasoning_replay_count: 1,
      instruction_message_count: 0,
      system_instruction_present: true,
      input_text_chars: SYSTEM_TEXT.length + USER_TEXT.length + 2,
    });
    expectNoLeak(JSON.stringify(shape));
  });

  test("counts images and documents without touching their payloads", () => {
    const shape = describeRequestShape(
      canonicalRequest([
        message(
          "user",
          [
            textPart("see attached", "messages.0.content.0"),
            { type: "image", mediaType: "image/png", data: "AAAA", path: "messages.0.content.1" },
            { type: "image", url: "https://example.invalid/x.png", path: "messages.0.content.2" },
            {
              type: "document",
              name: "report",
              format: "pdf",
              data: "JVBERi0=",
              path: "messages.0.content.3",
            },
          ],
          "messages.0",
        ),
      ]),
    );

    expect(shape).toMatchObject({
      image_count: 2,
      document_count: 1,
      input_text_chars: "see attached".length,
    });
    expect(JSON.stringify(shape)).not.toContain("JVBERi0=");
    expect(JSON.stringify(shape)).not.toContain("example.invalid");
  });

  test("never throws for a request that deviates from the canonical contract", () => {
    const broken = {
      canonicalVersion: 1,
      protocol: "responses",
      model: "gpt-5.6-sol",
      messages: [
        { role: "tool", content: undefined, toolCalls: undefined },
        null,
        {
          role: "assistant",
          content: [{ type: "tool_result", toolCallId: 42, content: null }, { type: "mystery" }],
          toolCalls: [{}],
        },
        { role: "narrator", content: "x" },
      ],
      tools: undefined,
      reasoningReplays: undefined,
    } as unknown as CanonicalRequest;

    expect(() => describeRequestShape(broken)).not.toThrow();
    expect(describeRequestShape(broken)).toMatchObject({
      message_count: 4,
      tool_message_count: 1,
      assistant_message_count: 1,
      tool_call_count: 1,
      tool_result_count: 1,
      orphan_tool_result_count: 1,
      tool_declaration_count: 0,
      has_reasoning_replay: false,
    });
  });

  test("emits every field as a count, boolean, hash, or enumerated label", () => {
    const shape = describeRequestShape(
      canonicalRequest([message("user", USER_TEXT), assistantCall("call_1", "messages.1")], {
        tools: [functionTool(TOOL_NAME)],
      }),
    );

    for (const [key, value] of Object.entries(shape)) {
      if (key === "protocol" || key === "model") continue;
      if (key === "tool_set_hash") {
        expect(value).toMatch(/^[0-9a-f]{16}$/);
        continue;
      }
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });
});

describe("auditRequestShape", () => {
  const request = canonicalRequest([message("user", USER_TEXT)]);

  test("is opt-in: emits nothing at the default info level", async () => {
    const lines = await captureAuditLines(() => auditRequestShape(request));
    expect(shapeLines(lines)).toHaveLength(0);
  });

  test("emits one debug event at debug level", async () => {
    setAuditLogLevel("debug");
    const lines = await captureAuditLines(() => auditRequestShape(request));
    const events = shapeLines(lines);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      level: "debug",
      event: REQUEST_SHAPE_EVENT,
      message_count: 1,
      user_message_count: 1,
    });
    expectNoLeak(events[0]?.raw ?? "");
  });

  test("never lets a diagnostic failure escape", () => {
    setAuditLogLevel("debug");
    const hostile = {
      get messages(): never {
        throw new Error("boom");
      },
    } as unknown as CanonicalRequest;
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => auditRequestShape(hostile)).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("routes emit request_shape", () => {
  function config(): Config {
    return ConfigSchema.parse({
      api_keys: ["sk-shape"],
      enable_legacy_chat_completions: true,
      protocol_projection_mode: "legacy-user-prefix",
      max_request_body_bytes: 65_536,
    });
  }

  function account(): ManagedAccount {
    return {
      id: "shape-account",
      email: "shape@example.com",
      authMethod: "desktop",
      region: "us-east-1",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: Date.now() + 3_600_000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0,
    };
  }

  const accountManager: PipelineAccountManager = {
    reconcileFromDb: () => [account()],
    selectHealthyAccount: () => account(),
    getAccountCount: () => 1,
    toAuthDetails: (selected): KiroAuthDetails => ({
      refresh: selected.refreshToken,
      access: selected.accessToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
    }),
    markRateLimited: () => {},
    markUnhealthy: () => {},
  };
  const tokenRefresher: PipelineTokenRefresher = {
    refreshIfNeeded: async (selected) => selected,
    forceRefresh: async (selected) => selected,
  };
  const dependencies: RouteDependencies = {
    accountManager,
    tokenRefresher,
    async runPipeline() {
      return Response.json(
        { error: { message: "stub", type: "upstream_error", code: "stub_unavailable" } },
        { status: 503 },
      );
    },
  };

  const toolArguments = JSON.stringify({ path: TOOL_ARGUMENT });
  const routes = [
    {
      label: "responses",
      protocol: "responses",
      handle: handleResponses,
      body: {
        model: "gpt-5.6-sol",
        instructions: SYSTEM_TEXT,
        input: [
          { role: "user", content: USER_TEXT },
          { type: "function_call", call_id: "call_1", name: TOOL_NAME, arguments: toolArguments },
          { type: "function_call_output", call_id: "call_1", output: TOOL_OUTPUT },
        ],
        tools: [{ type: "function", name: TOOL_NAME, parameters: { type: "object" } }],
      },
    },
    {
      label: "messages",
      protocol: "anthropic-messages",
      handle: handleMessages,
      body: {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: SYSTEM_TEXT,
        messages: [
          { role: "user", content: USER_TEXT },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: TOOL_NAME, input: { path: TOOL_ARGUMENT } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: TOOL_OUTPUT }],
          },
        ],
        tools: [{ name: TOOL_NAME, input_schema: { type: "object" } }],
      },
    },
    {
      label: "chat/completions",
      protocol: "chat-completions",
      handle: handleChatCompletions,
      body: {
        model: "gpt-5.6-sol",
        messages: [
          { role: "system", content: SYSTEM_TEXT },
          { role: "user", content: USER_TEXT },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: TOOL_NAME, arguments: toolArguments },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: TOOL_OUTPUT },
        ],
        tools: [
          { type: "function", function: { name: TOOL_NAME, parameters: { type: "object" } } },
        ],
      },
    },
  ] as const;

  for (const route of routes) {
    test(`emits exactly one content-free request_shape event per ${route.label} request`, async () => {
      setAuditLogLevel("debug");
      const lines = await captureAuditLines(async () => {
        const response = await route.handle(
          new Request(`http://gateway/v1/${route.label}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(route.body),
          }),
          config(),
          dependencies,
        );
        expect(response.status).toBe(503);
      });

      const events = shapeLines(lines);
      expect(events).toHaveLength(1);
      const [emitted] = events;
      expect(emitted?.event).toMatchObject({
        level: "debug",
        protocol: route.protocol,
        tool_declaration_count: 1,
        tool_call_count: 1,
        tool_result_count: 1,
        orphan_tool_result_count: 0,
        system_instruction_present: true,
        has_reasoning_replay: false,
        tool_set_hash: auditHash(TOOL_NAME),
      });
      expect(emitted?.event.input_text_chars).toBeGreaterThanOrEqual(
        USER_TEXT.length + TOOL_OUTPUT.length,
      );
      expectNoLeak(emitted?.raw ?? "");
    });

    test(`emits no request_shape event for ${route.label} at the default log level`, async () => {
      const lines = await captureAuditLines(async () => {
        await route.handle(
          new Request(`http://gateway/v1/${route.label}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(route.body),
          }),
          config(),
          dependencies,
        );
      });

      expect(shapeLines(lines)).toHaveLength(0);
    });
  }
});
