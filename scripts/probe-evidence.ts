/**
 * Kiro protocol evidence probe for the 2026-09-02 review items marked "待取证":
 *
 *   B12 — does getUsageLimits expose a quota reset timestamp?
 *   B20 — how does Kiro emit a toolUseEvent for a tool that takes no parameters?
 *   B21 — does Kiro accept an assistant turn split into several consecutive
 *         same-role history entries (current projection) vs the native shape?
 *   B25 — does Kiro validate replayed reasoning signatures, and does it accept
 *         a signature minted in another conversation?
 *
 * Usage (from the repository root, read-only against the local account store):
 *   bun run scripts/probe-evidence.ts [--model claude-sonnet-5] [--out /tmp/evidence.json]
 *
 * The probe opens ~/.config/kiro-provider/accounts.db READ-ONLY, picks the
 * least-used healthy account whose access token is valid for at least ten more
 * minutes, and never writes to the database. It never prints access tokens,
 * refresh tokens, client secrets, or raw reasoning signatures (only SHA-256
 * prefixes). Each probe is one real Kiro request; the whole run is about ten.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	GenerateAssistantResponseCommand,
	type GenerateAssistantResponseCommandInput,
	type ToolUse,
} from "@aws/codewhisperer-streaming-client";
import { createSdkClient } from "../src/core/sdk-client.js";
import { encodeRefreshToken } from "../src/kiro/auth.js";
import { KIRO_CONSTANTS } from "../src/kiro/constants.js";
import { resolveModelVariant } from "../src/kiro/models.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

type ConversationState = NonNullable<
	GenerateAssistantResponseCommandInput["conversationState"]
>;
type HistoryEntry = NonNullable<ConversationState["history"]>[number];
type UserInput = NonNullable<
	NonNullable<ConversationState["currentMessage"]>["userInputMessage"]
>;

interface RawEventSummary {
	readonly kind: string;
	readonly detail: Record<string, unknown>;
}

interface ProbeResult {
	readonly probe: string;
	readonly httpStatus?: number;
	readonly ok: boolean;
	readonly text: string;
	readonly events: RawEventSummary[];
	readonly error?: { name: string; message: string; code?: string };
	readonly reasoning: {
		text: string;
		signatureHash?: string;
		signatureLength?: number;
		redactedBytes?: number;
	};
	readonly toolUses: Array<{
		toolUseId?: string;
		name?: string;
		inputChunks: string[];
		stopSeen: boolean;
	}>;
}

interface Account {
	readonly id: string;
	readonly auth: KiroAuthDetails;
}

function hash16(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readArg(flag: string, fallback: string): string {
	const index = process.argv.indexOf(flag);
	const value = process.argv[index + 1];
	return index === -1 || value === undefined ? fallback : value;
}

function pickAccount(excludeId?: string): Account {
	const path = join(
		process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
		"kiro-provider",
		"accounts.db",
	);
	const db = new Database(path, { readonly: true });
	try {
		const now = Date.now();
		const rows = db
			.query(
				`SELECT id, email, auth_method, region, oidc_region, client_id, client_secret,
				        profile_arn, refresh_token, access_token, expires_at, is_healthy,
				        rate_limit_reset, used_count
				   FROM accounts
				  WHERE is_healthy = 1 AND expires_at > ?
				  ORDER BY used_count ASC, expires_at DESC`,
			)
			.all(now + 10 * 60 * 1000) as Array<Record<string, unknown>>;
		const row = rows.find(
			(candidate) => Number(candidate.rate_limit_reset ?? 0) < now && candidate.id !== excludeId,
		);
		if (!row) throw new Error("No usable account (healthy, token valid ≥10 min)");
		const authMethod = row.auth_method === "idc" ? "idc" : "desktop";
		const auth: KiroAuthDetails = {
			refresh: encodeRefreshToken({
				refreshToken: String(row.refresh_token),
				authMethod,
				...(row.client_id ? { clientId: String(row.client_id) } : {}),
				...(row.client_secret ? { clientSecret: String(row.client_secret) } : {}),
			}),
			access: String(row.access_token),
			expires: Number(row.expires_at),
			authMethod,
			region: String(row.region) as KiroAuthDetails["region"],
			...(row.oidc_region ? { oidcRegion: String(row.oidc_region) as KiroAuthDetails["oidcRegion"] } : {}),
			...(row.profile_arn ? { profileArn: String(row.profile_arn) } : {}),
			...(row.client_id ? { clientId: String(row.client_id) } : {}),
			...(row.client_secret ? { clientSecret: String(row.client_secret) } : {}),
			...(row.email ? { email: String(row.email) } : {}),
		};
		return { id: String(row.id), auth };
	} finally {
		db.close();
	}
}

function userInput(modelId: string, content: string, extra: Partial<UserInput> = {}): UserInput {
	return {
		content,
		modelId,
		origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR as UserInput["origin"],
		...extra,
	};
}

function conversation(
	conversationId: string,
	current: UserInput,
	history: HistoryEntry[] = [],
): ConversationState {
	return {
		chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL as ConversationState["chatTriggerType"],
		conversationId,
		agentContinuationId: crypto.randomUUID(),
		agentTaskType: "vibe",
		currentMessage: { userInputMessage: current },
		...(history.length > 0 ? { history } : {}),
	};
}

async function runProbe(
	account: Account,
	probe: string,
	conversationState: ConversationState,
	extraInput: Partial<GenerateAssistantResponseCommandInput> = {},
): Promise<ProbeResult> {
	const region = account.auth.region;
	const endpoint = KIRO_CONSTANTS.RUNTIME_ENDPOINT.replace("{{region}}", region);
	const client = createSdkClient(account.auth, region, undefined, endpoint, undefined, account.id, false);
	const input: GenerateAssistantResponseCommandInput = {
		conversationState,
		...(account.auth.profileArn ? { profileArn: account.auth.profileArn } : {}),
		...extraInput,
	};
	const events: RawEventSummary[] = [];
	const toolUses = new Map<string, ProbeResult["toolUses"][number]>();
	let text = "";
	let reasoningText = "";
	let signature: string | undefined;
	let redactedBytes: number | undefined;
	try {
		const output = await client.send(new GenerateAssistantResponseCommand(input));
		const httpStatus = output.$metadata.httpStatusCode;
		for await (const event of output.generateAssistantResponseResponse ?? []) {
			const record = event as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(record)) {
				if (value === undefined) continue;
				const detail: Record<string, unknown> = {};
				if (key === "assistantResponseEvent") {
					const content = (value as { content?: string }).content ?? "";
					text += content;
					detail.contentLength = content.length;
				} else if (key === "toolUseEvent") {
					const tool = value as { toolUseId?: string; name?: string; input?: string; stop?: boolean };
					const id = tool.toolUseId ?? "?";
					const entry = toolUses.get(id) ?? { toolUseId: tool.toolUseId, name: tool.name, inputChunks: [], stopSeen: false };
					if (tool.input !== undefined) entry.inputChunks.push(tool.input);
					if (tool.stop) entry.stopSeen = true;
					if (tool.name) entry.name = tool.name;
					toolUses.set(id, entry);
					detail.hasInputKey = "input" in tool;
					detail.inputType = typeof tool.input;
					detail.inputLength = tool.input?.length;
					detail.stop = tool.stop;
					detail.hasName = tool.name !== undefined;
				} else if (key === "reasoningContentEvent") {
					const reasoning = value as { text?: string; signature?: string; redactedContent?: Uint8Array };
					if (reasoning.text) reasoningText += reasoning.text;
					if (reasoning.signature) signature = (signature ?? "") + reasoning.signature;
					if (reasoning.redactedContent) redactedBytes = (redactedBytes ?? 0) + reasoning.redactedContent.byteLength;
					detail.textLength = reasoning.text?.length ?? 0;
					detail.signatureLength = reasoning.signature?.length ?? 0;
					detail.redactedBytes = reasoning.redactedContent?.byteLength ?? 0;
				} else if (key === "metadataEvent" || key === "messageMetadataEvent" || key === "meteringEvent" || key === "contextUsageEvent") {
					detail.value = JSON.parse(JSON.stringify(value));
				} else if (key === "invalidStateEvent" || key === "error") {
					detail.value = JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
				} else {
					detail.keys = Object.keys((value as object) ?? {});
				}
				events.push({ kind: key, detail });
			}
		}
		return {
			probe,
			httpStatus,
			ok: true,
			text,
			events,
			reasoning: {
				text: reasoningText,
				...(signature ? { signatureHash: hash16(signature), signatureLength: signature.length } : {}),
				...(redactedBytes !== undefined ? { redactedBytes } : {}),
			},
			toolUses: [...toolUses.values()],
			// keep the raw signature only in memory for the replay probes
			...(signature ? { __signature: signature } : {}),
		} as ProbeResult;
	} catch (error) {
		const err = error as Error & { $metadata?: { httpStatusCode?: number }; code?: string; name: string };
		return {
			probe,
			httpStatus: err.$metadata?.httpStatusCode,
			ok: false,
			text,
			events,
			error: { name: err.name, message: String(err.message).slice(0, 300), ...(err.code ? { code: err.code } : {}) },
			reasoning: { text: reasoningText },
			toolUses: [...toolUses.values()],
		};
	}
}

async function probeUsageLimits(account: Account): Promise<Record<string, unknown>> {
	const endpoint = new URL(`https://q.${account.auth.region}.amazonaws.com/getUsageLimits`);
	endpoint.searchParams.set("isEmailRequired", "true");
	endpoint.searchParams.set("origin", "AI_EDITOR");
	endpoint.searchParams.set("resourceType", "AGENTIC_REQUEST");
	if (account.auth.profileArn) endpoint.searchParams.set("profileArn", account.auth.profileArn);
	const response = await fetch(endpoint, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${account.auth.access}`,
			"Content-Type": "application/json",
			"x-amzn-kiro-agent-mode": "vibe",
			"amz-sdk-request": "attempt=1; max=1",
		},
		signal: AbortSignal.timeout(15_000),
	});
	const status = response.status;
	const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!payload) return { status, payload: undefined };
	const redact = (value: unknown, path: string): unknown => {
		if (Array.isArray(value)) return value.map((item, index) => redact(item, `${path}[${index}]`));
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, item]) => [
					key,
					/email|arn|id$/i.test(key) && typeof item === "string" ? `<${item.length} chars>` : redact(item, `${path}.${key}`),
				]),
			);
		}
		return value;
	};
	const resetLike: Array<{ path: string; value: unknown }> = [];
	const walk = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`);
		} else if (value && typeof value === "object") {
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				if (/reset|renew|period|until|next|date|expire/i.test(key)) resetLike.push({ path: `${path}.${key}`, value: item });
				walk(item, `${path}.${key}`);
			}
		}
	};
	walk(payload, "$");
	return { status, topLevelKeys: Object.keys(payload), resetLike, redacted: redact(payload, "$") };
}

async function main(): Promise<void> {
	const model = readArg("--model", "claude-sonnet-5");
	const outPath = readArg("--out", `/tmp/kiro-evidence-${Date.now()}.json`);
	const only = readArg("--only", "all");
	const effort = readArg("--effort", "");
	const effortFields = effort ? { additionalModelRequestFields: { output_config: { effort } } } : {};
	const account = pickAccount();
	const wire = resolveModelVariant(model).wireId;
	const results: Record<string, unknown> = { model, wire, accountHash: hash16(account.id), startedAt: new Date().toISOString() };
	const log = (label: string, value: unknown): void => {
		results[label] = value;
		console.log(`\n=== ${label} ===`);
		console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2).slice(0, 6000));
	};

	if (only === "all") {
	// B12
	log("B12_usage_limits", await probeUsageLimits(account));

	// Control
	const control = await runProbe(account, "control", conversation(crypto.randomUUID(), userInput(wire, "Reply with exactly the token KIRO_CTRL_5A21 and nothing else.")));
	log("control", { ...control, __signature: undefined });

	// B20: zero-parameter tool
	const zeroTool = {
		toolSpecification: {
			name: "get_probe_time",
			description: "Returns the current probe time. Takes no parameters.",
			inputSchema: { json: { type: "object", properties: {}, additionalProperties: false } },
		},
	};
	const b20 = await runProbe(
		account,
		"B20_zero_param_tool",
		conversation(
			crypto.randomUUID(),
			userInput(wire, "Call the get_probe_time tool now. Do not answer in text.", {
				userInputMessageContext: { tools: [zeroTool] },
			}),
		),
	);
	log("B20_zero_param_tool", { ...b20, __signature: undefined });

	// B21: parallel tool calls — native vs split projection
	const toolA = { toolSpecification: { name: "probe_tool_a", description: "Probe tool A. Echoes its marker.", inputSchema: { json: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] } } } };
	const toolB = { toolSpecification: { name: "probe_tool_b", description: "Probe tool B. Echoes its marker.", inputSchema: { json: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] } } } };
	const callA = { toolUseId: "tooluse_probe_a_001", name: "probe_tool_a", input: { marker: "A" } };
	const callB = { toolUseId: "tooluse_probe_b_001", name: "probe_tool_b", input: { marker: "B" } };
	const resultA = { toolUseId: callA.toolUseId, content: [{ text: "RESULT_A_7F3C" }], status: "success" as const };
	const resultB = { toolUseId: callB.toolUseId, content: [{ text: "RESULT_B_9E1D" }], status: "success" as const };
	const opening = userInput(wire, "Call probe_tool_a with marker A and probe_tool_b with marker B, then repeat both tool results verbatim on one line.", { userInputMessageContext: { tools: [toolA, toolB] } });
	const followUp = (results: typeof resultA[]) => userInput(wire, "", { userInputMessageContext: { tools: [toolA, toolB], toolResults: results } });

	const nativeHistory: HistoryEntry[] = [
		{ userInputMessage: opening },
		{ assistantResponseMessage: { content: "Calling both tools.", toolUses: [callA, callB] } },
	];
	const b21Native = await runProbe(account, "B21_native_shape", conversation(crypto.randomUUID(), followUp([resultA, resultB]), nativeHistory));
	log("B21_native_shape", { ...b21Native, __signature: undefined });

	const splitHistory: HistoryEntry[] = [
		{ userInputMessage: opening },
		{ assistantResponseMessage: { content: "Calling both tools." } },
		{ assistantResponseMessage: { content: "", toolUses: [callA] } },
		{ assistantResponseMessage: { content: "", toolUses: [callB] } },
		{ userInputMessage: userInput(wire, "", { userInputMessageContext: { toolResults: [resultA] } }) },
	];
	const b21Split = await runProbe(account, "B21_split_projection", conversation(crypto.randomUUID(), followUp([resultB]), splitHistory));
	log("B21_split_projection", { ...b21Split, __signature: undefined });

	const splitHistoryMergedResults: HistoryEntry[] = [
		{ userInputMessage: opening },
		{ assistantResponseMessage: { content: "Calling both tools." } },
		{ assistantResponseMessage: { content: "", toolUses: [callA] } },
		{ assistantResponseMessage: { content: "", toolUses: [callB] } },
	];
	const b21Split2 = await runProbe(account, "B21_split_calls_merged_results", conversation(crypto.randomUUID(), followUp([resultA, resultB]), splitHistoryMergedResults));
	log("B21_split_calls_merged_results", { ...b21Split2, __signature: undefined });
	}

	// B25: reasoning signature replay. Kiro's Claude models emit a signed (empty-text)
	// reasoningContentEvent on tool-use turns, so turn 1 is a tool call.
	const sigTool = { toolSpecification: { name: "probe_tool_sig", description: "Probe tool. Echoes its marker.", inputSchema: { json: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] } } } };
	const convX = crypto.randomUUID();
	const turn1Prompt = "Call probe_tool_sig with marker S, then repeat the tool result verbatim.";
	const turn1Input = userInput(wire, turn1Prompt, { userInputMessageContext: { tools: [sigTool] } });
	const turn1 = await runProbe(account, "B25_turn1_tool_call", conversation(convX, turn1Input), effortFields);
	log("B25_turn1_tool_call", { ...turn1, __signature: undefined });
	const rawSignature = (turn1 as ProbeResult & { __signature?: string }).__signature;
	const call = turn1.toolUses[0];
	if (rawSignature && call?.toolUseId) {
		let parsedInput: Record<string, unknown> = {};
		try {
			parsedInput = JSON.parse(call.inputChunks.join("") || "{}") as Record<string, unknown>;
		} catch {
			parsedInput = {};
		}
		const replayed = (signature: string, includeReasoning = true): HistoryEntry[] => [
			{ userInputMessage: turn1Input },
			{
				assistantResponseMessage: {
					content: turn1.text,
					...(includeReasoning ? { reasoningContent: { reasoningText: { text: turn1.reasoning.text, signature } } } : {}),
					toolUses: [{ toolUseId: call.toolUseId, name: call.name, input: parsedInput as ToolUse["input"] }],
				},
			},
		];
		const toolResult = { toolUseId: call.toolUseId, content: [{ text: "RESULT_S_3C9A" }], status: "success" as const };
		const turn2 = () => userInput(wire, "", { userInputMessageContext: { tools: [sigTool], toolResults: [toolResult] } });
		const same = await runProbe(account, "B25_same_conversation_valid_signature", conversation(convX, turn2(), replayed(rawSignature)), effortFields);
		log("B25_same_conversation_valid_signature", { ...same, __signature: undefined });
		const other = await runProbe(account, "B25_other_conversation_valid_signature", conversation(crypto.randomUUID(), turn2(), replayed(rawSignature)), effortFields);
		log("B25_other_conversation_valid_signature", { ...other, __signature: undefined });
		const tampered = `${rawSignature.slice(0, -4)}${rawSignature.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
		const bad = await runProbe(account, "B25_same_conversation_tampered_signature", conversation(convX, turn2(), replayed(tampered)), effortFields);
		log("B25_same_conversation_tampered_signature", { ...bad, __signature: undefined });
		const none = await runProbe(account, "B25_same_conversation_no_reasoning", conversation(convX, turn2(), replayed(rawSignature, false)), effortFields);
		log("B25_same_conversation_no_reasoning", { ...none, __signature: undefined });
		const secondAccount = pickAccount(account.id);
		results.secondAccountHash = hash16(secondAccount.id);
		const cross = await runProbe(secondAccount, "B25_other_account_other_conversation_valid_signature", conversation(crypto.randomUUID(), turn2(), replayed(rawSignature)), effortFields);
		log("B25_other_account_other_conversation_valid_signature", { ...cross, __signature: undefined });
	} else {
		log("B25_note", "turn1 produced no reasoning signature or tool call; replay probes skipped");
	}

	results.finishedAt = new Date().toISOString();
	writeFileSync(outPath, JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2));
	console.log(`\nEvidence written to ${outPath}`);
}

await main();
