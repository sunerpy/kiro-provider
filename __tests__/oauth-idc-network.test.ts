import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	authorizeKiroIDC,
	pollKiroIDCToken,
} from "../src/kiro/oauth-idc.js";

type CapturedRequest = {
	readonly url: string;
	readonly method?: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: unknown;
	readonly init?: RequestInit;
};

const realFetch = globalThis.fetch;
const immediateSleep = async (): Promise<void> => undefined;

function captureFetch(
	responder: (request: CapturedRequest, index: number) => Response,
): { readonly fn: typeof fetch; readonly calls: CapturedRequest[] } {
	const calls: CapturedRequest[] = [];
	const requestMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const request: CapturedRequest = {
			url: typeof input === "string" ? input : String(input),
			...(init?.method ? { method: init.method } : {}),
			headers: Object.fromEntries(headers.entries()),
			...(typeof init?.body === "string"
				? { body: JSON.parse(init.body) as unknown }
				: {}),
			...(init ? { init } : {}),
		};
		const index = calls.length;
		calls.push(request);
		return responder(request, index);
	});
	const fn = Object.assign(requestMock, { preconnect: realFetch.preconnect });
	return { fn, calls };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("authorizeKiroIDC with mocked network", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("registers a client and requests device authorization", async () => {
		const { fn, calls } = captureFetch((_request, index) =>
			index === 0
				? json({ clientId: "reg-client", clientSecret: "reg-secret" })
				: json({
						verificationUri: "https://device.sso/verify",
						verificationUriComplete:
							"https://device.sso/verify?code=WXYZ",
						userCode: "WXYZ",
						deviceCode: "device-code-1",
						interval: 5,
						expiresIn: 600,
					}),
		);
		globalThis.fetch = fn;

		const result = await authorizeKiroIDC(
			"eu-west-1",
			"https://acme.awsapps.com/start",
		);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe(
			"https://oidc.eu-west-1.amazonaws.com/client/register",
		);
		expect(calls[0]?.headers["user-agent"]).toBe("KiroIDE");
		expect(calls[0]?.body).toMatchObject({
			clientName: "Kiro IDE",
			clientType: "public",
		});
		expect(calls[1]?.url).toBe(
			"https://oidc.eu-west-1.amazonaws.com/device_authorization",
		);
		expect(calls[1]?.body).toMatchObject({
			clientId: "reg-client",
			clientSecret: "reg-secret",
			startUrl: "https://acme.awsapps.com/start",
		});
		expect(result).toMatchObject({
			verificationUriComplete: "https://device.sso/verify?code=WXYZ",
			userCode: "WXYZ",
			deviceCode: "device-code-1",
			region: "eu-west-1",
		});
	});

		test("uses Builder ID defaults", async () => {
		const { fn, calls } = captureFetch((_request, index) =>
			index === 0
				? json({ clientId: "c", clientSecret: "s" })
				: json({
						verificationUri: "u",
						verificationUriComplete: "uc",
						userCode: "code",
						deviceCode: "dc",
					}),
		);
		globalThis.fetch = fn;

		const result = await authorizeKiroIDC();

		expect(calls[0]?.url).toBe(
			"https://oidc.us-east-1.amazonaws.com/client/register",
		);
		expect(calls[1]?.body).toMatchObject({
			startUrl: "https://view.awsapps.com/start",
		});
			expect(result).toMatchObject({
				interval: 5,
				expiresIn: 600,
				region: "us-east-1",
			});
		});

		test("passes the proxy to client registration and device authorization", async () => {
			const { fn, calls } = captureFetch((_request, index) =>
				index === 0
					? json({ clientId: "c", clientSecret: "s" })
					: json({
							verificationUri: "u",
							verificationUriComplete: "uc",
							userCode: "code",
							deviceCode: "dc",
						}),
			);
			globalThis.fetch = fn;

			await authorizeKiroIDC(
				"us-east-1",
				undefined,
				"http://p:1080",
			);

			expect(calls).toHaveLength(2);
			expect(calls[0]?.init).toHaveProperty("proxy", "http://p:1080");
			expect(calls[1]?.init).toHaveProperty("proxy", "http://p:1080");
		});

		test("omits the proxy option from authorization requests by default", async () => {
			const { fn, calls } = captureFetch((_request, index) =>
				index === 0
					? json({ clientId: "c", clientSecret: "s" })
					: json({
							verificationUri: "u",
							verificationUriComplete: "uc",
							userCode: "code",
							deviceCode: "dc",
						}),
			);
			globalThis.fetch = fn;

			await authorizeKiroIDC("us-east-1");

			expect(calls).toHaveLength(2);
			expect(calls[0]?.init).not.toHaveProperty("proxy");
			expect(calls[1]?.init).not.toHaveProperty("proxy");
		});

	test("rejects failed and malformed authorization responses", async () => {
		globalThis.fetch = captureFetch(() =>
			new Response("nope", { status: 400 }),
		).fn;
		await expect(authorizeKiroIDC("us-east-1")).rejects.toThrow(
			"Client registration failed: 400",
		);

		globalThis.fetch = captureFetch(() => json({ clientId: "only-id" })).fn;
		await expect(authorizeKiroIDC("us-east-1")).rejects.toThrow(
			"missing clientId or clientSecret",
		);

		globalThis.fetch = captureFetch((_request, index) =>
			index === 0
				? json({ clientId: "c", clientSecret: "s" })
				: json({ userCode: "code" }),
		).fn;
		await expect(authorizeKiroIDC("us-east-1")).rejects.toThrow(
			"missing required fields",
		);
	});
});

