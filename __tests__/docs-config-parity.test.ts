import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "../src/config/schema.js";

const NON_SECRET_CONFIG_FIELDS = Object.keys(ConfigSchema.shape).filter(
	(field) => field !== "api_keys" && field !== "test_upstream_endpoint",
);

describe("config.example.json", () => {
	test("parses with ConfigSchema", () => {
		// Given
		const rawExample: unknown = JSON.parse(
			readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
		);

		// When
		const parsed = ConfigSchema.safeParse(rawExample);

		// Then
		expect(parsed.success).toBe(true);
	});

	test("documents every non-secret schema field", () => {
		// Given
		const rawExample: unknown = JSON.parse(
			readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
		);
		const example = z.record(z.unknown()).parse(rawExample);

		// When
		const documentedFields = NON_SECRET_CONFIG_FIELDS.filter(
			(field) => field in example,
		);

		// Then
		expect(documentedFields).toEqual(NON_SECRET_CONFIG_FIELDS);
	});

	test("omits the test-only upstream endpoint", () => {
		// Given
		const rawExample: unknown = JSON.parse(
			readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
		);
		const example = z.record(z.unknown()).parse(rawExample);

		// When
		const containsTestEndpoint = "test_upstream_endpoint" in example;

		// Then
		expect(containsTestEndpoint).toBe(false);
	});
});
