import { describe, expect, test } from "bun:test";
import {
	parseChatCompletionRequest,
	ResponsesRequestSchema,
} from "../src/server/request-schema.js";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";

describe("OpenCode Responses request contract", () => {
	test("accepts AI SDK easy input messages without a type discriminator", () => {
		const parsed = ResponsesRequestSchema.parse({
			model: "auto",
			input: [
				{ role: "system", content: "Client supplied system instruction" },
				{
					role: "user",
					content: [{ type: "input_text", text: "Hello from OpenCode" }],
				},
			],
			max_output_tokens: 32_000,
			store: false,
			prompt_cache_key: "opencode-session",
			tools: [
				{
					type: "function",
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
					strict: true,
				},
			],
			tool_choice: "auto",
			stream: true,
		});

		const adapted = responsesToInternalChat(parsed);
		expect(adapted.ok).toBe(true);
		if (!adapted.ok) return;

		expect(adapted.body.messages).toEqual([
			{ role: "system", content: "Client supplied system instruction" },
			{
				role: "user",
				content: [{ type: "text", text: "Hello from OpenCode" }],
			},
		]);
		expect(parseChatCompletionRequest(adapted.body).ok).toBe(true);
		expect(adapted.body.tools?.[0]).toMatchObject({
			type: "function",
			function: { name: "read" },
		});
	});
});
