/**
 * Kiro SDK architecture smoke probe. Run from the repository root.
 *
 * Source probe (three real requests):
 *   bun run scripts/probe-sdk.ts
 *
 * Compile and then execute the compiled probe once (three real requests):
 *   bun run scripts/probe-sdk.ts --compile-check
 *
 * Equivalent explicit commands:
 *   bun build --compile scripts/probe-sdk.ts --outfile /tmp/probe-bin
 *   /tmp/probe-bin
 *
 * This script reads and, only when refresh is required, updates the selected
 * account in ~/.config/opencode/kiro.db. It never prints tokens or client secrets.
 */

import { Database } from "bun:sqlite";
// allow: SIZE_OK — this architecture probe must remain one self-contained compilable artifact.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ChatResponseStream,
	GenerateAssistantResponseCommand,
	type GenerateAssistantResponseCommandOutput,
} from "@aws/codewhisperer-streaming-client";
import { z } from "zod";
import { createSdkClient } from "../src/core/sdk-client.js";
import {
	extractRegionFromArn,
	isValidRegion,
	MODEL_MAPPING,
} from "../src/kiro/constants.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

const TOKEN_EXPIRY_BUFFER_MS = 120_000;
const COMPILED_PROBE_PATH = "/tmp/probe-bin";
const PROMPT = "Say hi in 3 words.";
const EFFORT = "medium";

const AccountRowSchema = z.object({
	id: z.string().min(1),
	refresh_token: z.string().min(1),
	access_token: z.string().min(1),
	expires_at: z.number().int().positive(),
	client_id: z.string().min(1).nullable(),
	client_secret: z.string().min(1).nullable(),
	profile_arn: z.string().min(1),
	region: z.string().min(1),
	oidc_region: z.string().min(1).nullable(),
	auth_method: z.enum(["desktop", "idc"]),
});

const RefreshResponseSchema = z
	.object({
		access_token: z.string().min(1).optional(),
		accessToken: z.string().min(1).optional(),
		refresh_token: z.string().min(1).optional(),
		refreshToken: z.string().min(1).optional(),
		expires_in: z.number().positive().optional(),
		expiresIn: z.number().positive().optional(),
	})
	.passthrough()
	.refine(
		(value) =>
			value.access_token !== undefined || value.accessToken !== undefined,
		{
			message: "refresh response has no access token",
		},
	);

const SdkErrorSchema = z
	.object({
		name: z.string().optional(),
		message: z.string().optional(),
		$metadata: z
			.object({
				httpStatusCode: z.number().int().optional(),
			})
			.optional(),
	})
	.passthrough();

type AccountRow = z.infer<typeof AccountRowSchema>;
type AuthMethod = AccountRow["auth_method"];

type ProbeSpec = {
	readonly label: string;
	readonly modelId: string;
	readonly effort?: typeof EFFORT;
};

type ProbeResult = {
	readonly label: string;
	readonly pass: boolean;
	readonly httpStatus?: number;
	readonly content: string;
	readonly reasoningSeen: boolean;
	readonly toolUseSeen: boolean;
	readonly completionEventSeen: boolean;
	readonly cleanEof: boolean;
	readonly conclusiveFailure: boolean;
	readonly error?: string;
};

type EventSummary = {
	content: string;
	reasoningSeen: boolean;
	toolUseSeen: boolean;
	completionEventSeen: boolean;
	cleanEof: boolean;
	streamError?: string;
};

type ProbeFetchInit = RequestInit & {
	readonly proxy?: string;
};

class ProbeConfigurationError extends Error {
	readonly name = "ProbeConfigurationError";
}

class TokenRefreshError extends Error {
	readonly name = "TokenRefreshError";

