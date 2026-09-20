import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoadError, loadConfig } from "../src/config/loader.js";
import { ConfigSchema } from "../src/config/schema.js";
import { createApp } from "../src/server/app.js";
import { messagesFixture } from "./messages-regression-helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function configFile() {
  const root = mkdtempSync(join(tmpdir(), "kiro-admission-config-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      api_keys: ["fixture-key"],
      max_inflight_requests: 4,
      max_inflight_request_body_bytes: 16777216,
    }),
    { mode: 0o600 },
  );
  return path;
}

describe("request admission configuration", () => {
  test("defaults to bounded shared request and body budgets", () => {
    expect(ConfigSchema.parse({ api_keys: ["fixture"] })).toMatchObject({
      max_inflight_requests: 16,
      max_inflight_request_body_bytes: 134217728,
    });
  });
  test("preserves overrides > environment > JSON > schema precedence", () => {
    const configPath = configFile();
    expect(loadConfig({ configPath, env: {} })).toMatchObject({
      max_inflight_requests: 4,
      max_inflight_request_body_bytes: 16777216,
    });
    const env = {
      KIRO_PROVIDER_MAX_INFLIGHT_REQUESTS: "8",
      KIRO_PROVIDER_MAX_INFLIGHT_REQUEST_BODY_BYTES: "33554432",
    };
    expect(loadConfig({ configPath, env })).toMatchObject({
      max_inflight_requests: 8,
      max_inflight_request_body_bytes: 33554432,
    });
    expect(loadConfig({ configPath, env, overrides: { max_inflight_requests: 12 } })).toMatchObject(
      { max_inflight_requests: 12, max_inflight_request_body_bytes: 33554432 },
    );
  });
  test.each(["0", "-1", "1.5", "10001", "not-an-integer"])(
    "rejects invalid request capacity %s",
    (value) => {
      expect(() =>
        loadConfig({
          configPath: configFile(),
          env: { KIRO_PROVIDER_MAX_INFLIGHT_REQUESTS: value },
        }),
      ).toThrow(ConfigLoadError);
    },
  );
  test.each(["0", "-1", "1.5", "2147483648"])("rejects invalid body budget %s", (value) => {
    expect(() =>
      loadConfig({
        configPath: configFile(),
        env: { KIRO_PROVIDER_MAX_INFLIGHT_REQUEST_BODY_BYTES: value },
      }),
    ).toThrow(ConfigLoadError);
  });
  test("rejects aggregate budgets that cannot admit even one maximum upload", () => {
    expect(() =>
      loadConfig({
        configPath: configFile(),
        env: { KIRO_PROVIDER_MAX_INFLIGHT_REQUEST_BODY_BYTES: "1024" },
      }),
    ).toThrow("must be at least max_request_body_bytes");
    const fixture = messagesFixture();
    expect(() =>
      createApp({ ...fixture.config, max_inflight_request_body_bytes: 1024 }, fixture.dependencies),
    ).toThrow("must be at least max_request_body_bytes");
  });
});
