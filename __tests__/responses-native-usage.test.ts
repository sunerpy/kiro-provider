import { expect, test } from "bun:test";
import { fidelityFixture, nativeResponse, sse, textEvents } from "./responses-fidelity-helpers.js";

const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 400, cache_write_tokens: 200, image_tokens: 50 },
  output_tokens: 120,
  output_tokens_details: { reasoning_tokens: 90 },
  total_tokens: 1120,
  metadata: { upstream_marker: "preserved" },
};

test.each([false, true])(
  "native JSON/SSE preserve measured usage and detail extensions (stream=%s)",
  async (stream) => {
    const f = fidelityFixture({
      native: () => {
        const response = { ...nativeResponse("resp_usage"), usage };
        if (!stream) return Response.json(response);
        const events = textEvents("resp_usage").map((event) => {
          if (event.type === "response.created")
            return {
              ...event,
              response: { ...response, output: [], status: "in_progress", usage: null },
            };
          return event.type === "response.completed" ? { ...event, response } : event;
        });
        return new Response(events.map(sse).join(""), {
          headers: { "Content-Type": "text/event-stream", "X-Reasoning-Included": "true" },
        });
      },
    });
    try {
      const response = await f.send({ model: "gpt-5.6-sol", input: "Hi", stream });
      expect(response.status).toBe(200);
      const body = stream
        ? (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((event) => event.type === "response.completed")?.response
        : await response.json();
      expect(body.usage).toEqual(usage);
      const stored = f.responseStore.get("fidelity-test", "resp_usage");
      expect(stored?.response.usage).toEqual(usage);
      if (stream) expect(response.headers.get("X-Reasoning-Included")).toBe("true");
    } finally {
      f.database.close();
    }
  },
);

test.each([false, true])(
  "native invalid usage fails without retry or invented counts (stream=%s)",
  async (stream) => {
    const f = fidelityFixture({
      native: () => {
        const response = {
          ...nativeResponse("resp_bad_usage"),
          usage: { ...usage, total_tokens: 9999 },
        };
        return stream
          ? new Response(
              [
                sse({
                  type: "response.created",
                  sequence_number: 0,
                  response: { ...response, usage: null, output: [], status: "in_progress" },
                }),
                sse({ type: "response.completed", sequence_number: 1, response }),
              ].join(""),
              { headers: { "Content-Type": "text/event-stream" } },
            )
          : Response.json(response);
      },
    });
    try {
      const response = await f.send({ model: "gpt-5.6-sol", input: "Hi", stream });
      if (stream) {
        const events = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.filter((event) => event.type === "response.failed")).toHaveLength(1);
        expect(events.some((event) => event.type === "response.completed")).toBe(false);
        expect(events.at(-1)?.response.error.code).toBe("invalid_upstream_usage");
      } else {
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_upstream_usage" } });
      }
      expect(f.requests).toHaveLength(1);
    } finally {
      f.database.close();
    }
  },
);

test.each(["compatible", "strict"] as const)(
  "missing native breakdown remains unknown in %s mode",
  async (mode) => {
    const f = fidelityFixture({
      config: { responses_fidelity_mode: mode },
      native: () =>
        Response.json({
          ...nativeResponse("resp_partial"),
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        }),
    });
    try {
      const response = await f.send({ model: "gpt-5.6-sol", input: "Hi" });
      const body = await response.json();
      if (mode === "strict") expect(body).not.toHaveProperty("usage");
      else {
        expect(body).toMatchObject({
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            metadata: { kiro: { source: "upstream_partial" } },
          },
        });
        expect(body).not.toHaveProperty("usage.output_tokens_details.reasoning_tokens");
      }
    } finally {
      f.database.close();
    }
  },
);

test("native stream failure does not reuse usage from an earlier progress snapshot", async () => {
  const f = fidelityFixture({
    native: () =>
      new Response(
        sse({
          type: "response.created",
          sequence_number: 0,
          response: {
            ...nativeResponse("resp_progress_usage"),
            output: [],
            status: "in_progress",
            usage,
            usage_metadata: { metadata: { snapshot: "progress-only" } },
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  try {
    const response = await f.send({ model: "gpt-5.6-sol", input: "Hi", stream: true });
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const failed = events.filter((event) => event.type === "response.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].response.error.code).toBe("upstream_stream_incomplete");
    expect(failed[0].response).not.toHaveProperty("usage");
    expect(failed[0].response).not.toHaveProperty("usage_metadata");
    expect(f.requests).toHaveLength(1);
  } finally {
    f.database.close();
  }
});
