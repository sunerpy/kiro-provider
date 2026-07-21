import { describe, expect, test } from "bun:test";
import { responsesSseAdapter } from "../src/server/responses/sse-adapter.js";

type ParsedEvent = {
	readonly type: string;
	readonly sequenceNumber: number;
	readonly body: Readonly<Record<string, unknown>>;
};

type HarnessState = {
	cancelAttempts: unknown[];
	cancelReasons: unknown[];
	finalizeCount: number;
};

const encoder = new TextEncoder();

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolver = resolve;
	});
	if (!resolver) throw new TypeError("deferred resolver was not initialized");
	return { promise, resolve: resolver };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvents(text: string): ParsedEvent[] {
	return text
		.split("\n\n")
		.filter((frame) => frame.length > 0)
		.map((frame) => {
			const lines = frame.split("\n");
			const eventLine = lines.find((line) => line.startsWith("event: "));
			const dataLine = lines.find((line) => line.startsWith("data: "));
			if (!eventLine || !dataLine) throw new TypeError("invalid SSE frame");
			const body: unknown = JSON.parse(dataLine.slice("data: ".length));
			if (
				!isRecord(body) ||
				typeof body.type !== "string" ||
				typeof body.sequence_number !== "number"
			) {
				throw new TypeError("invalid Responses event");
			}
			expect(eventLine).toBe(`event: ${body.type}`);
			return {
				type: body.type,
				sequenceNumber: body.sequence_number,
				body,
			};
		});
}

function chunk(
	delta: Readonly<Record<string, unknown>>,
	finishReason: "stop" | "tool_calls" | null = null,
): string {
	const base = {
		id: "chatcmpl_test",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: "gpt-5.6-sol",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	if (finishReason === null) return JSON.stringify(base);
	return JSON.stringify({
		...base,
		usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
	});
}

function makeHarness(
	parts: readonly Uint8Array[],
	end: "abort" | "close" | "stall" | "error" = "close",
): {
	readonly response: Response;
	readonly state: HarnessState;
	readonly finalized: Promise<void>;
	readonly finalize: () => void;
} {
	const state: HarnessState = { cancelAttempts: [], cancelReasons: [], finalizeCount: 0 };
	const finalized = deferred();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			if (end === "close") controller.close();
			if (end === "error") controller.error(new TypeError("upstream read failed"));
			if (end === "abort") controller.error(new DOMException("deadline exceeded", "AbortError"));
		},
		cancel(reason) {
			state.cancelReasons.push(reason);
		},
	});
	const response = new Response(stream, {
			headers: { "Content-Type": "application/x-ndjson" },
		});
	const body = response.body;
	if (!body) throw new TypeError("harness response has no body");
	const getReader = body.getReader.bind(body);
	Object.defineProperty(body, "getReader", {
		value() {
			const reader = getReader();
			const cancel = reader.cancel.bind(reader);
			Object.defineProperty(reader, "cancel", {
				value(reason?: unknown) {
					state.cancelAttempts.push(reason);
					return cancel(reason);
				},
			});
			return reader;
		},
	});
	return {
		response,
		state,
		finalized: finalized.promise,
		finalize() {
			state.finalizeCount += 1;
			finalized.resolve();
		},
	};
}

async function adapt(harness: ReturnType<typeof makeHarness>): Promise<ParsedEvent[]> {
	const response = responsesSseAdapter(harness.response, {
		model: "gpt-5.6-sol",
		finalize: harness.finalize,
	});
	expect(response.headers.get("Content-Type")).toStartWith("text/event-stream");
	return parseEvents(await response.text());
}

function terminalTypes(events: readonly ParsedEvent[]): string[] {
	return events
		.map((event) => event.type)
		.filter((type) => type === "response.completed" || type === "response.failed");
}

