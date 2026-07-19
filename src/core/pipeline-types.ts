import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import type { Config } from "../config/schema.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { Effort, KiroAuthDetails, ManagedAccount } from "../kiro/types.js";

export interface PipelineAccountManager {
	reconcileFromDb(): readonly ManagedAccount[];
	selectHealthyAccount(): ManagedAccount | null;
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
) => PipelineSdkClient;

export interface RunChatCompletionOptions {
	readonly body: unknown;
	readonly model: string;
	readonly stream: boolean;
	readonly config: Config;
	readonly accountManager: PipelineAccountManager;
	readonly tokenRefresher: PipelineTokenRefresher;
	readonly makeClient?: PipelineClientFactory;
	readonly deadlineSignal?: AbortSignal;
}