	constructor(
		message: string,
		readonly status?: number,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

function assertNever(value: never): never {
	throw new ProbeConfigurationError(
		`Unsupported auth method: ${String(value)}`,
	);
}

function databasePath(): string {
	const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(configHome, "opencode", "kiro.db");
}

export function resolveProbeProxy(
	env: Record<string, string | undefined>,
	argv: string[],
): string | undefined {
	const proxyFlagIndex = argv.indexOf("--proxy");
	if (proxyFlagIndex === -1) return env.KIRO_PROVIDER_PROXY_URL;
	const proxyUrl = argv[proxyFlagIndex + 1];
	if (proxyUrl === undefined || proxyUrl.startsWith("--")) {
		throw new ProbeConfigurationError("--proxy requires a value");
	}
	return proxyUrl;
}

export function buildCompileCheckArgs(proxyUrl: string | undefined): string[] {
	return proxyUrl === undefined
		? [COMPILED_PROBE_PATH]
		: [COMPILED_PROBE_PATH, "--proxy", proxyUrl];
}

function readAccount(db: Database): AccountRow | undefined {
	const row = db
		.query(
			`SELECT id, refresh_token, access_token, expires_at, client_id, client_secret,
              profile_arn, region, oidc_region, auth_method
         FROM accounts
        WHERE auth_method IN ('desktop', 'idc')
          AND refresh_token <> ''
          AND access_token <> ''
          AND profile_arn IS NOT NULL
          AND profile_arn <> ''
          AND region <> ''
          AND COALESCE(is_healthy, 1) = 1
          AND (auth_method = 'desktop'
               OR (client_id IS NOT NULL AND client_id <> ''
                   AND client_secret IS NOT NULL AND client_secret <> ''))
        ORDER BY CASE WHEN expires_at > ? THEN 0 ELSE 1 END,
                 last_used DESC,
                 expires_at DESC
        LIMIT 1`,
		)
		.get(Date.now() + TOKEN_EXPIRY_BUFFER_MS);

	if (row === null) return undefined;
	return AccountRowSchema.parse(row);
}

function refreshUrl(account: AccountRow): string {
	switch (account.auth_method) {
		case "desktop":
			return `https://prod.${account.region}.auth.desktop.kiro.dev/refreshToken`;
		case "idc":
			return `https://oidc.${account.oidc_region ?? account.region}.amazonaws.com/token`;
		default:
			return assertNever(account.auth_method);
	}
}

function refreshUserAgent(authMethod: AuthMethod): string {
	switch (authMethod) {
		case "desktop":
			return "aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/macos lang/js md/nodejs/18.0.0";
		case "idc":
			return "aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE";
		default:
			return assertNever(authMethod);
	}
}

function refreshBody(account: AccountRow): Record<string, string> {
	switch (account.auth_method) {
		case "desktop":
			return { refreshToken: account.refresh_token };
		case "idc": {
			if (account.client_id === null || account.client_secret === null) {
				throw new ProbeConfigurationError(
					"IDC account is missing client_id or client_secret",
				);
			}
			return {
				refreshToken: account.refresh_token,
				clientId: account.client_id,
				clientSecret: account.client_secret,
				grantType: "refresh_token",
			};
		}
		default:
			return assertNever(account.auth_method);
	}
}

export function buildProbeRefreshRequestInit(
	account: AccountRow,
	proxyUrl: string | undefined,
): ProbeFetchInit {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"amz-sdk-request": "attempt=1; max=1",
			"x-amzn-kiro-agent-mode": "vibe",
			"user-agent": refreshUserAgent(account.auth_method),
			Connection: "close",
		},
		body: JSON.stringify(refreshBody(account)),
		...(proxyUrl ? { proxy: proxyUrl } : {}),
	};
}

async function refreshAccessToken(
	account: AccountRow,
	proxyUrl: string | undefined,
): Promise<AccountRow> {
	const response = await fetch(
		refreshUrl(account),
		buildProbeRefreshRequestInit(account, proxyUrl),
	);

	const responseText = await response.text();
	if (!response.ok) {
		throw new TokenRefreshError(
			`Token refresh returned HTTP ${response.status}: ${responseText.slice(0, 300)}`,
			response.status,
		);
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(responseText);
	} catch (error) {
		throw new TokenRefreshError(
			"Token refresh returned invalid JSON",
			response.status,
			{
				cause: error,
			},
		);
	}

	const parsed = RefreshResponseSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new TokenRefreshError(
			`Invalid token refresh response: ${parsed.error.message}`,
		);
	}

	const accessToken = parsed.data.access_token ?? parsed.data.accessToken;
	if (accessToken === undefined) {
		throw new TokenRefreshError("Token refresh response has no access token");
	}

	return {
		...account,
		access_token: accessToken,
		refresh_token:
			parsed.data.refresh_token ??
			parsed.data.refreshToken ??
			account.refresh_token,
		expires_at:
			Date.now() +
			(parsed.data.expires_in ?? parsed.data.expiresIn ?? 3600) * 1000,
	};
}

