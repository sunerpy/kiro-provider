import { describe, expect, test } from "bun:test";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import {
	ChatCompletionRequestSchema,
	ResponsesRequestSchema,
} from "../src/server/request-schema.js";
import {
	anthropicSessionAffinity,
	chatSessionAffinity,
	responsesSessionAffinity,
} from "../src/server/session-affinity.js";

const TENANT = "tenant-a";

describe("standard-field session affinity", () => {
	test("uses Responses client_metadata thread_id ahead of changing turn content", () => {
		const first = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "first turn",
			client_metadata: { thread_id: "thread-1" },
		});
		const second = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "second turn",
			client_metadata: { thread_id: "thread-1" },
		});

		expect(responsesSessionAffinity(first, TENANT)).toEqual(
			responsesSessionAffinity(second, TENANT),
		);
		expect(responsesSessionAffinity(first, TENANT)?.source).toBe(
			"responses.client_metadata.thread_id",
		);
	});

	test("uses the standard Responses prompt_cache_key when metadata has no session id", () => {
		const first = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "first turn",
			prompt_cache_key: "codex-thread-key",
			client_metadata: { source: "codex" },
		});
		const second = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "later turn",
			prompt_cache_key: "codex-thread-key",
		});

		expect(responsesSessionAffinity(first, TENANT)).toEqual(
			responsesSessionAffinity(second, TENANT),
		);
		expect(responsesSessionAffinity(first, TENANT)?.source).toBe(
			"responses.prompt_cache_key",
		);
	});

	test("keeps Chat fallback affinity stable as full transcript history grows", () => {
		const first = ChatCompletionRequestSchema.parse({
			model: "gpt-5.6-sol",
			messages: [{ role: "user", content: "initial request" }],
		});
		const later = ChatCompletionRequestSchema.parse({
			model: "gpt-5.6-sol",
			messages: [
				{ role: "user", content: "initial request" },
				{ role: "assistant", content: "first answer" },
				{ role: "user", content: "follow-up" },
			],
		});

		expect(chatSessionAffinity(first, TENANT)).toEqual(
			chatSessionAffinity(later, TENANT),
		);
		expect(chatSessionAffinity(first, TENANT)?.source).toBe(
			"chat.initial_input",
		);
	});

	test("combines Anthropic metadata.user_id with the initial user turn", () => {
		const first = adaptAnthropicMessagesRequest({
			model: "claude-opus-4-8",
			messages: [{ role: "user", content: "initial request" }],
			metadata: { user_id: "standard-user-id" },
		});
		const later = adaptAnthropicMessagesRequest({
			model: "claude-opus-4-8",
			messages: [
				{ role: "user", content: "initial request" },
				{ role: "assistant", content: "answer" },
				{ role: "user", content: "follow-up" },
			],
			metadata: { user_id: "standard-user-id" },
		});
		if (!first.ok || !later.ok) throw new TypeError("fixtures must adapt");

		expect(anthropicSessionAffinity(first.value.source, TENANT)).toEqual(
			anthropicSessionAffinity(later.value.source, TENANT),
		);
		expect(
			anthropicSessionAffinity(first.value.source, TENANT)?.source,
		).toBe("anthropic.user_and_initial_input");
	});

	test("isolates identical standard session fields by authenticated API key tenant", () => {
		const request = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "hello",
			prompt_cache_key: "same-key",
		});

		expect(responsesSessionAffinity(request, "tenant-a")?.keyHash).not.toBe(
			responsesSessionAffinity(request, "tenant-b")?.keyHash,
		);
		expect(responsesSessionAffinity(request, undefined)).toBeUndefined();
	});
});
