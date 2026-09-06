import { describe, expect, test } from "bun:test";
import {
  KIRO_NATIVE_CONTEXT_FEATURE_KEYS,
  KIRO_RUNTIME_COMPATIBILITY,
  NativeContextCapabilityService,
} from "../src/kiro/native-context-capabilities.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";

const account: ManagedAccount = {
  id: "account-1",
  email: "synthetic@example.invalid",
  authMethod: "idc",
  region: "us-east-1",
  refreshToken: "refresh",
  accessToken: "access-1",
  expiresAt: Date.now() + 60_000,
  rateLimitResetTime: 0,
  isHealthy: true,
  failCount: 0,
};

const auth: KiroAuthDetails = {
  refresh: "refresh",
  access: "access-1",
  expires: Date.now() + 60_000,
  authMethod: "idc",
  region: "us-east-1",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
};

describe("NativeContextCapabilityService", () => {
  test("uses the exact feature hashes found in the latest KAS bundle", () => {
    expect(KIRO_RUNTIME_COMPATIBILITY).toEqual({
      cliVersion: "2.21.1",
      kasVersion: "0.58.7",
    });
    expect(KIRO_NATIVE_CONTEXT_FEATURE_KEYS).toEqual({
      systemFieldInjection: "2baac88264069c460f17175771938783595b0a429862b257a97735a0c6e7c03a",
      systemPromptMigration: "cbe9634383adc73d7f9bbc93a5440a43368b92dcd0216fd160ace513c5ce7f9b",
    });
  });

  test("enables native context only when system_field_injection is true", async () => {
    let calls = 0;
    const service = new NativeContextCapabilityService(
      { proxy_url: null },
      async (_auth, endpoint) => {
        calls += 1;
        expect(endpoint).toBe("https://runtime.us-east-1.kiro.dev");
        return {
          [KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemFieldInjection]: true,
          [KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemPromptMigration]: false,
        };
      },
    );

    await expect(service.ensureAccountNativeContext(account, auth)).resolves.toMatchObject({
      status: "available",
      source: "live",
      featureCount: 2,
      systemFieldInjection: true,
      systemPromptMigration: false,
    });
    await expect(service.ensureAccountNativeContext(account, auth)).resolves.toMatchObject({
      status: "available",
      source: "cache",
    });
    expect(calls).toBe(1);
  });

  test("keeps absent or false feature flags unavailable", async () => {
    const service = new NativeContextCapabilityService({ proxy_url: null }, async () => ({
      [KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemFieldInjection]: false,
    }));

    await expect(service.ensureAccountNativeContext(account, auth)).resolves.toMatchObject({
      status: "unavailable",
      source: "live",
      systemFieldInjection: false,
    });
  });

  test("invalidates the capability cache when the access token changes", async () => {
    let calls = 0;
    const service = new NativeContextCapabilityService({ proxy_url: null }, async () => {
      calls += 1;
      return {
        [KIRO_NATIVE_CONTEXT_FEATURE_KEYS.systemFieldInjection]: true,
      };
    });

    await service.ensureAccountNativeContext(account, auth);
    await service.ensureAccountNativeContext(account, { ...auth, access: "access-2" });
    expect(calls).toBe(2);
  });

  test("fails closed and backs off after a probe error", async () => {
    let calls = 0;
    const service = new NativeContextCapabilityService({ proxy_url: null }, async () => {
      calls += 1;
      throw new Error("synthetic probe failure");
    });

    await expect(service.ensureAccountNativeContext(account, auth)).resolves.toMatchObject({
      status: "unknown",
      source: "probe-error",
      systemFieldInjection: false,
    });
    await service.ensureAccountNativeContext(account, auth);
    expect(calls).toBe(1);
  });
});
