import { describe, expect, test } from "bun:test";
import type { SdkStreamEvent } from "../src/kiro/transform/streaming/sdk-stream-runtime.js";
import { captureAuditEvents } from "./audit-test-helpers.js";
import { MESSAGES_FIXTURE_KEY, messagesFixture } from "./messages-regression-helpers.js";

const TITLE_FORMAT = {
  type: "json_schema",
  name: "codex_output_schema",
  strict: true,
  schema: {
    type: "object",
    properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
    required: ["title"],
    additionalProperties: false,
  },
};

function titleRequest(text = "Produce a synthetic title", structured = true): Request {
  return new Request("http://fixture/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MESSAGES_FIXTURE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      store: false,
      input: text,
      tools: [],
      ...(structured ? { text: { format: TITLE_FORMAT } } : {}),
    }),
  });
}

describe("non-stream structured output collector budget", () => {
  test.each([
    {
      label: "a surrogate pair split between deltas",
      chunks: ["x".repeat(65532), "\ud83d", "", "\ude00"],
    },
    { label: "multibyte CJK text", chunks: ["界".repeat(21845), "a"] },
  ])("accepts exactly 64 KiB with $label", async ({ chunks }) => {
    const audit = captureAuditEvents();
    const fixture = messagesFixture(
      chunks.map((content) => ({ assistantResponseEvent: { content } })),
    );
    try {
      expect(Buffer.byteLength(chunks.join(""), "utf8")).toBe(64 * 1024);
      const response = await fixture.app(titleRequest());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { output: [{ content: [{ text: string }] }] };
      const title = JSON.parse(body.output[0].content[0].text).title;
      expect(title).toBe(Array.from(chunks.join("")).slice(0, 36).join(""));
      expect(fixture.inputs).toHaveLength(1);
    } finally {
      audit.restore();
    }
  });

  test("rejects UTF-8 byte overflow even when the character count fits", async () => {
    const audit = captureAuditEvents();
    const content = "界".repeat(21846);
    const fixture = messagesFixture([{ assistantResponseEvent: { content } }]);
    try {
      expect(content.length).toBeLessThan(64 * 1024);
      const response = await fixture.app(titleRequest());
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: { code: "structured_output_buffer_exceeded", param: "text.format" },
      });
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.aborted).toBe(1);
    } finally {
      audit.restore();
    }
  });

  test("ordinary non-stream output retains its existing behavior above 64 KiB", async () => {
    const audit = captureAuditEvents();
    const content = "x".repeat(128 * 1024);
    const fixture = messagesFixture([{ assistantResponseEvent: { content } }]);
    try {
      const response = await fixture.app(titleRequest("Produce synthetic text", false));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { output: [{ content: [{ text: string }] }] };
      expect(body.output[0].content[0].text).toBe(content);
      expect(fixture.state.aborted).toBe(0);
    } finally {
      audit.restore();
    }
  });

  test("stops at overflow before further output and retains the account lease until cleanup", async () => {
    const audit = captureAuditEvents();
    const closing = Promise.withResolvers<"cleanup">();
    const overread = Promise.withResolvers<"overread">();
    const unblockRead = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let sends = 0;
    let reads = 0;
    let aborts = 0;
    const fixture = messagesFixture(undefined, {
      config: { account_inference_concurrency: 1, request_timeout_ms: 10_000 },
      stream: (signal) => {
        if (++sends > 1) {
          return (async function* () {
            yield { assistantResponseEvent: { content: "Recovered title" } };
            yield {
              metadataEvent: { tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            };
          })();
        }
        signal.addEventListener("abort", () => aborts++, { once: true });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<SdkStreamEvent>> {
                reads++;
                if (reads <= 3) {
                  return {
                    done: false,
                    value: {
                      assistantResponseEvent: { content: reads < 3 ? "x".repeat(32 * 1024) : "!" },
                    },
                  };
                }
                overread.resolve("overread");
                await unblockRead.promise;
                return { done: true, value: undefined };
              },
              async return(): Promise<IteratorResult<SdkStreamEvent>> {
                closing.resolve("cleanup");
                await releaseCleanup.promise;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    });
    const pending: Promise<Response>[] = [];
    try {
      const first = fixture.app(titleRequest());
      pending.push(first);
      expect(await Promise.race([closing.promise, overread.promise])).toBe("cleanup");
      expect(reads).toBe(3);
      const second = fixture.app(titleRequest("Produce another synthetic title"));
      pending.push(second);
      await Bun.sleep(5);
      expect(sends).toBe(1);
      expect(audit.events("request_admission_released")).toHaveLength(0);
      releaseCleanup.resolve();
      const rejected = await first;
      expect(rejected.status).toBe(502);
      expect(await rejected.json()).toMatchObject({
        error: {
          type: "upstream_error",
          code: "structured_output_buffer_exceeded",
          param: "text.format",
        },
      });
      expect(aborts).toBe(1);
      const recovered = await second;
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain('{\\"title\\":\\"Recovered title\\"}');
      expect(sends).toBe(2);
      expect(audit.events("request_admission_released").at(-1)).toMatchObject({
        active_requests: 0,
        reserved_body_bytes: 0,
      });
    } finally {
      unblockRead.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled(pending.map(async (response) => (await response).body?.cancel()));
      audit.restore();
    }
  });
});
