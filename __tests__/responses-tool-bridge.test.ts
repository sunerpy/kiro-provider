import { describe, expect, test } from "bun:test";
import { createResponsesToolBridge } from "../src/server/responses/tool-bridge.js";
import { parsedResponses } from "./canonical-test-helpers.js";

describe("ResponsesToolBridge exact declarations", () => {
	test("restores function and custom calls atomically", () => {
		const built = createResponsesToolBridge(
			parsedResponses({
				model: "auto",
				input: "q",
				tools: [
					{ type: "function", name: "read", parameters: { type: "object" } },
					{ type: "custom", name: "shell" },
				],
			}),
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;

		const result = built.bridge.restoreCalls([
			{
				itemId: "item_f",
				id: "call_f",
				name: "read",
				arguments: "",
			},
			{
				itemId: "item_c",
				id: "call_c",
				name: "kiro_custom_0",
				arguments: '{"input":"printf \\u03a9"}',
			},
		]);

		expect(result).toEqual({
			ok: true,
			items: [
				{
					id: "item_f",
					type: "function_call",
					call_id: "call_f",
					name: "read",
					arguments: "{}",
				},
				{
					id: "item_c",
					type: "custom_tool_call",
					call_id: "call_c",
					name: "shell",
					input: "printf Ω",
				},
			],
		});
	});

	test("rejects malformed custom wrappers and undeclared upstream tools", () => {
		const built = createResponsesToolBridge(
			parsedResponses({
				model: "auto",
				input: "q",
				tools: [{ type: "custom", name: "shell" }],
			}),
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;

		expect(
			built.bridge.restoreCalls([
				{
					itemId: "item",
					id: "call",
					name: "kiro_custom_0",
					arguments: '{"input":"ok","extra":true}',
				},
			]),
		).toMatchObject({ ok: false, code: "invalid_custom_tool_input" });
		expect(
			built.bridge.restoreCalls([
				{
					itemId: "item",
					id: "call",
					name: "undeclared",
					arguments: "{}",
				},
			]),
		).toMatchObject({ ok: false, code: "unknown_tool_alias" });
	});

	test("rejects orphan, duplicate, mismatched, and undeclared history", () => {
		for (const [input, code] of [
			[
				[{ type: "function_call_output", call_id: "x", output: "orphan" }],
				"invalid_tool_history",
			],
			[
				[
					{ type: "function_call", call_id: "x", name: "f", arguments: "{}" },
					{ type: "function_call", call_id: "x", name: "f", arguments: "{}" },
				],
				"invalid_tool_history",
			],
			[
				[
					{ type: "custom_tool_call", call_id: "x", name: "c", input: "raw" },
					{ type: "function_call_output", call_id: "x", output: "wrong" },
				],
				"invalid_tool_history",
			],
			[
				[
					{ type: "function_call", call_id: "x", name: "f", arguments: "{}" },
					{ type: "function_call_output", call_id: "x", output: "ok" },
				],
				"missing_tool_declaration",
			],
		] as const) {
			const built = createResponsesToolBridge(
				parsedResponses({ model: "auto", input }),
			);
			expect(built.ok).toBe(false);
			if (!built.ok) expect(built.code).toBe(code);
		}
	});
});