describe("pollKiroIDCToken with mocked network", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

		test("polls pending then returns issued tokens", async () => {
		const { fn, calls } = captureFetch((_request, index) =>
			index === 0
				? json({ error: "authorization_pending" })
				: json({
						access_token: "idc-access",
						refresh_token: "idc-refresh",
						expires_in: 1800,
					}),
		);
		globalThis.fetch = fn;

		const result = await pollKiroIDCToken(
			"client",
			"secret",
			"device",
			5,
			600,
			"us-east-1",
			immediateSleep,
		);

		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe(
			"https://oidc.us-east-1.amazonaws.com/token",
		);
		expect(calls[0]?.body).toMatchObject({
			clientId: "client",
			clientSecret: "secret",
			deviceCode: "device",
			grantType: "urn:ietf:params:oauth:grant-type:device_code",
		});
			expect(result).toMatchObject({
				refreshToken: "idc-refresh",
				accessToken: "idc-access",
				email: "builder-id@aws.amazon.com",
				region: "us-east-1",
				authMethod: "idc",
			});
		});

		test("passes the proxy to token polling", async () => {
			const { fn, calls } = captureFetch(() =>
				json({ access_token: "a", refresh_token: "r" }),
			);
			globalThis.fetch = fn;

			await pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				600,
				"us-east-1",
				immediateSleep,
				"http://p:1080",
			);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.init).toHaveProperty("proxy", "http://p:1080");
		});

		test("omits the proxy option from token polling by default", async () => {
			const { fn, calls } = captureFetch(() =>
				json({ access_token: "a", refresh_token: "r" }),
			);
			globalThis.fetch = fn;

			await pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				600,
				"us-east-1",
				immediateSleep,
			);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.init).not.toHaveProperty("proxy");
		});

	test("handles slow down and terminal OAuth errors", async () => {
		globalThis.fetch = captureFetch((_request, index) =>
			index === 0
				? json({ error: "slow_down" })
				: json({ accessToken: "a", refreshToken: "r" }),
		).fn;
		await expect(
			pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				600,
				"us-east-1",
				immediateSleep,
			),
		).resolves.toMatchObject({ accessToken: "a", refreshToken: "r" });

		globalThis.fetch = captureFetch(() => json({ error: "expired_token" })).fn;
		await expect(
			pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				600,
				"us-east-1",
				immediateSleep,
			),
		).rejects.toThrow("Device code has expired");

		globalThis.fetch = captureFetch(() => json({ error: "access_denied" })).fn;
		await expect(
			pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				600,
				"us-east-1",
				immediateSleep,
			),
		).rejects.toThrow("Authorization was denied");
	});

	test("times out after the device code polling budget", async () => {
		const { fn, calls } = captureFetch(() =>
			json({ error: "authorization_pending" }),
		);
		globalThis.fetch = fn;

		await expect(
			pollKiroIDCToken(
				"client",
				"secret",
				"device",
				5,
				10,
				"us-east-1",
				immediateSleep,
			),
		).rejects.toThrow("timed out");
		expect(calls).toHaveLength(2);
	});
});
