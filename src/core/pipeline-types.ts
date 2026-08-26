import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import type { Config } from "../config/schema.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { Effort, KiroAuthDetails, ManagedAccount } from "../kiro/types.js";
import type { CanonicalRequest } from "../protocol/canonical.js";
import type { ReasoningReplayStore } from "../reasoning/replay-store.js";
import type { createPipelineStreamResponse } from "./pipeline-stream.js";

export interface PipelineAccountManager {
	reconcileFromDb(): readonly ManagedAccount[];
	selectHealthyAccount(preferredAccountId?: string): ManagedAccount | null;
	getAccountCount(): number;
	toAuthDetails(account: ManagedAccount): KiroAuthDetails;
	markRateLimited(account: ManagedAccount, resetTime: number): unknown;
	markUnhealthy(
		account: ManagedAccount,
		reason: string,
		recoveryTime?: number,
	): unknown;
}

export interface PipelineTokenRefresher {
	refreshIfNeeded(
		account: ManagedAccount,
		auth: KiroAuthDetails,
		signal?: AbortSignal,
	): Promise<ManagedAccount>;
	forceRefresh(
		account: ManagedAccount,
		signal?: AbortSignal,
	): Promise<ManagedAccount>;
}

export interface PipelineSdkClient {
	send(
		command: GenerateAssistantResponseCommand,
		options: { readonly abortSignal: AbortSignal },
	): Promise<SdkStreamResponse>;
}

export type PipelineClientFactory = (
	auth: KiroAuthDetails,
	region: string,
	effort?: Effort,
	endpoint?: string,
	proxyUrl?: string,
	accountId?: string,
	httpKeepAlive?: boolean,
) => PipelineSdkClient;

export interface PipelineAffinityBinding {
	readonly keyHash: string;
	readonly accountId: string;
	readonly conversationId: string;
	readonly createdAt: number;
	readonly lastSeen: number;
	readonly expiresAt: number;
}

export interface PipelineAffinityStore {
	getSessionAffinity(
		keyHash: string,
		now?: number,
	): PipelineAffinityBinding | undefined;
	claimSessionAffinity(
		keyHash: string,
		accountId: string,
		conversationId: string,
		now: number,
		ttlMs: number,
		maxEntries: number,
	): PipelineAffinityBinding;
	rebindSessionAffinity(
		keyHash: string,
		accountId: string,
		conversationId: string,
		now: number,
		ttlMs: number,
		maxEntries: number,
	): PipelineAffinityBinding;
}

export interface PipelineSessionAffinity {
	readonly keyHash: string;
	readonly source: string;
}

export type PipelineReasoningReplayStore = Pick<
  ReasoningReplayStore,
  "readiness" | "store" | "resolveResponses" | "resolveChat"
>;

export interface RunChatCompletionOptions {
	readonly body: CanonicalRequest;
	readonly model: string;
	readonly stream: boolean;
	readonly config: Config;
	readonly accountManager: PipelineAccountManager;
	readonly tokenRefresher: PipelineTokenRefresher;
	readonly affinity?: PipelineSessionAffinity;
	readonly affinityStore?: PipelineAffinityStore;
	readonly tenantId?: string;
	readonly reasoningReplayStore?: PipelineReasoningReplayStore;
	readonly makeClient?: PipelineClientFactory;
	readonly deadlineSignal?: AbortSignal;
	readonly createStreamResponse?: typeof createPipelineStreamResponse;
}
