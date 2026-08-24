import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import { ResponsesRequestSchema } from "../src/server/request-schema.js";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";

const REQUEST_ADAPTER_FILES = [
	"src/kiro/transform/history-builder.ts",
	"src/kiro/transform/request-core.ts",
	"src/server/responses/request-adapter.ts",
	"src/server/responses/tool-bridge.ts",
	"src/server/anthropic/request-adapter.ts",
] as const;

const FORBIDDEN_PROVIDER_PROMPTS = [
	"[system:",
	"Tool results provided.",
	"Running tools",
	"I will execute",
	"[Output for tool call",
	"[tool_error]",
	"Delegated task boundary",
	"Current delegated task",
	"Complete raw custom-tool payload",
	"Format syntax:",
	"<thinking_mode>",
] as const;

describe("zero hidden prompt invariant", () => {
	test("request adapters contain no provider-owned synthetic prompt literals", async () => {
		const sources = await Promise.all(
			REQUEST_ADAPTER_FILES.map((file) =>
				Bun.file(join(import.meta.dir, "..", file)).text(),
			),
		);
		const combined = sources.join("\n");

		for (const forbidden of FORBIDDEN_PROVIDER_PROMPTS) {
			expect(combined).not.toContain(forbidden);
		}
	});

	test("Responses keeps client plaintext but never exposes encrypted replay as text", () => {
		const parsed = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: [
				{
					type: "agent_message",
					author: "/root",
					recipient: "/root/worker",
					content: [
						{ type: "input_text", text: "CLIENT_TASK_TEXT" },
						{
							type: "encrypted_content",
							encrypted_content: "OPAQUE_REASONING_CIPHERTEXT",
						},
					],
				},
			],
		});
		const adapted = responsesToInternalChat(parsed);
		if (!adapted.ok) throw new TypeError("fixture must adapt");
		const serialized = JSON.stringify(adapted.body);

		expect(serialized).toContain("CLIENT_TASK_TEXT");
		expect(serialized).not.toContain("OPAQUE_REASONING_CIPHERTEXT");
		for (const forbidden of FORBIDDEN_PROVIDER_PROMPTS) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	test("Anthropic preserves error status structurally without adding error prose", () => {
		const adapted = adaptAnthropicMessagesRequest({
			model: "claude-opus-4-8",
			max_tokens: 128,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: "CLIENT_TOOL_ERROR",
							is_error: true,
						},
					],
				},
			],
		});
		if (!adapted.ok) throw new TypeError("fixture must adapt");

		expect(JSON.stringify(adapted.value.body)).toContain("CLIENT_TOOL_ERROR");
		expect(JSON.stringify(adapted.value.body)).not.toContain("[tool_error]");
	});
});
