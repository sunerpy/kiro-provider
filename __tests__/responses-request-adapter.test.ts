import { describe, expect, test } from "bun:test";
import { buildCodeWhispererRequest } from "../src/kiro/transform/request-core.js";
import { assistantOutputFingerprint } from "../src/protocol/canonical.js";
import { adaptResponsesRequest } from "../src/server/responses/request-adapter.js";
import {
	parsedResponses,
	TEST_AUTH,
	TEST_MODEL,
} from "./canonical-test-helpers.js";

function adapt(
	raw: unknown,
	mode: "safe" | "legacy-user-prefix" = "safe",
) {
	return adaptResponsesRequest(parsedResponses(raw), mode);
}

function expectFailure(
	raw: unknown,
	code: string,
	param?: string,
): void {
	const result = adapt(raw);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.code).toBe(code);
	if (param !== undefined) expect(result.param).toBe(param);
}

describe("Responses canonical adaptation", () => {
	test("preserves role, message boundary, content block, order, source path, and bytes", () => {
		const result = adapt({
			model: TEST_MODEL,
			input: [
				{ role: "user", content: "first\r\n{" },
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "second-a" },
						{ type: "input_text", text: "second-b" },
					],
				},
				{ role: "assistant", content: "same" },
				{ role: "assistant", content: "same" },
			],
			stream: true,
			store: false,
			tool_choice: "auto",
			prompt_cache_key: "session-1",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "first\r\n{", path: "input.0.content" }],
				toolCalls: [],
				path: "input.0",
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "second-a", path: "input.1.content.0.text" },
					{ type: "text", text: "second-b", path: "input.1.content.1.text" },
				],
				toolCalls: [],
				path: "input.1",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "same", path: "input.2.content" }],
				toolCalls: [],
				path: "input.2",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "same", path: "input.3.content" }],
				toolCalls: [],
				path: "input.3",
			},
		]);
		expect(result.body.stream).toBe(true);
		expect(result.body.promptCacheKey).toBe("session-1");
	});

	test("maps string input directly without a Responses-to-Chat conversion", () => {
		const result = adapt({ model: TEST_MODEL, input: "exact input {" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.protocol).toBe("responses");
		expect(result.body.messages[0]?.content[0]).toEqual({
			type: "text",
			text: "exact input {",
			path: "input",
		});
	});

	test("maps supported reasoning effort explicitly", () => {
		for (const [input, expected] of [
			["minimal", "low"],
			["low", "low"],
			["medium", "medium"],
			["high", "high"],
			["xhigh", "xhigh"],
			["max", "max"],
		] as const) {
			const result = adapt({
				model: TEST_MODEL,
				input: "q",
				reasoning: { effort: input },
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.body.reasoningEffort).toBe(expected);
				expect(result.body.requestedReasoningEffort).toBe(input);
			}
		}
		expectFailure(
			{ model: TEST_MODEL, input: "q", reasoning: { summary: "auto" } },
			"unsupported_reasoning_summary",
			"reasoning.summary",
		);
	});
});

describe("Responses instruction projection", () => {
	test("safe mode rejects top-level instructions and instruction roles", () => {
		expectFailure(
			{ model: TEST_MODEL, instructions: "SYS", input: "q" },
			"unsupported_instruction_projection",
			"instructions",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [{ role: "developer", content: "DEV" }, { role: "user", content: "q" }],
			},
			"unsupported_instruction_projection",
			"input.0",
		);
	});

	test("legacy mode retains only the exact explicit double-newline prefix behavior", () => {
		const result = adapt(
			{
				model: TEST_MODEL,
				instructions: "TOP",
				input: [
					{ role: "developer", content: "DEV" },
					{ role: "user", content: "  q{" },
				],
			},
			"legacy-user-prefix",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const transformed = buildCodeWhispererRequest(
			result.body,
			TEST_MODEL,
			TEST_AUTH,
		);
		expect(
			transformed.request.conversationState.currentMessage.userInputMessage?.content,
		).toBe("TOP\n\nDEV\n\n  q{");
	});
});

