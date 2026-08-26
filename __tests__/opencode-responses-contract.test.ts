import { describe, expect, test } from "bun:test";
import { responsesToInternalChat } from "../src/server/responses/request-adapter.js";
import { parsedResponses } from "./canonical-test-helpers.js";

describe("OpenCode Responses request contract", () => {
	test("accepts AI SDK easy input messages when the request stays in the verified subset", () => {
		const result = responsesToInternalChat(
			parsedResponses({
				model: "auto",
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: "Hello from OpenCode" }],
					},
				],
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
					},
				],
				tool_choice: "auto",
				stream: true,
			}),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Hello from OpenCode" }],
		});
		expect(result.body.tools[0]).toMatchObject({
			publicType: "function",
			name: "read",
			wireName: "read",
		});
	});

	test("safe mode fails closed for OpenCode system input and max output limits", () => {
		const instruction = responsesToInternalChat(
			parsedResponses({
				model: "auto",
				input: [
					{ role: "system", content: "Client supplied system instruction" },
					{ role: "user", content: "Hello" },
				],
			}),
		);
		expect(instruction).toMatchObject({
			ok: false,
			code: "unsupported_instruction_projection",
			param: "input.0",
		});

		const outputLimit = responsesToInternalChat(
			parsedResponses({ model: "auto", input: "Hello", max_output_tokens: 32_000 }),
		);
		expect(outputLimit).toMatchObject({
			ok: false,
			code: "unsupported_output_token_limit",
			param: "max_output_tokens",
		});
	});
});