function persistRefreshedAccount(
	db: Database,
	previous: AccountRow,
	refreshed: AccountRow,
): void {
	const result = db
		.query(
			`UPDATE accounts
          SET refresh_token = ?, access_token = ?, expires_at = ?
        WHERE id = ? AND refresh_token = ?`,
		)
		.run(
			refreshed.refresh_token,
			refreshed.access_token,
			refreshed.expires_at,
			previous.id,
			previous.refresh_token,
		);

	if (result.changes !== 1) {
		throw new ProbeConfigurationError(
			"The selected account changed concurrently; refreshed credentials were not persisted",
		);
	}
}

function conversationState(modelId: string) {
	return {
		chatTriggerType: "MANUAL" as const,
		conversationId: crypto.randomUUID(),
		currentMessage: {
			userInputMessage: {
				content: PROMPT,
				modelId,
				origin: "AI_EDITOR" as const,
			},
		},
	};
}

async function consumeEvents(
	response: GenerateAssistantResponseCommandOutput,
): Promise<EventSummary> {
	const stream = response.generateAssistantResponseResponse;
	if (stream === undefined) {
		return {
			content: "",
			reasoningSeen: false,
			toolUseSeen: false,
			completionEventSeen: false,
			cleanEof: false,
			streamError: "SDK response did not contain an event stream",
		};
	}

	const summary: EventSummary = {
		content: "",
		reasoningSeen: false,
		toolUseSeen: false,
		completionEventSeen: false,
		cleanEof: false,
	};

	for await (const event of stream) {
		collectEvent(summary, event);
		if (summary.streamError !== undefined) break;
	}
	summary.cleanEof = summary.streamError === undefined;
	return summary;
}

function collectEvent(summary: EventSummary, event: ChatResponseStream): void {
	if (event.assistantResponseEvent?.content !== undefined) {
		summary.content += event.assistantResponseEvent.content;
	}
	if (event.codeEvent?.content !== undefined) {
		summary.content += event.codeEvent.content;
	}
	if (event.reasoningContentEvent !== undefined) summary.reasoningSeen = true;
	if (event.toolUseEvent !== undefined) summary.toolUseSeen = true;
	if (
		Object.keys(event).some((key) => key.toLowerCase().includes("completion"))
	) {
		summary.completionEventSeen = true;
	}
	if (event.error !== undefined) {
		summary.streamError = `stream error: ${event.error.message}`;
	} else if (event.invalidStateEvent !== undefined) {
		summary.streamError = `invalid state: ${event.invalidStateEvent.message}`;
	}
}

function errorDetails(error: unknown): {
	readonly status?: number;
	readonly message: string;
} {
	const parsed = SdkErrorSchema.safeParse(error);
	if (parsed.success) {
		return {
			status: parsed.data.$metadata?.httpStatusCode,
			message: `${parsed.data.name ?? "SDK error"}: ${parsed.data.message ?? "unknown error"}`,
		};
	}
	if (error instanceof Error)
		return { message: `${error.name}: ${error.message}` };
	return { message: String(error) };
}

function isConclusiveSdkFailure(status: number | undefined): boolean {
	if (status === undefined) return false;
	if (status >= 200 && status < 300) return true;
	return status === 400 || status === 405 || status === 415 || status === 422;
}

type ProbeSdkClientOptions = {
	readonly auth: KiroAuthDetails;
	readonly generationRegion: string;
	readonly effort: typeof EFFORT | undefined;
	readonly proxyUrl: string | undefined;
};

export function createProbeSdkClient<T>(
	options: ProbeSdkClientOptions,
	factory: (...args: Parameters<typeof createSdkClient>) => T,
): T {
	return factory(
		options.auth,
		options.generationRegion,
		options.effort,
		undefined,
		options.proxyUrl,
	);
}

