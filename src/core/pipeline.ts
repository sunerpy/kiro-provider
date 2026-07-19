import {
	GenerateAssistantResponseCommand,
	type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { EffortSchema } from "../kiro/regions.js";
import { transformToSdkRequest } from "../kiro/transform/request-sdk.js";
import { collectSdkResponse } from "../kiro/transform/sdk-collector.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { openAiError } from "../server/errors.js";
import { classifyError, normalizeSdkError } from "./error-classifier.js";
import {
	abortable,
	abortableSleep,
	abortReason,
	acquirePipelineQueue,
	createPipelineDeadline,
} from "./pipeline-runtime.js";
import { createPipelineStreamResponse } from "./pipeline-stream.js";
import { resolveProxyUrl } from "./proxy.js";
import type { RunChatCompletionOptions } from "./pipeline-types.js";
import { createSdkClient } from "./sdk-client.js";

export type {
	PipelineAccountManager,
	PipelineClientFactory,
	PipelineSdkClient,
	PipelineTokenRefresher,
	RunChatCompletionOptions,
} from "./pipeline-types.js";

type CompletionResult =
	| { readonly kind: "response"; readonly response: Response }
	| {
			readonly kind: "stream";
			readonly sdkResponse: SdkStreamResponse;
			readonly model: string;
			readonly conversationId: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSdkCommandInput(
	value: unknown,
): value is GenerateAssistantResponseCommandInput {
	if (!isRecord(value)) return false;
	const conversationState = value.conversationState;
	return (
		isRecord(conversationState) &&
		typeof conversationState.conversationId === "string" &&
		isRecord(conversationState.currentMessage) &&
		typeof conversationState.chatTriggerType === "string"
	);
}

function thinkingOptions(
	body: unknown,
	model: string,
): { readonly think: boolean; readonly budget: number } {
	const parsed = typeof body === "string" ? JSON.parse(body) : body;
	if (!isRecord(parsed))
		return { think: model.endsWith("-thinking"), budget: 20_000 };
	const providerOptions = parsed.providerOptions;
	const providerThinking = isRecord(providerOptions)
		? providerOptions.thinkingConfig
		: undefined;
	const directThinking = parsed.thinkingConfig;
	const thinking = isRecord(providerThinking)
		? providerThinking
		: isRecord(directThinking)
			? directThinking
			: undefined;
	const requestedBudget = thinking?.thinkingBudget ?? thinking?.budget_tokens;
	return {
		think: model.endsWith("-thinking") || thinking !== undefined,
		budget: typeof requestedBudget === "number" ? requestedBudget : 20_000,
	};
}

function terminalError(
	status: number,
	message: string,
	code?: string,
): Response {
	return openAiError(status, message, "upstream_error", code);
}

async function executeLoop(
	options: RunChatCompletionOptions,
	signal: AbortSignal,
): Promise<CompletionResult> {
	const { think, budget } = thinkingOptions(options.body, options.model);
	const forcedRefreshAccountIds = new Set<string>();
	const serverErrors = new Map<string, number>();
	let retryCount = 0;
	let iterations = 0;

	while (true) {
		if (signal.aborted) throw abortReason(signal);
		iterations += 1;
		if (iterations > options.config.max_request_iterations) {
			return {
				kind: "response",
				response: openAiError(
					500,
					`Exceeded max iterations (${options.config.max_request_iterations})`,
					"request_error",
					"max_request_iterations",
				),
			};
		}

		options.accountManager.reconcileFromDb();
		const selected = options.accountManager.selectHealthyAccount();
		if (!selected) {
			return {
				kind: "response",
				response: openAiError(
					503,
					"All accounts are unhealthy or rate-limited",
					"service_unavailable",
					"no_healthy_accounts",
				),
			};
		}

		const initialAuth = options.accountManager.toAuthDetails(selected);
		const account = await abortable(
			options.tokenRefresher.refreshIfNeeded(selected, initialAuth, signal),
			signal,
		);
		const auth = options.accountManager.toAuthDetails(account);
		const parsedEffort = EffortSchema.safeParse(options.config.effort);
		const prepared = transformToSdkRequest(
			options.body,
			options.model,
			auth,
			think,
			budget,
			{
				autoEffortMapping: options.config.auto_effort_mapping,
				...(parsedEffort.success ? { effort: parsedEffort.data } : {}),
			},
		);
		const makeClient = options.makeClient ?? createSdkClient;
		const client = makeClient(
			auth,
			prepared.region,
				prepared.effort,
				options.config.test_upstream_endpoint,
				resolveProxyUrl(options.config),
			);
		const commandInput: unknown = {
			conversationState: prepared.conversationState,
			...(prepared.profileArn ? { profileArn: prepared.profileArn } : {}),
		};
		if (!isSdkCommandInput(commandInput)) {
			throw new TypeError(
				"Transformed request is not a valid SDK command input",
			);
		}
		const command = new GenerateAssistantResponseCommand(commandInput);

		try {
			const sdkResponse = await abortable(
				client.send(command, { abortSignal: signal }),
				signal,
			);
			if (options.stream) {
				return {
					kind: "stream",
					sdkResponse,
					model: options.model,
					conversationId: prepared.conversationId,
				};
			}
			const completion = await collectSdkResponse(
				sdkResponse,
				options.model,
				prepared.conversationId,
				signal,
			);
			if (signal.aborted) throw abortReason(signal);
			return {
				kind: "response",
				response: Response.json(completion, {
					headers: { "Content-Type": "application/json" },
				}),
			};
		} catch (caught) {
			if (signal.aborted) throw abortReason(signal);
			const error = normalizeSdkError(caught);
			const serverErrorCount =
				error.status === 500 ? (serverErrors.get(account.id) ?? 0) + 1 : 0;
			if (error.status === 500) serverErrors.set(account.id, serverErrorCount);
			const classification = classifyError(error, {
				accountId: account.id,
				accountCount: options.accountManager.getAccountCount(),
				retryCount,
				maxRetries: options.config.rate_limit_max_retries,
				serverErrorCount,
				retryDelayMs: options.config.rate_limit_retry_delay_ms,
				forcedRefreshAccountIds,
			});

			switch (classification.action) {
				case "refresh-then-retry":
					await abortable(
						options.tokenRefresher.forceRefresh(account, signal),
						signal,
					);
					continue;
				case "retry":
					retryCount += 1;
					await abortableSleep(classification.retryAfterMs ?? 0, signal);
					continue;
			case "switch":
				if (error.reason === "TEMPORARILY_SUSPENDED") {
					options.accountManager.markUnhealthy(
						account,
						`InvalidTokenException: Account Suspended: ${error.message}`,
					);
				} else {
					options.accountManager.markRateLimited(
						account,
						Date.now() +
							(classification.retryAfterMs ??
								options.config.rate_limit_retry_delay_ms),
					);
				}
				continue;
				case "fail":
					if (error.reason === "TEMPORARILY_SUSPENDED") {
						options.accountManager.markUnhealthy(
							account,
							`InvalidTokenException: Account Suspended: ${error.message}`,
						);
					}
					return {
						kind: "response",
						response: terminalError(
							classification.terminalStatus ?? classification.status ?? 500,
							error.message,
							error.code,
						),
					};
			}
		}
	}
}

/**
 * Runs one OpenAI chat completion through the serialized Kiro SDK pipeline.
 * The optional deadlineSignal is the single ingress signal passed unchanged to
 * queue waiting, refresh, retry sleeps, SDK send, and response consumption.
 */
export async function runChatCompletion(
	options: RunChatCompletionOptions,
): Promise<Response> {
	const deadline = createPipelineDeadline(
		options.deadlineSignal,
		options.config.request_timeout_ms,
	);
	let release: (() => void) | undefined;
	let streamOwnsResources = false;
	try {
		release = await acquirePipelineQueue(deadline.signal);
		const result = await executeLoop(options, deadline.signal);
		if (result.kind === "response") return result.response;

		const streamRelease = release;
		release = undefined;
		streamOwnsResources = true;
		return createPipelineStreamResponse(
			result,
			deadline.signal,
			options.config.stream_idle_timeout_ms,
			() => {
				streamRelease();
				deadline.dispose();
			},
		);
	} catch (error) {
		if (deadline.signal.aborted) {
			return openAiError(
				504,
				"Request deadline exceeded",
				"timeout_error",
				"request_timeout",
			);
		}
		const normalized = normalizeSdkError(error);
		return openAiError(
			500,
			normalized.message,
			"internal_error",
			normalized.code,
		);
	} finally {
		if (!streamOwnsResources) {
			release?.();
			deadline.dispose();
		}
	}
}
