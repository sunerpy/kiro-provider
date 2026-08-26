import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";
import { parsedResponses } from "./canonical-test-helpers.js";

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(join(import.meta.dir, "fixtures", name), "utf8"),
	);
}

describe("redacted Codex Responses fixtures", () => {
	test("accepts a first turn containing only exact function/custom declarations", () => {
		const raw = fixture("codex-first-turn.json") as {
			input: Array<{
				type?: string;
				tools?: Array<{ type?: string; format?: unknown }>;
			}>;
			parallel_tool_calls?: boolean;
			text?: unknown;
			reasoning?: { context?: unknown; effort?: unknown };
		};
		for (const item of raw.input) {
			if (item.type === "additional_tools" && item.tools) {
				item.tools = item.tools.filter((tool) => tool.type !== "namespace");
				for (const tool of item.tools) delete tool.format;
			}
		}
		delete raw.parallel_tool_calls;
		delete raw.text;
		if (raw.reasoning) delete raw.reasoning.context;
		raw.input.push({
			type: "message",
			role: "user",
			content: "HELLO_REDACTED",
		} as never);

		const result = responsesToInternalChat(
			parsedResponses(raw),
			"legacy-user-prefix",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.tools.some((tool) => tool.publicType === "custom")).toBe(true);
		expect(result.body.messages.at(-1)?.role).toBe("user");
	});

	test("rejects the Codex custom grammar constraint instead of silently dropping it", () => {
		const result = responsesToInternalChat(
			parsedResponses({
				model: "gpt-5.6-sol",
				input: "q",
				tools: [
					{
						type: "custom",
						name: "exec",
						format: {
							type: "grammar",
							syntax: "lark",
							definition: "CUSTOM_TOOL_GRAMMAR_REDACTED",
						},
					},
				],
			}),
		);
		expect(result).toMatchObject({
			ok: false,
			code: "unsupported_custom_tool_format",
			param: "tools.0.format",
		});
	});

	test("rejects continuation fixtures that omit the original declaration", () => {
		for (const name of [
			"codex-custom-tool-turn.json",
			"codex-tool-turn.json",
			"codex-tool-turn-array.json",
		] as const) {
			const result = responsesToInternalChat(parsedResponses(fixture(name)));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("missing_tool_declaration");
		}
	});

	test("rejects namespace history instead of changing public tool identity", () => {
		const result = responsesToInternalChat(
			parsedResponses(fixture("codex-namespace-tool-turn.json")),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("missing_tool_declaration");
	});
});
