import { expect, test } from "bun:test";
import { fidelityFixture, nativeResponse, sse } from "./responses-fidelity-helpers.js";

const nsTools = (names = ["alpha", "beta"]) => [
  {
    type: "namespace",
    name: "functions",
    tools: names.map((name) => ({
      type: "function",
      name,
      parameters: { type: "object", properties: {} },
    })),
  },
];
type TestResponse = {
  id: string;
  instructions: string | null;
  output: Array<Record<string, unknown>>;
  tools: unknown[];
  error: { code: string };
};

test("an empty namespace has no callable tools and does not force serial fallback", async () => {
  const f = fidelityFixture();
  try {
    const response = await f.send({
      model: "gpt-5.6-sol",
      input: "Hi",
      tools: nsTools([]),
      parallel_tool_calls: false,
      max_output_tokens: 32,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-transport")).toBe("native-adapted");
    expect(f.requests[0]?.tools).toEqual([]);
    expect(f.requests[0]?.max_output_tokens).toBe(32);
  } finally {
    f.database.close();
  }
});

test("auto native bridges use only verified model and region cells", async () => {
  for (const verified of [true, false]) {
    const f = fidelityFixture();
    try {
      if (!verified) {
        for (const account of f.accounts) account.region = "eu-central-1";
      }
      const response = await f.send({ model: "gpt-5.6-sol", input: "Hi", tools: nsTools() });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kiro-transport")).toBe(
        verified ? "native-adapted" : "stateless",
      );
    } finally {
      f.database.close();
    }
  }
});

test("native bridge preserves schema properties named encrypted and the public tool identity", async () => {
  const f = fidelityFixture({ config: { responses_native_tool_bridge: "experimental" } });
  try {
    const parameters = {
      type: "object",
      properties: { encrypted: { type: "boolean" } },
      required: ["encrypted"],
    };
    await f.send({
      model: "gpt-5.6-sol",
      input: "Hi",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "echo", parameters }],
        },
      ],
    });
    const tools = f.requests[0]?.tools as Array<{ parameters: unknown; description: string }>;
    expect(tools[0]?.parameters).toEqual(parameters);
    expect(tools[0]?.description).toContain("functions.echo");
  } finally {
    f.database.close();
  }
});

test("observed instruction-priority uncertainty is explicit and strict blocks inference", async () => {
  for (const mode of ["compatible", "strict"] as const) {
    const f = fidelityFixture({ config: { responses_fidelity_mode: mode } });
    try {
      const response = await f.send({
        model: "claude-opus-5",
        instructions: "Policy",
        input: "Hi",
      });
      expect(response.status).toBe(mode === "strict" ? 400 : 200);
      expect(response.headers.get("x-kiro-compatibility")).toContain(
        "native_instruction_priority_unverified",
      );
      expect(f.requests.length).toBe(mode === "strict" ? 0 : 1);
    } finally {
      f.database.close();
    }
  }
});

