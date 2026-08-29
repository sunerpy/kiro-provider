import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";
import {
	type CanonicalRequest,
	latestAssistantLineageFingerprint,
} from "../protocol/canonical.js";
import type { AnthropicMessagesRequest } from "./anthropic/request-adapter.js";
import type {
	ChatCompletionRequest,
	ResponsesInputItem,
	ResponsesRequest,
} from "./request-schema.js";

export interface SessionAffinityHint {
	readonly keyHash: string;
	readonly source:
		| "responses.metadata.zuno_session_id"
		| "responses.metadata.kiro_provider_session_id"
		| "responses.client_metadata.thread_id"
		| "responses.client_metadata.session_id"
		| "responses.client_metadata.conversation_id"
		| "responses.prompt_cache_key"
		| "responses.initial_input"
		| "chat.prompt_cache_key"
		| "chat.user_and_initial_input"
		| "chat.initial_input"
		| "anthropic.user_and_initial_input"
		| "anthropic.initial_input";
}

export type SessionAffinityMode = Config["session_affinity_mode"];

export interface SessionLineageHint {
	readonly lookupKeyHash?: string;
	readonly source:
		| "responses.history_lineage"
		| "chat.history_lineage"
		| "anthropic.history_lineage";
	readonly outputKeyHash: (outputFingerprint: string) => string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
		.join(",")}}`;
}

function affinityHash(
	tenantId: string,
	protocol: "responses" | "chat" | "anthropic",
	source: SessionAffinityHint["source"],
	value: unknown,
): SessionAffinityHint {
	return {
		keyHash: createHash("sha256")
			.update("kiro-provider-session-affinity-v1\0")
			.update(tenantId)
			.update("\0")
			.update(protocol)
			.update("\0")
			.update(source)
			.update("\0")
			.update(stableJson(value))
			.digest("hex"),
		source,
	};
}

function lineageHash(
	tenantId: string,
	protocol: "responses" | "chat" | "anthropic",
	model: string,
	outputFingerprint: string,
): string {
	return createHash("sha256")
		.update("kiro-provider-output-lineage-v1\0")
		.update(tenantId)
		.update("\0")
		.update(protocol)
		.update("\0")
		.update(model)
		.update("\0")
		.update(outputFingerprint)
		.digest("hex");
}

export function canonicalSessionLineage(
	request: CanonicalRequest,
	tenantId: string | undefined,
): SessionLineageHint | undefined {
	if (!tenantId) return undefined;
	const protocol =
		request.protocol === "chat-completions"
			? "chat"
			: request.protocol === "anthropic-messages"
				? "anthropic"
				: "responses";
	const source = `${protocol}.history_lineage` as SessionLineageHint["source"];
	const previousOutput = latestAssistantLineageFingerprint(request);
	return {
		...(previousOutput !== undefined
			? {
					lookupKeyHash: lineageHash(
						tenantId,
						protocol,
						request.model,
						previousOutput,
					),
				}
			: {}),
		source,
		outputKeyHash: (outputFingerprint) =>
			lineageHash(tenantId, protocol, request.model, outputFingerprint),
	};
}

function nonEmptyMetadataValue<const Field extends string>(
	metadata: unknown,
	field: Field,
): string | undefined {
	if (!isRecord(metadata)) return undefined;
	const value = metadata[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function initialResponsesInput(input: ResponsesRequest["input"]): unknown {
	if (typeof input === "string") return { role: "user", content: input };
	const preferred = input.find(
		(item): item is ResponsesInputItem =>
			item.type === "message" && item.role === "user",
	);
	return preferred ?? input[0];
}

function initialChatInput(request: ChatCompletionRequest): unknown {
	return (
		request.messages.find((message) => message.role === "user") ??
		request.messages[0]
	);
}

function initialAnthropicInput(request: AnthropicMessagesRequest): unknown {
	return (
		request.messages.find((message) => message.role === "user") ??
		request.messages[0]
	);
}

export function responsesSessionAffinity(
	request: ResponsesRequest,
	tenantId: string | undefined,
	mode: SessionAffinityMode = "explicit-only",
): SessionAffinityHint | undefined {
	if (!tenantId) return undefined;
	for (const field of [
		"zuno_session_id",
		"kiro_provider_session_id",
	] as const) {
		const value = nonEmptyMetadataValue(request.metadata, field);
		if (value !== undefined) {
			const source = `responses.metadata.${field}` as const;
			return affinityHash(tenantId, "responses", source, value);
		}
	}
	for (const field of [
		"thread_id",
		"session_id",
		"conversation_id",
	] as const) {
		const value = nonEmptyMetadataValue(request.client_metadata, field);
		if (value !== undefined) {
			const source = `responses.client_metadata.${field}` as const;
			return affinityHash(tenantId, "responses", source, value);
		}
	}
	if (request.prompt_cache_key && request.prompt_cache_key.length > 0) {
		return affinityHash(
			tenantId,
			"responses",
			"responses.prompt_cache_key",
			request.prompt_cache_key,
		);
	}
	if (mode !== "legacy-initial-input") return undefined;
	const initial = initialResponsesInput(request.input);
	return initial === undefined
		? undefined
		: affinityHash(
				tenantId,
				"responses",
				"responses.initial_input",
				initial,
			);
}

export function chatSessionAffinity(
	request: ChatCompletionRequest,
	tenantId: string | undefined,
	mode: SessionAffinityMode = "explicit-only",
): SessionAffinityHint | undefined {
	if (!tenantId) return undefined;
	if (request.prompt_cache_key && request.prompt_cache_key.length > 0) {
		return affinityHash(
			tenantId,
			"chat",
			"chat.prompt_cache_key",
			request.prompt_cache_key,
		);
	}
	if (mode !== "legacy-initial-input") return undefined;
	const initial = initialChatInput(request);
	if (initial === undefined) return undefined;
	if (request.user && request.user.length > 0) {
		return affinityHash(
			tenantId,
			"chat",
			"chat.user_and_initial_input",
			{ user: request.user, initial },
		);
	}
	return affinityHash(tenantId, "chat", "chat.initial_input", initial);
}

export function anthropicSessionAffinity(
	request: AnthropicMessagesRequest,
	tenantId: string | undefined,
	mode: SessionAffinityMode = "explicit-only",
): SessionAffinityHint | undefined {
	if (!tenantId) return undefined;
	if (mode !== "legacy-initial-input") return undefined;
	const initial = initialAnthropicInput(request);
	if (initial === undefined) return undefined;
	const userId = request.metadata?.user_id;
	if (userId) {
		return affinityHash(
			tenantId,
			"anthropic",
			"anthropic.user_and_initial_input",
			{ userId, initial },
		);
	}
	return affinityHash(
		tenantId,
		"anthropic",
		"anthropic.initial_input",
		initial,
	);
}