describe("Responses exact function/custom tools", () => {
	test("maps function call/result with its original declaration and arguments", () => {
		const result = adapt({
			model: TEST_MODEL,
			tools: [
				{
					type: "function",
					name: "read_file",
					description: "Read one file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
			input: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "read_file",
					arguments: '{"path":"a"}',
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: [
						{ type: "input_text", text: "A" },
						{ type: "output_text", text: "B" },
					],
				},
				{ role: "user", content: "continue" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.tools[0]).toEqual({
			publicType: "function",
			name: "read_file",
			wireName: "read_file",
			description: "Read one file",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			path: "tools.0",
			origin: "request",
			strict: false,
		});
		expect(result.body.messages[0]?.toolCalls[0]).toMatchObject({
			id: "call_1",
			name: "read_file",
			input: { path: "a" },
		});
		expect(result.body.messages[1]?.content[0]).toMatchObject({
			type: "tool_result",
			toolCallId: "call_1",
			content: [
				{ type: "text", text: "A" },
				{ type: "text", text: "B" },
			],
		});
	});

	test("round-trips custom raw input byte-for-byte through a private wire alias", () => {
		const rawInput = "printf 'a\\r\\n{Ω}'\r\n";
		const result = adapt({
			model: TEST_MODEL,
			tools: [{ type: "custom", name: "shell", description: "Run raw input" }],
			input: [
				{
					type: "custom_tool_call",
					call_id: "custom_1",
					name: "shell",
					input: rawInput,
				},
				{
					type: "custom_tool_call_output",
					call_id: "custom_1",
					output: "ok",
				},
				{ role: "user", content: "next" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const declaration = result.body.tools[0];
		expect(declaration?.publicType).toBe("custom");
		expect(declaration?.name).toBe("shell");
		expect(declaration?.wireName).toBe("kiro_custom_0");
		expect(result.body.messages[0]?.toolCalls[0]).toMatchObject({
			id: "custom_1",
			name: "kiro_custom_0",
			input: { input: rawInput },
		});

		const restored = result.bridge.restoreCalls([
			{
				itemId: "item_1",
				id: "new_call",
				name: "kiro_custom_0",
				arguments: JSON.stringify({ input: rawInput }),
			},
		]);
		expect(restored).toEqual({
			ok: true,
			items: [
				{
					id: "item_1",
					type: "custom_tool_call",
					call_id: "new_call",
					name: "shell",
					input: rawInput,
				},
			],
		});
	});

	test("requires exact historical declarations instead of inferring schema", () => {
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "read_file",
						arguments: '{"path":"x"}',
					},
					{
						type: "function_call_output",
						call_id: "call_1",
						output: "x",
					},
				],
			},
			"missing_tool_declaration",
		);
	});
});

describe("Responses reasoning replay input", () => {
	test("accepts a returned reasoning item while treating the opaque kr1 token as authoritative", () => {
		const outputFingerprint = assistantOutputFingerprint({
			text: "answer",
			toolCalls: [],
		});
		const result = adapt({
			model: TEST_MODEL,
			include: ["reasoning.encrypted_content"],
			input: [
				{
					type: "reasoning",
					id: "rs_test",
					status: "completed",
					summary: [{ type: "summary_text", text: "visible summary" }],
					content: [
						{
							type: "reasoning_text",
							reasoning_text: "visible reasoning",
						},
					],
					encrypted_content: "kr1_test-token",
				},
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "next" },
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.includeEncryptedReasoning).toBe(true);
		expect(result.body.reasoningReplays).toEqual([
			{
				lookup: {
					kind: "responses-token",
					encryptedContent: "kr1_test-token",
				},
				outputFingerprint,
				insertBeforeMessage: 0,
				sourceId: "rs_test",
				sourceStatus: "completed",
				path: "input.0",
			},
		]);
	});

	test("rejects plaintext, malformed, and unpaired reasoning replay", () => {
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "plain" }],
					},
					{ role: "assistant", content: "answer" },
					{ role: "user", content: "next" },
				],
			},
			"unsupported_reasoning_plaintext_replay",
			"input.0",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{ type: "reasoning", encrypted_content: "foreign-token" },
					{ role: "assistant", content: "answer" },
					{ role: "user", content: "next" },
				],
			},
			"invalid_reasoning_replay",
			"input.0.encrypted_content",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{ type: "reasoning", encrypted_content: "kr1_token" },
					{ role: "user", content: "next" },
				],
			},
			"invalid_reasoning_replay",
			"input.0",
		);
	});
});