test("unverified instruction lifting stays off in auto mode", async () => {
  const f = fidelityFixture();
  try {
    const response = await f.send({
      model: "claude-opus-5",
      input: [
        { role: "developer", content: "Policy" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(response.headers.get("x-kiro-transport")).toBe("stateless");
    expect(f.requests).toHaveLength(0);
  } finally {
    f.database.close();
  }
});

test("experimental lifting preserves public input and carries its persistent scope across off", async () => {
  const f = fidelityFixture({ config: { responses_instruction_lift: "experimental" } });
  try {
    const response = await f.send({
      model: "claude-opus-5",
      input: [
        { role: "developer", content: "Exact\npolicy" },
        { role: "user", content: "Hi" },
      ],
    });
    const body = (await response.json()) as TestResponse;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-transport")).toBe("native-adapted");
    expect(body.instructions).toBeNull();
    expect(f.requests[0]?.instructions).toBe("Exact\npolicy");
    expect(f.requests[0]?.input).toEqual([{ role: "user", content: "Hi" }]);
    expect(f.responseStore.get("fidelity-test", body.id)?.inputItems[0]).toMatchObject({
      role: "developer",
    });
    f.config.responses_instruction_lift = "off";
    const next = await f.send({
      model: "claude-opus-5",
      previous_response_id: body.id,
      input: "Next",
    });
    expect(next.status).toBe(200);
    expect(f.requests[1]?.instructions).toBe("Exact\npolicy");
    const conflict = await f.send({
      model: "claude-opus-5",
      previous_response_id: body.id,
      input: "Next",
      instructions: "Different scope",
    });
    expect(conflict.status).toBe(400);
    expect(((await conflict.json()) as TestResponse).error.code).toBe(
      "native_instruction_scope_conflict",
    );
    expect(f.requests).toHaveLength(2);
  } finally {
    f.database.close();
  }
});

test.each([
  {
    input: [
      { role: "system", content: "A" },
      { role: "developer", content: "B" },
      { role: "user", content: "Hi" },
    ],
  },
  {
    input: [
      { role: "user", content: "Hi" },
      { role: "developer", content: "Tail" },
    ],
  },
])("experimental mode does not lift an unrepresentable sequence", async ({ input }) => {
  const f = fidelityFixture({ config: { responses_instruction_lift: "experimental" } });
  try {
    const response = await f.send({ model: "claude-opus-5", input });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kiro-transport")).toBe("stateless");
    expect(f.requests).toHaveLength(0);
  } finally {
    f.database.close();
  }
});

test("native namespace bindings survive declaration reordering, removal, and disabling the feature", async () => {
  const f = fidelityFixture({
    config: { responses_native_tool_bridge: "experimental" },
    native: (body, call) => {
      const result = nativeResponse(`resp_${call}`);
      if (call === 1)
        result.output = [
          {
            type: "function_call",
            id: "fc_first",
            call_id: "call_first",
            name: (body.tools as Array<{ name: string }>)[0]?.name,
            arguments: "{}",
            status: "completed",
          },
        ];
      return Response.json(result);
    },
  });
  try {
    const first = await f.send({ model: "gpt-5.6-sol", input: "Use alpha", tools: nsTools() });
    const body = (await first.json()) as TestResponse;
    expect(first.status).toBe(200);
    expect(first.headers.get("x-kiro-transport")).toBe("native-adapted");
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      namespace: "functions",
      name: "alpha",
      arguments: "{}",
    });
    expect(body.tools).toEqual(nsTools());
    expect(JSON.stringify(body)).not.toContain("kiro_ns_");
    const original = f.requests[0]?.tools as Array<{ name: string }>;
    const second = await f.send({
      model: "gpt-5.6-sol",
      previous_response_id: body.id,
      input: [{ type: "function_call_output", call_id: "call_first", output: "OK" }],
      tools: nsTools(["beta", "alpha"]),
    });
    expect(second.status).toBe(200);
    const reordered = f.requests[1]?.tools as Array<{ name: string }>;
    expect(reordered[0]?.name).toBe(original[1]?.name);
    expect(reordered[1]?.name).toBe(original[0]?.name);
    f.config.responses_native_tool_bridge = "off";
    const third = await f.send({
      model: "gpt-5.6-sol",
      previous_response_id: body.id,
      input: [{ type: "function_call_output", call_id: "call_first", output: "OK" }],
    });
    expect(third.status).toBe(200);
    expect(f.requests[2]?.tools).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("native custom tools preserve raw input in JSON and streamed events", async () => {
  const raw = 'print("中文")\n\\path\n';
  for (const stream of [false, true]) {
    const f = fidelityFixture({
      config: { responses_native_tool_bridge: "experimental" },
      native: (body) => {
        const name = (body.tools as Array<{ name: string }>)[0]?.name;
        const item = {
          type: "function_call",
          id: "fc_custom",
          call_id: "call_custom",
          name,
          arguments: JSON.stringify({ input: raw }),
          status: "completed",
        };
        const result = { ...nativeResponse("resp_custom"), output: [item] };
        if (!stream) return Response.json(result);
        const events = [
          {
            type: "response.created",
            sequence_number: 0,
            response: { ...result, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { ...item, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: item.id,
            delta: item.arguments.slice(0, 4),
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: item.id,
            delta: item.arguments.slice(4),
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 4,
            output_index: 0,
            item_id: item.id,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", sequence_number: 5, output_index: 0, item },
          { type: "response.completed", sequence_number: 6, response: result },
        ];
        return new Response(events.map(sse).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    try {
      const response = await f.send({
        model: "gpt-5.6-sol",
        input: "Run",
        stream,
        tools: [{ type: "custom", name: "execute", format: { type: "text" } }],
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("kiro_custom_");
      if (stream) {
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        expect(
          events.find((event) => event.type === "response.custom_tool_call_input.done")?.input,
        ).toBe(raw);
        const sequences = events.map((event) => event.sequence_number);
        expect(sequences).toEqual(events.map((_, index) => index));
      } else expect((JSON.parse(text) as TestResponse).output[0]?.input).toBe(raw);
    } finally {
      f.database.close();
    }
  }
});

test("native adaptation rejects collisions and malformed custom wrappers", async () => {
  const f = fidelityFixture({
    config: { responses_native_tool_bridge: "experimental" },
    native: (body) =>
      Response.json({
        ...nativeResponse("resp_collision"),
        output: [
          {
            type: "function_call",
            id: "fc_collision",
            call_id: "call_collision",
            name: (body.tools as Array<{ name: string }>)[0]?.name,
            arguments: "{}",
            status: "completed",
          },
        ],
      }),
  });
  try {
    const first = (await (
      await f.send({ model: "gpt-5.6-sol", input: "Run", tools: nsTools(["alpha"]) })
    ).json()) as TestResponse;
    const name = (f.requests[0]?.tools as Array<{ name: string }>)[0]?.name;
    const collision = await f.send({
      model: "gpt-5.6-sol",
      previous_response_id: first.id,
      input: "Hi",
      tools: [{ type: "function", name, parameters: { type: "object" } }],
    });
    expect(collision.status).toBe(400);
    const malformed = await f.send({
      model: "gpt-5.6-sol",
      input: "Run",
      tools: [{ type: "custom", name: "execute" }],
    });
    expect(malformed.status).toBe(502);
    expect(((await malformed.json()) as TestResponse).error.code).toBe("invalid_custom_tool_input");
  } finally {
    f.database.close();
  }
});

test("experimental flags do not bypass store=false or grammar boundaries", async () => {
  const f = fidelityFixture({
    config: {
      responses_native_tool_bridge: "experimental",
      responses_instruction_lift: "experimental",
    },
  });
  try {
    for (const extra of [
      { store: false, tools: nsTools() },
      {
        tools: [
          {
            type: "custom",
            name: "execute",
            format: { type: "grammar", syntax: "regex", definition: ".*" },
          },
        ],
      },
    ]) {
      const response = await f.send({ model: "gpt-5.6-sol", input: "Hi", ...extra });
      expect(response.headers.get("x-kiro-transport")).toBe("stateless");
    }
    expect(f.requests).toHaveLength(0);
  } finally {
    f.database.close();
  }
});
