import { afterEach, describe, expect, test } from "bun:test";
import type {
	KiroAvailableModel,
	KiroAvailableModelsResponse,
} from "../src/kiro/management-client.js";
import {
	ModelCapabilityService,
} from "../src/kiro/model-capabilities.js";
import { clearDynamicModelRegistry, resolveModelVariant } from "../src/kiro/models.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

function account(id: string): ManagedAccount {
	return {
		id,
		email: `${id}@example.com`,
		authMethod: "desktop",
		region: "us-east-1",
		refreshToken: `refresh-${id}`,
		accessToken: `access-${id}`,
		expiresAt: Date.now() + 3_600_000,
		rateLimitResetTime: 0,
		isHealthy: true,
		failCount: 0,
	};
}

function auth(value: ManagedAccount): KiroAuthDetails {
	return {
		refresh: value.refreshToken,
		access: value.accessToken,
		expires: value.expiresAt,
		authMethod: value.authMethod,
		region: value.region,
		email: value.email,
	};
}

function model(
	modelId: string,
	overrides: Partial<KiroAvailableModel> = {},
): KiroAvailableModel {
	return {
		modelId,
		modelName: modelId,
		supportedInputTypes: ["TEXT"],
		tokenLimits: {
			maxInputTokens: 123_000,
			maxOutputTokens: 45_000,
		},
		...overrides,
	};
}

function service(
	listModels: (
		auth: KiroAuthDetails,
		region: string,
	) => Promise<KiroAvailableModelsResponse>,
	overrides: Partial<ConstructorParameters<typeof ModelCapabilityService>[0]> = {},
): ModelCapabilityService {
	return new ModelCapabilityService(
		{
			dynamic_model_catalog: true,
			model_catalog_ttl_ms: 60_000,
			model_catalog_stale_ttl_ms: 86_400_000,
			model_catalog_request_timeout_ms: 10_000,
			proxy_url: null,
			...overrides,
		},
		listModels,
	);
}

afterEach(() => clearDynamicModelRegistry());

describe("ModelCapabilityService", () => {
	test("discovers a new exact wire model and exposes live limits", async () => {
		const capabilities = service(async () => ({
			defaultModelId: "future-model-1",
			models: [
				model("future-model-1", {
					modelName: "Future Model",
					supportedInputTypes: ["TEXT", "IMAGE"],
					rateMultiplier: 0.5,
				}),
			],
		}));
		const selected = account("a");

		const availability = await capabilities.ensureAccountModel(
			selected,
			auth(selected),
			"future-model-1",
		);

		expect(availability).toEqual({
			supported: true,
			source: "live",
			wireModel: "future-model-1",
		});
		expect(resolveModelVariant("future-model-1")).toEqual({
			wireId: "future-model-1",
			effort: undefined,
		});
		expect(capabilities.catalog()).toContainEqual({
			id: "future-model-1",
			wireId: "future-model-1",
			name: "Future Model",
			contextLimit: 123_000,
			outputLimit: 45_000,
			rateMultiplier: 0.5,
			modalities: { input: ["text", "image"], output: ["text"] },
		});
	});

	test("keeps account-specific availability for routing", async () => {
		const capabilities = service(async (details) => ({
			models:
				details.access === "access-b"
					? [model("future-model-2")]
					: [model("claude-sonnet-4.5")],
		}));
		const first = account("a");
		const second = account("b");

		expect(
			await capabilities.ensureAccountModel(
				first,
				auth(first),
				"future-model-2",
			),
		).toMatchObject({ supported: false, source: "live" });
		expect(
			await capabilities.ensureAccountModel(
				second,
				auth(second),
				"future-model-2",
			),
		).toMatchObject({ supported: true, source: "live" });
		expect([
			...(capabilities.eligibleAccountIds("future-model-2", ["a", "b"]) ?? []),
		]).toEqual(["b"]);
	});

	test("uses stale live data after a refresh failure", async () => {
		let calls = 0;
		const capabilities = service(
			async () => {
				calls += 1;
				if (calls > 1) throw new Error("offline");
				return { models: [model("future-model-3")] };
			},
			{ model_catalog_ttl_ms: 1, model_catalog_stale_ttl_ms: 60_000 },
		);
		const selected = account("a");
		await capabilities.ensureAccountModel(
			selected,
			auth(selected),
			"future-model-3",
		);
		await Bun.sleep(2);

		const availability = await capabilities.ensureAccountModel(
			selected,
			auth(selected),
			"future-model-3",
		);

		expect(availability).toMatchObject({ supported: true, source: "stale" });
		expect(capabilities.readiness()).toMatchObject({
			usable: true,
			source: "stale",
			staleAccounts: 1,
		});
	});

	test("falls back only to the static compatibility set when no live catalog exists", async () => {
		const capabilities = service(async () => {
			throw new Error("offline");
		});
		const selected = account("a");

		expect(
			await capabilities.ensureAccountModel(
				selected,
				auth(selected),
				"claude-opus-5",
			),
		).toEqual({
			supported: true,
			source: "static",
			wireModel: "claude-opus-5",
		});
		expect(
			await capabilities.ensureAccountModel(
				selected,
				auth(selected),
				"unpublished-guess",
			),
		).toEqual({ supported: false, source: "static" });
	});
});
