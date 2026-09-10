import { randomUUID } from "node:crypto";
import { type Config, ConfigSchema } from "../src/config/schema.js";
import { AccountSelector, selectableCandidates } from "../src/core/account-selection.js";
import type { RunChatCompletionOptions } from "../src/core/pipeline.js";
import type { ManagedAccount } from "../src/kiro/types.js";
import {
  CANONICAL_OUTPUT_JSON_CONTENT_TYPE,
  type CanonicalOutputReasoning,
} from "../src/protocol/output.js";
import { SqliteResponseStore } from "../src/server/responses/store.js";
import { handleResponses, type ResponsesDependencies } from "../src/server/routes/responses.js";
import { AccountsDatabase } from "../src/storage/accounts-db.js";

export function nativeResponse(id: string, model = "gpt-5.6-sol"): Record<string, unknown> {
  return {
    id,
    object: "response",
    model,
    created_at: 1788998400,
    completed_at: 1788998401,
    status: "completed",
    error: null,
    incomplete_details: null,
    background: false,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    metadata: {},
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [], logprobs: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    service_tier: "default",
    store: true,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

export const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

export function textEvents(id = "resp_stream"): readonly Record<string, unknown>[] {
  const response = nativeResponse(id);
  const item = (response.output as Record<string, unknown>[])[0] as Record<string, unknown>;
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { ...response, status: "in_progress", completed_at: null, output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "OK",
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: "OK",
    },
    {
      type: "response.content_part.done",
      sequence_number: 5,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: (item.content as unknown[])[0],
    },
    { type: "response.output_item.done", sequence_number: 6, output_index: 0, item },
    { type: "response.completed", sequence_number: 7, response },
  ];
}

export function fidelityFixture(
  options: {
    config?: Partial<Config>;
    native?: (
      body: Record<string, unknown>,
      call: number,
      init?: RequestInit,
    ) => Response | Promise<Response>;
    reasoning?: CanonicalOutputReasoning;
    parallelCalls?: boolean;
  } = {},
) {
  const database = new AccountsDatabase(":memory:");
  const responseStore = new SqliteResponseStore(database);
  const prefix = randomUUID();
  const accounts: ManagedAccount[] = ["a", "b"].map((id) => ({
    id: `${prefix}-${id}`,
    email: `${id}@example.invalid`,
    authMethod: "desktop",
    region: "us-east-1",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3600000,
    isHealthy: true,
    rateLimitResetTime: 0,
    failCount: 0,
  }));
  const selector = new AccountSelector("round-robin");
  const requests: Record<string, unknown>[] = [];
  const canonical: RunChatCompletionOptions["body"][] = [];
  const selections: Array<{ preferred?: string; selected?: string }> = [];
  const config = ConfigSchema.parse({
    api_keys: ["sk-fidelity-test"],
    protocol_projection_mode: "v3-auto",
    request_timeout_ms: 1000,
    stream_idle_timeout_ms: 100,
    rate_limit_retry_delay_ms: 1,
    rate_limit_max_retries: 0,
    test_upstream_endpoint: "https://runtime.example.invalid",
    ...options.config,
  });
  const dependencies: ResponsesDependencies = {
    tenantId: "fidelity-test",
    affinityStore: database,
    responseStore,
    accountManager: {
      reconcileFromDb: () => accounts,
      getAccountCount: () => accounts.length,
      selectHealthyAccount(preferred, eligible) {
        const candidates = selectableCandidates(accounts, Date.now(), eligible);
        const selected = candidates.length ? selector.pick(candidates, preferred) : null;
        selections.push({ preferred, selected: selected?.id });
        return selected;
      },
      toAuthDetails: (account) => ({
        access: account.accessToken,
        refresh: account.refreshToken,
        expires: account.expiresAt,
        authMethod: account.authMethod,
        region: account.region,
        profileArn: account.profileArn,
      }),
      markRateLimited(account, reset) {
        account.rateLimitResetTime = reset;
      },
      markUnhealthy() {},
    },
    tokenRefresher: {
      refreshIfNeeded: async (account) => account,
      forceRefresh: async (account) => account,
    },
    nativeResponsesFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return (
        options.native?.(body, requests.length, init) ??
        Response.json(nativeResponse(`resp_${requests.length}`, String(body.model)))
      );
    },
    runPipeline: async (input) => {
      canonical.push(input.body);
      return new Response(
        JSON.stringify({
          canonicalOutputVersion: 1,
          conversationId: "test-conversation",
          model: input.model,
          createdAt: Date.now(),
          text: options.parallelCalls ? "" : "OK",
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          toolCalls: options.parallelCalls
            ? input.body.tools.map((tool, i) => ({
                id: `call_${i}`,
                name: tool.wireName,
                input: "{}",
              }))
            : [],
          finishReason: options.parallelCalls ? "tool_calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        { headers: { "Content-Type": CANONICAL_OUTPUT_JSON_CONTENT_TYPE } },
      );
    },
  };
  return {
    database,
    responseStore,
    config,
    dependencies,
    accounts,
    primary: accounts[0] as ManagedAccount,
    requests,
    canonical,
    selections,
    send(body: unknown, overrides: Partial<ResponsesDependencies> = {}, signal?: AbortSignal) {
      return handleResponses(
        new Request("http://gateway/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
        config,
        { ...dependencies, ...overrides },
      );
    },
  };
}
