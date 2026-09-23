import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStructuredOutputProbe,
  type ProbeOutcome,
  safeProbeErrorCode,
  validateIsolatedConfigRoot,
} from "../scripts/probe-structured-output-capability.js";

const cleanup: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "kiro-structured-output-probe-"));
  cleanup.push(path);
  return path;
}

function isolatedRoot(accountCount = 1): string {
  const root = temporaryDirectory();
  const provider = join(root, "kiro-provider");
  mkdirSync(provider, { mode: 0o700 });
  chmodSync(root, 0o700);
  const databasePath = join(provider, "accounts.db");
  const database = new Database(databasePath, { create: true });
  database.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, region TEXT NOT NULL)");
  for (let index = 0; index < accountCount; index += 1) {
    database.run("INSERT INTO accounts (id, region) VALUES (?, 'us-east-1')", [`account-${index}`]);
  }
  database.close();
  chmodSync(databasePath, 0o600);
  return root;
}

const outcome = (overrides: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
  status: 200,
  completed: true,
  textBytes: 7,
  textHash: "0123456789abcdef",
  schemaAdherent: false,
  ...overrides,
});

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("structured-output live probe isolation", () => {
  test("accepts an owner-only single-account snapshot outside protected roots", () => {
    const root = isolatedRoot();
    expect(validateIsolatedConfigRoot(root, [])).toBe(root);
  });

  test("rejects the active config root even when the database inode check cannot distinguish it", () => {
    const root = isolatedRoot();
    expect(() => validateIsolatedConfigRoot(root, [root])).toThrow(
      "must not overlap an active config root",
    );
  });

  test("rejects an intermediate provider-directory symlink", () => {
    const root = temporaryDirectory();
    const outside = isolatedRoot();
    chmodSync(root, 0o700);
    symlinkSync(join(outside, "kiro-provider"), join(root, "kiro-provider"), "dir");
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow(
      "provider directory must not be a symbolic link",
    );
  });

  test("rejects a database that is not a one-account snapshot", () => {
    const root = isolatedRoot(2);
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("must contain exactly one account");
  });

  test("rejects a snapshot region that could redirect the bearer token", () => {
    const root = isolatedRoot();
    const database = new Database(join(root, "kiro-provider", "accounts.db"));
    database.run("UPDATE accounts SET region = 'us-east-1.kiro.dev@attacker.invalid/x'");
    database.close();
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("contains an invalid region");
  });

  test("rejects SQLite sidecars instead of trusting a potentially inconsistent raw copy", () => {
    const root = isolatedRoot();
    writeFileSync(join(root, "kiro-provider", "accounts.db-wal"), "");
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("must not have SQLite sidecars");
  });
});

test("probe error output keeps only approved categorical codes", () => {
  expect(safeProbeErrorCode({ code: "ValidationException" })).toBe("ValidationException");
  expect(safeProbeErrorCode({ code: "account-1234-secret-shaped" })).toBeUndefined();
  expect(safeProbeErrorCode({ error: { type: "access_denied" } })).toBe("access_denied");
});

describe("structured-output live probe classification", () => {
  test("requires repeated completed controls before calling a stable 400 a field rejection", () => {
    const rejected = [
      outcome({ status: 400, completed: false }),
      outcome({ status: 400, completed: false }),
    ];
    expect(classifyStructuredOutputProbe(rejected, [outcome({ status: 503 })])).toBe(
      "unverified_control_unavailable",
    );
    expect(classifyStructuredOutputProbe(rejected, [outcome(), outcome()])).toBe("field_rejected");
    expect(classifyStructuredOutputProbe(rejected)).toBe("unverified_control_unavailable");
  });

  test("does not classify throttling or mixed client failures as field rejection", () => {
    expect(
      classifyStructuredOutputProbe(
        [outcome({ status: 429, completed: false }), outcome({ status: 429, completed: false })],
        [outcome(), outcome()],
      ),
    ).toBe("enforcement_not_established");
    expect(
      classifyStructuredOutputProbe(
        [outcome({ status: 400, completed: false }), outcome({ status: 422, completed: false })],
        [outcome(), outcome()],
      ),
    ).toBe("enforcement_not_established");
    expect(
      classifyStructuredOutputProbe(
        [
          outcome({ status: 400, completed: false, code: "ValidationException" }),
          outcome({ status: 400, completed: false, code: "REQUEST_BODY_INVALID" }),
        ],
        [outcome(), outcome()],
      ),
    ).toBe("enforcement_not_established");
  });

  test("treats access denial anywhere in the comparison as unverified", () => {
    expect(
      classifyStructuredOutputProbe(
        [outcome({ status: 400 }), outcome({ status: 400 })],
        [outcome({ status: 403 }), outcome()],
      ),
    ).toBe("unverified_access_denied");
  });

  test("requires repeated completed adherence and repeated non-adherent controls", () => {
    const adherent = outcome({ schemaAdherent: true });
    expect(classifyStructuredOutputProbe([adherent], [outcome(), outcome()])).toBe(
      "enforcement_not_established",
    );
    expect(
      classifyStructuredOutputProbe(
        [adherent, outcome({ schemaAdherent: true, completed: false })],
        [outcome(), outcome()],
      ),
    ).toBe("enforcement_not_established");
    expect(
      classifyStructuredOutputProbe(
        [adherent, adherent],
        [outcome({ completed: false }), outcome({ completed: false })],
      ),
    ).toBe("unverified_control_unavailable");
    expect(classifyStructuredOutputProbe([adherent, adherent], [outcome(), outcome()])).toBe(
      "candidate_enforcement_evidence",
    );
  });
});
