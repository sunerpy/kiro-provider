import { describe, expect, test } from "bun:test";
import {
	buildCompileCheckArgs,
	buildProbeRefreshRequestInit,
	createProbeSdkClient,
	resolveProbeProxy,
} from "../scripts/probe-sdk.js";

const account = {
	id: "account-1",
	refresh_token: "refresh-token",
	access_token: "access-token",
	expires_at: Date.now() + 60_000,
	client_id: null,
	client_secret: null,
	profile_arn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
	region: "us-east-1",
	oidc_region: null,
	auth_method: "desktop" as const,
};

const auth = {
	refresh: "refresh-token",
	access: "access-token",
	expires: Date.now() + 60_000,
	authMethod: "desktop" as const,
	region: "us-east-1" as const,
};

describe("resolveProbeProxy", () => {
	test("returns the proxy flag value when argv contains --proxy", () => {
		const result = resolveProbeProxy({}, ["--proxy", "http://p:1"]);

		expect(result).toBe("http://p:1");
	});

	test("returns KIRO_PROVIDER_PROXY_URL when no proxy flag is present", () => {
		const result = resolveProbeProxy(
			{ KIRO_PROVIDER_PROXY_URL: "http://env-proxy:2" },
			[],
		);

		expect(result).toBe("http://env-proxy:2");
	});

	test("prefers the proxy flag over KIRO_PROVIDER_PROXY_URL", () => {
		const result = resolveProbeProxy(
			{ KIRO_PROVIDER_PROXY_URL: "http://env-proxy:2" },
			["--proxy", "http://flag-proxy:3"],
		);

		expect(result).toBe("http://flag-proxy:3");
	});

	test("returns undefined when neither proxy source is present", () => {
		const result = resolveProbeProxy({}, []);

		expect(result).toBeUndefined();
	});

	test("rejects --proxy without a value", () => {
		expect(() => resolveProbeProxy({}, ["--proxy"])).toThrow();
	});
});

describe("buildCompileCheckArgs", () => {
	test("appends the proxy flag and value when a proxy is configured", () => {
		const result = buildCompileCheckArgs("http://p:1");

		expect(result).toEqual(["/tmp/probe-bin", "--proxy", "http://p:1"]);
	});

	test("returns only the compiled probe path when no proxy is configured", () => {
		const result = buildCompileCheckArgs(undefined);

		expect(result).toEqual(["/tmp/probe-bin"]);
	});
});

describe("probe proxy forwarding", () => {
	test.each([
		{ label: "enabled", proxyUrl: "http://p:1", expected: "http://p:1" },
		{ label: "disabled", proxyUrl: undefined, expected: undefined },
	])("builds refresh fetch init with proxy $label", ({ proxyUrl, expected }) => {
		const init = buildProbeRefreshRequestInit(account, proxyUrl);

		if (expected === undefined) {
			expect(init).not.toHaveProperty("proxy");
		} else {
			expect(init.proxy).toBe(expected);
		}
	});

	test.each([
		{ label: "enabled", proxyUrl: "http://p:1", expected: "http://p:1" },
		{ label: "disabled", proxyUrl: undefined, expected: undefined },
	])("forwards proxy to the SDK client factory when $label", ({ proxyUrl, expected }) => {
		const calls: unknown[][] = [];
		const client = createProbeSdkClient(
			{
				auth,
				generationRegion: "us-east-1",
				effort: "medium",
				proxyUrl,
			},
			(...args) => {
				calls.push(args);
				return "fake-client";
			},
		);

		expect(client).toBe("fake-client");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[4]).toBe(expected);
	});
});
