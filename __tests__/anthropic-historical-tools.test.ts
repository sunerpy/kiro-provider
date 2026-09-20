import { describe, expect, test } from "bun:test";
import { messagesFixture, messagesSseEvents } from "./messages-regression-helpers.js";

const oldCall = {
  type: "tool_use",
  id: "historical-task-output",
  name: "TaskOutput",
  input: { task_id: "synthetic-background-task", block: true, timeout: 1000 },
};
const oldResult = {
  type: "tool_result",
  tool_use_id: oldCall.id,
  content: "The background task was stopped under memory pressure.",
  is_error: true,
};
const historicalMessages = [
  { role: "user", content: "Run the synthetic background task." },
  { role: "assistant", content: [oldCall] },
  { role: "user", content: [oldResult] },
  { role: "assistant", content: "The task stopped; its result has been recorded." },
  { role: "user", content: "Continue." },
];
const currentTool = {
  name: "TaskStop",
  description: "Stop a currently running synthetic task.",
  input_schema: {
    type: "object",
    properties: { task_id: { type: "string" } },
    required: ["task_id"],
    additionalProperties: false,
  },
};

describe("Messages historical tools across client tool-catalog changes", () => {
  test.each([false, true])(
    "continues the stopped task history after TaskOutput is withdrawn (stream=%s)",
    async (stream) => {
      const fixture = messagesFixture();
      const response = await fixture.request({
        stream,
        messages: historicalMessages,
        tools: [currentTool],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("CONTINUED");
      expect(fixture.inputs).toHaveLength(1);
      const conversation = fixture.inputs[0]?.conversationState;
      const history = conversation?.history;
      expect(history?.[1]?.assistantResponseMessage?.toolUses).toEqual([
        { toolUseId: oldCall.id, name: oldCall.name, input: oldCall.input },
      ]);
      expect(history?.[2]?.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
        {
          toolUseId: oldCall.id,
          content: [{ text: oldResult.content }],
          status: "error",
        },
      ]);
      const declarations =
        conversation?.currentMessage?.userInputMessage?.userInputMessageContext?.tools;
      expect(declarations?.map((tool) => tool.toolSpecification?.name)).toEqual(["TaskStop"]);
      expect(fixture.state.iteratorClosed).toBe(1);
    },
  );

  test.each([undefined, [], [currentTool]].map((tools) => ({ tools })))(
    "does not need historical declarations when the current catalog is %j",
    async ({ tools }) => {
      const fixture = messagesFixture();
      const response = await fixture.request({
        messages: historicalMessages,
        ...(tools !== undefined ? { tools } : {}),
        tool_choice: { type: "none" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("CONTINUED");
      expect(
        fixture.inputs[0]?.conversationState?.currentMessage?.userInputMessage
          ?.userInputMessageContext?.tools,
      ).toBeUndefined();
    },
  );

  test("counts the same resumed history without making an upstream request", async () => {
    const fixture = messagesFixture();
    const response = await fixture.request(
      { messages: historicalMessages, tools: [currentTool] },
      "/v1/messages/count_tokens",
    );
    expect(response.status).toBe(200);
    const counted = (await response.json()) as { input_tokens: number };
    expect(counted.input_tokens).toBeGreaterThan(0);
    expect(fixture.inputs).toHaveLength(0);
  });

  test.each([false, true])(
    "never authorizes an upstream TaskOutput call from history (stream=%s)",
    async (stream) => {
      const fixture = messagesFixture([
        {
          toolUseEvent: {
            name: "TaskOutput",
            toolUseId: "forbidden-new-call",
            input: "{}",
            stop: true,
          },
        },
      ]);
      const response = await fixture.request({
        stream,
        messages: historicalMessages,
        tools: [currentTool],
      });
      expect(response.status).toBe(stream ? 200 : 502);
      const text = await response.text();
      expect(text).not.toContain("forbidden-new-call");
      expect(text).not.toContain('"type":"tool_use"');
      if (stream) {
        const events = messagesSseEvents(text);
        expect(events.some((event) => event.type === "error")).toBe(true);
        expect(events.some((event) => event.type === "message_stop")).toBe(false);
      } else {
        expect(JSON.parse(text).error.type).toBe("api_error");
      }
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.state.iteratorClosed).toBe(1);
      expect(fixture.state.aborted).toBe(1);
    },
  );

  test("validates new output against the current schema, not historical arguments", async () => {
    const fixture = messagesFixture([
      {
        toolUseEvent: {
          name: "TaskOutput",
          toolUseId: "new-call-wrong-schema",
          input: JSON.stringify(oldCall.input),
          stop: true,
        },
      },
    ]);
    const response = await fixture.request({
      messages: historicalMessages,
      tools: [
        {
          ...currentTool,
          name: "TaskOutput",
          input_schema: {
            type: "object",
            properties: { revised_id: { type: "number" } },
            required: ["revised_id"],
            additionalProperties: false,
          },
        },
      ],
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("declared schema");
    expect(fixture.inputs).toHaveLength(1);
  });

  test.each(
    [
      [{ role: "user", content: [oldResult] }],
      [
        { role: "assistant", content: [oldCall, oldCall] },
        { role: "user", content: [oldResult] },
      ],
      [
        { role: "assistant", content: [oldCall] },
        { role: "user", content: [oldResult, oldResult] },
      ],
    ].map((messages) => ({ messages })),
  )("rejects malformed call/result history before dispatch: %j", async ({ messages }) => {
    const fixture = messagesFixture();
    const response = await fixture.request({ messages, tools: [currentTool] });
    expect(response.status).toBe(400);
    expect(fixture.inputs).toHaveLength(0);
  });

  test("retains pending-result and authentication gates", async () => {
    const fixture = messagesFixture();
    const pending = await fixture.request({
      messages: historicalMessages.slice(0, 2).concat({ role: "user", content: "Continue." }),
      tool_choice: { type: "none" },
    });
    expect(pending.status).toBe(400);
    const unauthorized = await fixture.request({ messages: historicalMessages }, "/v1/messages", {
      key: "wrong-fixture-key",
    });
    expect(unauthorized.status).toBe(401);
    expect(fixture.inputs).toHaveLength(0);
  });
});