describe("Responses fail-closed capability validation", () => {
	test.each([
		["temperature", 0.2],
		["top_p", 0.9],
		["truncation", "auto"],
		["background", true],
		["max_tool_calls", 2],
		["service_tier", "default"],
	] as const)("rejects unsupported field %s before Kiro", (field, value) => {
		expectFailure(
			{ model: TEST_MODEL, input: "q", [field]: value },
			"unsupported_parameter",
			field,
		);
	});

	test("reports unsupported text controls at their exact field paths", () => {
		expectFailure(
			{ model: TEST_MODEL, input: "q", text: { verbosity: "low" } },
			"unsupported_parameter",
			"text.verbosity",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: "q",
				text: {
					format: {
						type: "json_schema",
						name: "result",
						schema: { type: "object" },
					},
				},
			},
			"unsupported_structured_output",
			"text.format",
		);
		expectFailure(
			{ model: TEST_MODEL, input: "q", text: { unexpected: true } },
			"unsupported_parameter",
			"text.unexpected",
		);
	});

	test("maps only the probe-confirmed Claude output-token range", () => {
		const supported = adapt({
			model: "claude-sonnet-5",
			input: "q",
			max_output_tokens: 4_096,
		});
		expect(supported).toMatchObject({
			ok: true,
			body: { outputTokenLimit: 4_096 },
		});
		expectFailure(
			{ model: TEST_MODEL, input: "q", max_output_tokens: 4_096 },
			"unsupported_output_token_limit",
			"max_output_tokens",
		);
		expectFailure(
			{ model: "claude-sonnet-5", input: "q", max_output_tokens: 1_023 },
			"invalid_output_token_limit",
			"max_output_tokens",
		);
	});

	test("rejects unknown items/content, author-recipient semantics, and built-in tools", () => {
		expectFailure(
			{ model: TEST_MODEL, input: [{ type: "file_search_call", id: "x" }] },
			"unsupported_input_item",
			"input.0",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_file", file_id: "f" }],
					},
				],
			},
			"unsupported_content_part",
			"input.0.content.0",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{
						type: "agent_message",
						author: "root",
						recipient: "worker",
						content: [{ type: "input_text", text: "task" }],
					},
				],
			},
			"unsupported_input_item",
			"input.0",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: "search",
				tools: [{ type: "web_search_preview" }],
			},
			"unsupported_web_search",
			"tools.0",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: "q",
				tools: [{ type: "namespace", name: "ns", tools: [] }],
			},
			"unsupported_tool_type",
			"tools.0",
		);
	});

	test("rejects strict tools, custom grammar, unknown nested fields, and ambiguous schemas", () => {
		expectFailure(
			{
				model: TEST_MODEL,
				input: "q",
				tools: [{ type: "function", name: "f", strict: true }],
			},
			"unsupported_strict_tools",
			"tools.0.strict",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: "q",
				tools: [
					{
						type: "custom",
						name: "shell",
						format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
					},
				],
			},
			"unsupported_custom_tool_format",
			"tools.0.format",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [{ role: "user", content: "q", unexpected: true }],
			},
			"unsupported_parameter",
			"input.0.unexpected",
		);
		expectFailure(
			{
				model: TEST_MODEL,
				input: [
					{
						type: "additional_tools",
						role: "developer",
						tools: [
							{
								type: "function",
								name: "f",
								parameters: { type: "object" },
								inputSchema: { type: "object" },
							},
						],
					},
					{ role: "user", content: "q" },
				],
			},
			"invalid_tool_declaration",
			"input.0.tools.0",
		);
	});

	test("rejects stateful continuation and non-equivalent tool controls", () => {
		expectFailure(
			{ model: TEST_MODEL, input: "q", previous_response_id: "resp_1" },
			"unsupported_stateful_responses",
			"previous_response_id",
		);
		expectFailure(
			{ model: TEST_MODEL, input: "q", tool_choice: "required" },
			"unsupported_tool_choice",
			"tool_choice",
		);
		const noTools = adapt({
			model: TEST_MODEL,
			input: "q",
			parallel_tool_calls: false,
		});
		expect(noTools.ok).toBe(true);
		expectFailure(
			{
				model: TEST_MODEL,
				input: "q",
				parallel_tool_calls: false,
				tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
			},
			"unsupported_parallel_tool_calls",
			"parallel_tool_calls",
		);
	});

	test("supports tool_choice=none only without an unfinished tool state", () => {
		const supported = adapt({
			model: TEST_MODEL,
			input: "q",
			tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
			tool_choice: "none",
		});
		expect(supported.ok).toBe(true);
		if (supported.ok) expect(supported.body.toolChoice).toBe("none");

		expectFailure(
			{
				model: TEST_MODEL,
				tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
				input: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "f",
						arguments: "{}",
					},
				],
				tool_choice: "none",
			},
			"unsupported_tool_choice",
			"tool_choice",
		);
	});
});
