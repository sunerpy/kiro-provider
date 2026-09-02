import { describe, expect, test } from "bun:test";
import * as publicApi from "../src/index.js";

// Smoke test for the library entry point: every runtime export that
// `src/index.ts` promises must resolve to a real value.
describe("src/index.ts public exports", () => {
  test("exposes the server, pipeline, and storage entry points as functions", () => {
    expect(typeof publicApi.createApp).toBe("function");
    expect(typeof publicApi.startServer).toBe("function");
    expect(typeof publicApi.runChatCompletion).toBe("function");
    expect(typeof publicApi.loadConfig).toBe("function");
    expect(typeof publicApi.createAccountsDatabase).toBe("function");
  });

  test("exposes the config, account, and token classes", () => {
    expect(typeof publicApi.ConfigLoadError).toBe("function");
    expect(typeof publicApi.AccountManager).toBe("function");
    expect(typeof publicApi.TokenRefresher).toBe("function");
    expect(typeof publicApi.AccountsDatabase).toBe("function");
    expect(typeof publicApi.ConfigSchema.safeParse).toBe("function");
  });

  test("exposes the model catalog and default database path", () => {
    expect(Array.isArray(publicApi.MODEL_CATALOG)).toBe(true);
    expect(publicApi.MODEL_CATALOG.length).toBeGreaterThan(0);
    expect(publicApi.EXPECTED_PUBLIC_MODEL_IDS).toContain("auto");
    expect(typeof publicApi.ACCOUNTS_DB_PATH).toBe("string");
    expect(publicApi.ACCOUNTS_DB_PATH.endsWith("accounts.db")).toBe(true);
  });
});
