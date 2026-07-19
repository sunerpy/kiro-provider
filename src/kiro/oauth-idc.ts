import { z } from "zod";
import {
	buildUrl,
	KIRO_AUTH_SERVICE,
	KIRO_CONSTANTS,
	normalizeRegion,
} from "./constants.js";
import type { KiroRegion } from "./types.js";

const ClientRegistrationSchema = z.object({
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
});

const DeviceAuthorizationSchema = z.object({
	verificationUri: z.string().min(1),
	verificationUriComplete: z.string().min(1),
	userCode: z.string().min(1),
	deviceCode: z.string().min(1),
	interval: z.number().positive().default(5),
	expiresIn: z.number().positive().default(600),
});

const TokenResponseSchema = z
	.object({
		error: z.string().optional(),
		error_description: z.string().optional(),
		access_token: z.string().optional(),
		accessToken: z.string().optional(),
		refresh_token: z.string().optional(),
		refreshToken: z.string().optional(),
		expires_in: z.number().optional(),
		expiresIn: z.number().optional(),
	})
	.passthrough();

export interface KiroIDCAuthorization {
	readonly verificationUrl: string;
	readonly verificationUriComplete: string;
	readonly userCode: string;
	readonly deviceCode: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly interval: number;
	readonly expiresIn: number;
	readonly region: KiroRegion;
	readonly startUrl: string;
}

export interface KiroIDCTokenResult {
	readonly refreshToken: string;
	readonly accessToken: string;
	readonly expiresAt: number;
	readonly email: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly region: KiroRegion;
	readonly authMethod: "idc";
}

export class KiroIDCError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "KiroIDCError";
	}
}

async function responseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch (error) {
		if (error instanceof Error) return "";
		throw error;
	}
}

export async function authorizeKiroIDC(
	region?: KiroRegion,
	startUrl?: string,
	proxyUrl?: string,
): Promise<KiroIDCAuthorization> {
	const effectiveRegion = normalizeRegion(region);
	const endpoint = buildUrl(
		KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT,
		effectiveRegion,
	);
	const effectiveStartUrl = startUrl ?? KIRO_AUTH_SERVICE.BUILDER_ID_START_URL;
	const registerResponse = await fetch(`${endpoint}/client/register`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": KIRO_CONSTANTS.USER_AGENT,
		},
		body: JSON.stringify({
			clientName: "Kiro IDE",
			clientType: "public",
			scopes: KIRO_AUTH_SERVICE.SCOPES,
			grantTypes: [
				"urn:ietf:params:oauth:grant-type:device_code",
				"refresh_token",
			],
		}),
		...(proxyUrl ? { proxy: proxyUrl } : {}),
	});
	if (!registerResponse.ok) {
		throw new KiroIDCError(
			`Client registration failed: ${registerResponse.status} ${await responseText(registerResponse)}`,
		);
	}

	const registration = ClientRegistrationSchema.safeParse(
		await registerResponse.json(),
	);
	if (!registration.success) {
		throw new KiroIDCError(
			"Client registration response missing clientId or clientSecret",
			{ cause: registration.error },
		);
	}

	const authorizationResponse = await fetch(`${endpoint}/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": KIRO_CONSTANTS.USER_AGENT,
		},
		body: JSON.stringify({
			clientId: registration.data.clientId,
			clientSecret: registration.data.clientSecret,
			startUrl: effectiveStartUrl,
		}),
		...(proxyUrl ? { proxy: proxyUrl } : {}),
	});
	if (!authorizationResponse.ok) {
		throw new KiroIDCError(
			`Device authorization failed: ${authorizationResponse.status} ${await responseText(authorizationResponse)}`,
		);
	}

	const authorization = DeviceAuthorizationSchema.safeParse(
		await authorizationResponse.json(),
	);
	if (!authorization.success) {
		throw new KiroIDCError(
			"Device authorization response missing required fields",
			{ cause: authorization.error },
		);
	}

	return {
		verificationUrl: authorization.data.verificationUri,
		verificationUriComplete: authorization.data.verificationUriComplete,
		userCode: authorization.data.userCode,
		deviceCode: authorization.data.deviceCode,
		clientId: registration.data.clientId,
		clientSecret: registration.data.clientSecret,
		interval: authorization.data.interval,
		expiresIn: authorization.data.expiresIn,
		region: effectiveRegion,
		startUrl: effectiveStartUrl,
	};
}

export async function pollKiroIDCToken(
	clientId: string,
	clientSecret: string,
	deviceCode: string,
	interval: number,
	expiresIn: number,
	region: KiroRegion,
	sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
		new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
	proxyUrl?: string,
): Promise<KiroIDCTokenResult> {
	if (!clientId || !clientSecret || !deviceCode) {
		throw new KiroIDCError("Missing required parameters for token polling");
	}

	const effectiveRegion = normalizeRegion(region);
	const endpoint = buildUrl(
		KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT,
		effectiveRegion,
	);
	const maxAttempts = Math.floor(expiresIn / interval);
	let currentInterval = interval * 1_000;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		await sleep(currentInterval);
		const tokenResponse = await fetch(`${endpoint}/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": KIRO_CONSTANTS.USER_AGENT,
			},
			body: JSON.stringify({
				clientId,
				clientSecret,
				deviceCode,
				grantType: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			...(proxyUrl ? { proxy: proxyUrl } : {}),
		});
		const text = await responseText(tokenResponse);
		let parsedJson: unknown = {};
		if (text) {
			try {
				parsedJson = JSON.parse(text);
			} catch (error) {
				throw new KiroIDCError(
					`Token polling failed: invalid JSON response (HTTP ${tokenResponse.status}): ${text.slice(0, 300)}`,
					{ cause: error },
				);
			}
		}
		const parsed = TokenResponseSchema.safeParse(parsedJson);
		if (!parsed.success) {
			throw new KiroIDCError(
				`Token polling failed: invalid response (HTTP ${tokenResponse.status})`,
				{ cause: parsed.error },
			);
		}
		const tokenData = parsed.data;

		switch (tokenData.error) {
			case undefined:
				break;
			case "authorization_pending":
				continue;
			case "slow_down":
				currentInterval += 5_000;
				continue;
			case "expired_token":
				throw new KiroIDCError(
					"Device code has expired. Please restart the authorization process.",
				);
			case "access_denied":
				throw new KiroIDCError("Authorization was denied by the user.");
			default:
				throw new KiroIDCError(
					`Token polling failed: ${tokenData.error} - ${tokenData.error_description ?? ""}`,
				);
		}

		const accessToken = tokenData.access_token ?? tokenData.accessToken;
		const refreshToken = tokenData.refresh_token ?? tokenData.refreshToken;
		if (accessToken && refreshToken) {
			return {
				refreshToken,
				accessToken,
				expiresAt:
					Date.now() +
					(tokenData.expires_in ?? tokenData.expiresIn ?? 3_600) * 1_000,
				email: "builder-id@aws.amazon.com",
				clientId,
				clientSecret,
				region: effectiveRegion,
				authMethod: "idc",
			};
		}
		if (!tokenResponse.ok) {
			throw new KiroIDCError(
				`Token request failed with status: ${tokenResponse.status} ${text ? `(${text.slice(0, 200)})` : ""}`,
			);
		}
		throw new KiroIDCError(
			`Token polling failed: missing tokens in response: ${text ? text.slice(0, 300) : "[empty]"}`,
		);
	}

	throw new KiroIDCError(
		"Token polling timed out. Authorization may have expired.",
	);
}
