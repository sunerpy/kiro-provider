import { describe, expect, test } from "bun:test";
import { assistantLineageFingerprint } from "../src/protocol/canonical.js";
import { adaptAnthropicMessagesRequest } from "../src/server/anthropic/request-adapter.js";
import {
	ChatCompletionRequestSchema,
	ResponsesRequestSchema,
} from "../src/server/request-schema.js";
import {
	anthropicSessionAffinity,
	canonicalSessionLineage,
	chatSessionAffinity,
	responsesSessionAffinity,
} from "../src/server/session-affinity.js";
import { canonicalRequest, message } from "./canonical-test-helpers.js";

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

	test("uses standard Responses metadata for a Zuno session", () => {
		const first = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "same first turn",
			metadata: { zuno_session_id: "session-a" },
		});
		const later = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "later turn",
			metadata: { zuno_session_id: "session-a" },
		});
		const other = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "same first turn",
			metadata: { zuno_session_id: "session-b" },
		});

		expect(responsesSessionAffinity(first, TENANT)).toEqual(
			responsesSessionAffinity(later, TENANT),
		);
		expect(responsesSessionAffinity(first, TENANT)?.source).toBe(
			"responses.metadata.zuno_session_id",
		);
		expect(responsesSessionAffinity(first, TENANT)?.keyHash).not.toBe(
			responsesSessionAffinity(other, TENANT)?.keyHash,
		);
	});

	test("does not infer affinity from identical initial input in explicit-only mode", () => {
		const responses = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: "identical request",
		});
		const chat = ChatCompletionRequestSchema.parse({
			model: "gpt-5.6-sol",
			messages: [{ role: "user", content: "identical request" }],
		});
		const anthropic = adaptAnthropicMessagesRequest({
			model: "claude-opus-4-8",
			messages: [{ role: "user", content: "identical request" }],
			metadata: { user_id: "same-user" },
		});
		if (!anthropic.ok) throw new TypeError("fixture must adapt");

		expect(responsesSessionAffinity(responses, TENANT)).toBeUndefined();
		expect(chatSessionAffinity(chat, TENANT)).toBeUndefined();
		expect(
			anthropicSessionAffinity(anthropic.value.source, TENANT),
		).toBeUndefined();
	});

	test("keeps Chat fallback affinity stable only in legacy mode", () => {
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

		expect(chatSessionAffinity(first, TENANT, "legacy-initial-input")).toEqual(
			chatSessionAffinity(later, TENANT, "legacy-initial-input"),
		);
		expect(chatSessionAffinity(first, TENANT, "legacy-initial-input")?.source).toBe(
			"chat.initial_input",
		);
	});

	test("treats untyped Responses input items as messages in legacy mode", () => {
		const typed = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: [
				{ type: "message", role: "system", content: "system prompt" },
				{ type: "message", role: "user", content: "initial request" },
			],
		});
		const untyped = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "initial request" },
			],
		});
		const laterTurn = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "initial request" },
				{ role: "assistant", content: "first answer" },
				{ role: "user", content: "follow-up" },
			],
		});
		const otherUser = ResponsesRequestSchema.parse({
			model: "gpt-5.6-sol",
			input: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "different request" },
			],
		});

		const typedHint = responsesSessionAffinity(typed, TENANT, "legacy-initial-input");
		const untypedHint = responsesSessionAffinity(untyped, TENANT, "legacy-initial-input");
		expect(untypedHint?.source).toBe("responses.initial_input");
		expect(untypedHint).toEqual(
			responsesSessionAffinity(laterTurn, TENANT, "legacy-initial-input"),
		);
		expect(untypedHint?.keyHash).not.toBe(
			responsesSessionAffinity(otherUser, TENANT, "legacy-initial-input")?.keyHash,
		);
		expect(typedHint?.keyHash).not.toBe(untypedHint?.keyHash);
	});

	test("combines Anthropic metadata.user_id with initial input only in legacy mode", () => {
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

		expect(anthropicSessionAffinity(first.value.source, TENANT, "legacy-initial-input")).toEqual(
			anthropicSessionAffinity(later.value.source, TENANT, "legacy-initial-input"),
		);
		expect(
			anthropicSessionAffinity(first.value.source, TENANT, "legacy-initial-input")?.source,
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

	test("derives standard-client continuation affinity from the latest assistant output", () => {
		const first = canonicalRequest([message("user", "first turn")], {
			protocol: "responses",
			model: "gpt-5.6-sol",
		});
		const second = canonicalRequest(
			[
				message("user", "first turn"),
				message("assistant", "first answer"),
				message("user", "follow-up"),
			],
			{ protocol: "responses", model: "gpt-5.6-sol" },
		);
		const firstLineage = canonicalSessionLineage(first, TENANT);
		const secondLineage = canonicalSessionLineage(second, TENANT);
		if (!firstLineage || !secondLineage) {
			throw new TypeError("lineage fixtures must resolve");
		}

		expect(firstLineage.lookupKeyHash).toBeUndefined();
		expect(secondLineage.lookupKeyHash).toBe(
			firstLineage.outputKeyHash(
				assistantLineageFingerprint(first, {
					text: "first answer",
					toolCalls: [],
				}),
			),
		);
	});
});