async function runRequest(
	auth: KiroAuthDetails,
	generationRegion: string,
	spec: ProbeSpec,
	proxyUrl: string | undefined,
): Promise<ProbeResult> {
	const client = createProbeSdkClient(
		{ auth, generationRegion, effort: spec.effort, proxyUrl },
		createSdkClient,
	);
	try {
		const response = await client.send(
			new GenerateAssistantResponseCommand({
				conversationState: conversationState(spec.modelId),
					profileArn: auth.profileArn,
			}),
		);
		const summary = await consumeEvents(response);
		const status = response.$metadata.httpStatusCode;
		const statusOk = status !== undefined && status >= 200 && status < 300;
		const pass =
			statusOk && summary.cleanEof && summary.content.trim().length > 0;
		return {
			label: spec.label,
			pass,
			httpStatus: status,
			content: summary.content,
			reasoningSeen: summary.reasoningSeen,
			toolUseSeen: summary.toolUseSeen,
			completionEventSeen: summary.completionEventSeen,
			cleanEof: summary.cleanEof,
			conclusiveFailure: !pass && isConclusiveSdkFailure(status),
			error:
				summary.streamError ??
				(summary.content.trim().length === 0
					? "clean response contained no content events"
					: undefined),
		};
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const details = errorDetails(error);
		return {
			label: spec.label,
			pass: false,
			httpStatus: details.status,
			content: "",
			reasoningSeen: false,
			toolUseSeen: false,
			completionEventSeen: false,
			cleanEof: false,
			conclusiveFailure: isConclusiveSdkFailure(details.status),
			error: details.message,
		};
	} finally {
		client.destroy();
	}
}

function printRequestResult(result: ProbeResult): void {
	console.log(`\n--- ${result.label} ---`);
	console.log(`HTTP status: ${result.httpStatus ?? "unknown"}`);
	console.log(
		`Content (first 200 chars): ${result.content.slice(0, 200) || "(none)"}`,
	);
	console.log(`Reasoning event: ${result.reasoningSeen ? "yes" : "no"}`);
	console.log(`Tool-use event: ${result.toolUseSeen ? "yes" : "no"}`);
	console.log(`Completion event: ${result.completionEventSeen ? "yes" : "no"}`);
	console.log(`Clean EOF: ${result.cleanEof ? "yes" : "no"}`);
	if (result.error !== undefined) console.log(`Error: ${result.error}`);
	console.log(`Result: ${result.pass ? "PASS" : "FAIL"}`);
}

function printVerdict(
	verdict: "SDK-OK" | "SDK-FAIL" | "INCONCLUSIVE",
	guidance: string,
): void {
	console.log("\n================ FINAL VERDICT ================");
	console.log("RAW-N/A (SDK-locked)");
	console.log(verdict);
	console.log(guidance);
	console.log("================================================");
}