describe("responsesSseAdapter", () => {
	test("emits a complete text response with added before delta and terminal usage", async () => {
		const input = `${chunk({ content: "Hel" })}\n${chunk({ content: "lo" })}\n${chunk({}, "stop")}\n`;
		const harness = makeHarness([encoder.encode(input)], "stall");

		const events = await adapt(harness);

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
			item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
		});
		expect(events.at(-1)?.body).toMatchObject({
			response: {
				status: "completed",
				usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
			},
		});
		expect(events.at(-1)?.body).toHaveProperty("response.id", expect.stringMatching(/^resp_/));
		expect(events.map((event) => event.sequenceNumber)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(terminalTypes(events)).toEqual(["response.completed"]);
		expect(harness.state.cancelReasons).toHaveLength(1);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test("does not synthesize completed when EOF arrives before a terminal chunk", async () => {
		const harness = makeHarness([encoder.encode(`${chunk({ content: "partial" })}\n`)]);

		const events = await adapt(harness);

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.output_text.delta",
			"response.failed",
		]);
		expect(terminalTypes(events)).toEqual(["response.failed"]);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test("aggregates split function calls without emitting argument delta events", async () => {
		const lines = [
			chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
			chunk({}, "tool_calls"),
		].join("\n");

		const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.done",
			"response.completed",
		]);
		expect(events[1]?.body).toMatchObject({
			item: { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"command":"ls"}' },
		});
		expect(events.some((event) => event.type === "response.function_call_arguments.delta")).toBe(false);
	});

	test("keeps tool-call id and name from the first fragment that provides them", async () => {
		const lines = [
			chunk({ tool_calls: [{ index: 0, id: "call_first", type: "function", function: { name: "first", arguments: "{" } }] }),
			chunk({ tool_calls: [{ index: 0, id: "call_later", type: "function", function: { name: "later", arguments: "}" } }] }),
			chunk({}, "tool_calls"),
		].join("\n");

		const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

		expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
			item: { type: "function_call", call_id: "call_first", name: "first", arguments: "{}" },
		});
	});

	test("emits reasoning added, deltas, accumulated done, and item done in order", async () => {
		const input = `${chunk({ reasoning_content: "Plan " })}\n${chunk({ reasoning_content: "first" })}\n${chunk({}, "stop")}\n`;

		const events = await adapt(makeHarness([encoder.encode(input)], "stall"));

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.output_item.done",
			"response.completed",
		]);
		expect(events[4]?.body).toMatchObject({ text: "Plan first", summary_index: 0 });
		expect(events[5]?.body).toMatchObject({
			item: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan first" }] },
		});
	});

	test("fails and cancels upstream on malformed NDJSON", async () => {
		const harness = makeHarness([encoder.encode("{not-json}\n")], "stall");

		const events = await adapt(harness);

		expect(terminalTypes(events)).toEqual(["response.failed"]);
		expect(events.some((event) => event.type === "response.completed")).toBe(false);
		expect(harness.state.cancelReasons).toHaveLength(1);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test("fails and finalizes once when reader.read rejects", async () => {
		const harness = makeHarness([], "error");

		const events = await adapt(harness);

		expect(events.map((event) => event.type)).toEqual(["response.created", "response.failed"]);
		expect(harness.state.cancelAttempts).toHaveLength(1);
		expect(harness.state.cancelReasons).toHaveLength(0);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test("fails, attempts wrapped cancellation, and finalizes once on deadline abort", async () => {
		const harness = makeHarness([], "abort");

		const events = await adapt(harness);

		expect(terminalTypes(events)).toEqual(["response.failed"]);
		expect(harness.state.cancelAttempts).toHaveLength(1);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test("propagates downstream cancellation without a terminal event", async () => {
		const harness = makeHarness([encoder.encode(`${chunk({ content: "partial" })}\n`)], "stall");
		const response = responsesSseAdapter(harness.response, {
			model: "gpt-5.6-sol",
			finalize: harness.finalize,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new TypeError("adapter response has no body");

		const first = await reader.read();
		const observed = first.done ? [] : parseEvents(new TextDecoder().decode(first.value));
		await reader.cancel("consumer stopped");

		expect(terminalTypes(observed)).toEqual([]);
		expect(harness.state.cancelReasons).toEqual(["consumer stopped"]);
		expect(harness.state.finalizeCount).toBe(1);
	});

	test.each([
		["two lines in one read", (text: string) => [encoder.encode(text)]],
		["a line split across reads", (text: string) => [encoder.encode(text.slice(0, 41)), encoder.encode(text.slice(41))]],
	])("frames %s", async (_name, split) => {
		const input = `${chunk({ content: "framed" })}\n${chunk({}, "stop")}\n`;

		const events = await adapt(makeHarness(split(input), "stall"));

		expect(events.find((event) => event.type === "response.output_text.delta")?.body).toMatchObject({ delta: "framed" });
		expect(terminalTypes(events)).toEqual(["response.completed"]);
	});

	test("preserves a UTF-8 code point split across byte reads", async () => {
		const bytes = encoder.encode(`${chunk({ content: "你" })}\n${chunk({}, "stop")}\n`);
		const utf8Start = bytes.indexOf(0xe4);
		expect(utf8Start).toBeGreaterThanOrEqual(0);

		const events = await adapt(makeHarness([bytes.slice(0, utf8Start + 1), bytes.slice(utf8Start + 1)], "stall"));

		expect(events.find((event) => event.type === "response.output_text.delta")?.body).toMatchObject({ delta: "你" });
	});

	test("parses an unterminated final NDJSON line", async () => {
		const input = `${chunk({ content: "final" })}\n${chunk({}, "stop")}`;

		const events = await adapt(makeHarness([encoder.encode(input)]));

		expect(terminalTypes(events)).toEqual(["response.completed"]);
		expect(events.find((event) => event.type === "response.output_item.done")?.body).toMatchObject({
			item: { content: [{ text: "final" }] },
		});
	});

	test("orders mixed reasoning, text, and multiple tool-call completion events", async () => {
		const lines = [
			chunk({ reasoning_content: "think " }),
			chunk({ reasoning_content: "carefully" }),
			chunk({ content: "answer " }),
			chunk({ content: "ready" }),
			chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: "{" } }] }),
			chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "beta", arguments: "[" } }] }),
			chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }, { index: 1, function: { arguments: "]" } }] }),
			chunk({}, "tool_calls"),
		].join("\n");

		const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.output_item.done",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_text.delta",
			"response.output_item.done",
			"response.output_item.done",
			"response.output_item.done",
			"response.completed",
		]);
		expect(events[5]?.body).toMatchObject({ item: { type: "reasoning" } });
		expect(events[9]?.body).toMatchObject({ item: { type: "message" } });
		expect(events[10]?.body).toMatchObject({ item: { type: "function_call", call_id: "call_a", name: "alpha", arguments: "{}" } });
		expect(events[11]?.body).toMatchObject({ item: { type: "function_call", call_id: "call_b", name: "beta", arguments: "[]" } });
		expect(events.map((event) => event.sequenceNumber)).toEqual(events.map((_event, index) => index));
	});

	test("reopens a fresh reasoning item when reasoning resumes after text", async () => {
		const lines = [
			chunk({ reasoning_content: "first" }),
			chunk({ content: "answer " }),
			chunk({ reasoning_content: "later" }),
			chunk({ content: "done" }),
			chunk({}, "stop"),
		].join("\n");

		const events = await adapt(makeHarness([encoder.encode(`${lines}\n`)], "stall"));
		const reasoningDone = events.filter(
			(event) =>
				event.type === "response.output_item.done" &&
				isRecord(event.body.item) &&
				event.body.item.type === "reasoning",
		);

		expect(events.map((event) => event.type)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.output_item.done",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.output_item.done",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(reasoningDone).toHaveLength(2);
		expect(reasoningDone[0]?.body).toMatchObject({
			output_index: 0,
			item: { type: "reasoning", summary: [{ type: "summary_text", text: "first" }] },
		});
		expect(reasoningDone[1]?.body).toMatchObject({
			output_index: 2,
			item: { type: "reasoning", summary: [{ type: "summary_text", text: "later" }] },
		});
		const firstReasoningItem = reasoningDone[0]?.body.item;
		const secondReasoningItem = reasoningDone[1]?.body.item;
		if (!isRecord(firstReasoningItem) || !isRecord(secondReasoningItem)) {
			throw new TypeError("reasoning done event omitted its item");
		}
		expect(firstReasoningItem.id).not.toBe(secondReasoningItem.id);
		expect(events.at(-1)?.body).toMatchObject({
			response: {
				output: [
					{ type: "reasoning", summary: [{ text: "first" }] },
					{ type: "message", content: [{ text: "answer done" }] },
					{ type: "reasoning", summary: [{ text: "later" }] },
				],
			},
		});
		expect(events.map((event) => event.sequenceNumber)).toEqual(events.map((_event, index) => index));
	});

	test("releases the upstream slot before a client drains EOF after completed", async () => {
		const input = `${chunk({ content: "done" })}\n${chunk({}, "stop")}\n`;
		const harness = makeHarness([encoder.encode(input)], "stall");
		const response = responsesSseAdapter(harness.response, {
			model: "gpt-5.6-sol",
			finalize: harness.finalize,
		});
		const reader = response.body?.getReader();
		if (!reader) throw new TypeError("adapter response has no body");
		let completedSeen = false;

		while (!completedSeen) {
			const next = await reader.read();
			if (next.done) throw new TypeError("stream ended before response.completed");
			completedSeen = parseEvents(new TextDecoder().decode(next.value)).some(
				(event) => event.type === "response.completed",
			);
		}
		await harness.finalized;

		expect(completedSeen).toBe(true);
		expect(harness.state.cancelReasons).toHaveLength(1);
		expect(harness.state.finalizeCount).toBe(1);
	});
});
