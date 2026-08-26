import { describe, expect, test } from "bun:test";
import { DialectGate } from "../src/kiro/transform/streaming/dialect-gate.js";

const MODEL_VISIBLE_SAMPLES = [
	'before <invoke name="read"><parameter name="path">/tmp/x</parameter></invoke> after',
	'<｜DSML｜function_calls name="grep" {"pattern":"foo"}',
	'ok [Called search with args: {"q":"cats"}] done',
	"<thinking>literal model text</thinking>",
] as const;

describe("model text is never reinterpreted as protocol structure", () => {
	test.each(MODEL_VISIBLE_SAMPLES.map((text) => [text]))(
		"preserves exact text: %s",
		(text: string) => {
			const gate = new DialectGate();
			expect(gate.ingest(text)).toBe(text);
			expect(gate.finalize()).toEqual({ toolCalls: [], remainderText: "" });
		},
	);

	test("stream gate is a byte-preserving no-op", () => {
		const gate = new DialectGate();
		const first = "answer <inv";
		const second = 'oke name="read">x</invoke> {';

		expect(gate.ingest(first)).toBe(first);
		expect(gate.ingest(second)).toBe(second);
		expect(gate.suppressing).toBe(false);
		expect(gate.finalize()).toEqual({ toolCalls: [], remainderText: "" });
	});
});