async function runLiveProbe(proxyUrl: string | undefined): Promise<number> {
	const path = databasePath();
	if (!existsSync(path)) {
		printVerdict(
			"INCONCLUSIVE",
			`No Kiro database found at ${path}. Sign in through opencode-kiro-auth, then rerun.`,
		);
		return 2;
	}

	const db = new Database(path, { readonly: false, create: false });
	try {
		const selected = readAccount(db);
		if (selected === undefined) {
			printVerdict(
				"INCONCLUSIVE",
				`No usable desktop/IDC account found in ${path}. Re-authenticate and verify profile ARN, region, and IDC client credentials.`,
			);
			return 2;
		}
		if (!isValidRegion(selected.region)) {
			printVerdict(
				"INCONCLUSIVE",
				`Account has unsupported region: ${selected.region}`,
			);
			return 2;
		}
		if (selected.oidc_region !== null && !isValidRegion(selected.oidc_region)) {
			printVerdict(
				"INCONCLUSIVE",
				`Account has unsupported OIDC region: ${selected.oidc_region}`,
			);
			return 2;
		}

		let account = selected;
		if (Date.now() >= selected.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
			console.log(
				"Access token is expired or near expiry; refreshing it now...",
			);
				account = await refreshAccessToken(selected, proxyUrl);
			persistRefreshedAccount(db, selected, account);
			console.log(
				"Token refresh succeeded and the rotated credentials were persisted.",
			);
		} else {
			console.log("Access token is still valid; refresh skipped.");
		}

			const generationRegion =
				extractRegionFromArn(account.profile_arn) ?? account.region;
			const auth: KiroAuthDetails = {
				refresh: account.refresh_token,
				access: account.access_token,
				expires: account.expires_at,
				authMethod: account.auth_method,
				region: selected.region,
				profileArn: account.profile_arn,
				...(account.oidc_region !== null && isValidRegion(account.oidc_region)
					? { oidcRegion: account.oidc_region }
					: {}),
				...(account.client_id === null ? {} : { clientId: account.client_id }),
				...(account.client_secret === null
					? {}
					: { clientSecret: account.client_secret }),
			};
		console.log(`Database: ${path}`);
		console.log(`Auth method: ${account.auth_method}`);
		console.log(`Generation region: ${generationRegion}`);

		const claudeModel = MODEL_MAPPING["claude-sonnet-4-5"];
		const gptModel = MODEL_MAPPING["gpt-5.6-sol"];
		if (claudeModel === undefined || gptModel === undefined) {
			throw new ProbeConfigurationError(
				"Required probe model mappings are missing",
			);
		}

		const specs: readonly ProbeSpec[] = [
			{ label: "Plain Claude", modelId: claudeModel },
			{
				label: "Claude output_config.effort",
				modelId: claudeModel,
				effort: EFFORT,
			},
			{ label: "GPT reasoning.effort", modelId: gptModel, effort: EFFORT },
		];
		const results: ProbeResult[] = [];
		for (const spec of specs) {
				const result = await runRequest(
					auth,
					generationRegion,
					spec,
					proxyUrl,
				);
			results.push(result);
			printRequestResult(result);
		}

		if (results.every((result) => result.pass)) {
			printVerdict(
				"SDK-OK",
				"All three SDK requests reached clean EOF with content events.",
			);
			return 0;
		}
		if (results.some((result) => result.pass || result.conclusiveFailure)) {
			printVerdict(
				"SDK-FAIL",
				"At least one request proved the credentials/wire path but one or more SDK probes failed.",
			);
			return 1;
		}
		printVerdict(
			"INCONCLUSIVE",
			"No request established valid credentials. Check token, profile ARN, account quota, and regions, then rerun.",
		);
		return 2;
	} finally {
		db.close();
	}
}

function runCompileCheck(proxyUrl: string | undefined): number {
	console.log(`Compiling SDK probe to ${COMPILED_PROBE_PATH}...`);
	const build = Bun.spawnSync({
		cmd: [
			process.execPath,
			"build",
			"--compile",
			"scripts/probe-sdk.ts",
			"--outfile",
			COMPILED_PROBE_PATH,
		],
		cwd: process.cwd(),
		stdout: "inherit",
		stderr: "inherit",
	});
	if (build.exitCode !== 0) {
		printVerdict(
			"SDK-FAIL",
			`bun build --compile failed with exit code ${build.exitCode}.`,
		);
		return 1;
	}

	console.log(`Compile succeeded. Executing ${COMPILED_PROBE_PATH} once...`);
	const execution = Bun.spawnSync({
		cmd: buildCompileCheckArgs(proxyUrl),
		cwd: process.cwd(),
		stdout: "inherit",
		stderr: "inherit",
	});
	return execution.exitCode;
}

async function main(): Promise<void> {
	if (process.argv.includes("--help")) {
		console.log(`Usage: bun run scripts/probe-sdk.ts [options]

Options:
  --compile-check  Compile the probe and execute the compiled binary once
  --proxy <url>   Route token refresh and SDK requests through an HTTP(S) proxy
  --help          Show this help

Environment:
  KIRO_PROVIDER_PROXY_URL  Default proxy URL when --proxy is not provided`);
		return;
	}

	const proxyUrl = resolveProbeProxy(process.env, process.argv);
	if (process.argv.includes("--compile-check")) {
		process.exitCode = runCompileCheck(proxyUrl);
		return;
	}

	try {
		process.exitCode = await runLiveProbe(proxyUrl);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const details = errorDetails(error);
		printVerdict(
			"INCONCLUSIVE",
			`${details.message}. Verify the database schema, credentials, profile ARN, and regions, then rerun.`,
		);
		process.exitCode = 2;
	}
}

if (import.meta.main) await main();
