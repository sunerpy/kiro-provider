import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivateWindowsAcl,
  classifyStructuredOutputProbe,
  type ProbeOutcome,
  safeProbeErrorCode,
  validateIsolatedConfigRoot,
} from "../scripts/probe-structured-output-capability.js";

const cleanup: string[] = [];

function fixturePermissions(
  entries: readonly { readonly path: string; readonly mode: number }[],
): void {
  if (process.platform !== "win32") {
    for (const entry of entries) chmodSync(entry.path, entry.mode);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($entry in @($env:KIRO_PROBE_TEST_ACLS | ConvertFrom-Json)) {
  $directory = Test-Path -LiteralPath $entry.path -PathType Container
  $acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', $inheritance, 'None', 'Allow'))
  if (($entry.mode -band 63) -ne 0) {
    $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', $inheritance, 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $entry.path -AclObject $acl
}
`;
  execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, KIRO_PROBE_TEST_ACLS: JSON.stringify(entries) },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "kiro-structured-output-probe-"));
  cleanup.push(path);
  return path;
}

function isolatedRoot(accountCount = 1): string {
  const root = temporaryDirectory();
  const provider = join(root, "kiro-provider");
  mkdirSync(provider, { mode: 0o700 });
  const databasePath = join(provider, "accounts.db");
  const database = new Database(databasePath, { create: true });
  database.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, region TEXT NOT NULL)");
  for (let index = 0; index < accountCount; index += 1) {
    database.run("INSERT INTO accounts (id, region) VALUES (?, 'us-east-1')", [`account-${index}`]);
  }
  database.close();
  fixturePermissions([
    { path: root, mode: 0o700 },
    { path: provider, mode: 0o700 },
    { path: databasePath, mode: 0o600 },
  ]);
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
  }, 30_000);

  test("rejects the active config root even when the database inode check cannot distinguish it", () => {
    const root = isolatedRoot();
    expect(() => validateIsolatedConfigRoot(root, [root])).toThrow(
      "must not overlap an active config root",
    );
  }, 30_000);

  test("rejects an intermediate provider-directory symlink", () => {
    const root = temporaryDirectory();
    const outside = isolatedRoot();
    fixturePermissions([{ path: root, mode: 0o700 }]);
    symlinkSync(join(outside, "kiro-provider"), join(root, "kiro-provider"), "dir");
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow(
      "provider directory must not be a symbolic link",
    );
  }, 30_000);

  test("rejects a database that is not a one-account snapshot", () => {
    const root = isolatedRoot(2);
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("must contain exactly one account");
  }, 30_000);

  test("rejects a snapshot region that could redirect the bearer token", () => {
    const root = isolatedRoot();
    const database = new Database(join(root, "kiro-provider", "accounts.db"));
    database.run("UPDATE accounts SET region = 'us-east-1.kiro.dev@attacker.invalid/x'");
    database.close();
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("contains an invalid region");
  }, 30_000);

  test("rejects SQLite sidecars instead of trusting a potentially inconsistent raw copy", () => {
    const root = isolatedRoot();
    writeFileSync(join(root, "kiro-provider", "accounts.db-wal"), "");
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("must not have SQLite sidecars");
  }, 30_000);

  test.each([
    { name: "config root", child: "", mode: 0o755 },
    { name: "provider directory", child: "kiro-provider", mode: 0o755 },
    { name: "account database", child: "kiro-provider/accounts.db", mode: 0o644 },
  ])(
    "rejects $name permissions granting other users access",
    ({ child, mode }) => {
      const root = isolatedRoot();
      fixturePermissions([{ path: join(root, child), mode }]);
      expect(() => validateIsolatedConfigRoot(root, [])).toThrow("owner-only");
    },
    30_000,
  );

  test("rejects a hard-linked snapshot even when its permissions are private", () => {
    const root = isolatedRoot();
    linkSync(join(root, "kiro-provider", "accounts.db"), join(root, "snapshot-alias.db"));
    expect(() => validateIsolatedConfigRoot(root, [])).toThrow("must not be hard-linked");
  }, 30_000);
});

describe("Windows snapshot ACL policy", () => {
  const user = "S-1-5-21-1-2-3-1001";
  const rule = (sid = user, rights = 0x1f01ff, inheritOnly = false) => ({
    sid,
    rights,
    inheritOnly,
    type: "Allow",
  });
  const acl = (rules: readonly unknown[] = [rule()]) => ({
    user,
    owner: user,
    daclPresent: true,
    aceCount: rules.length,
    rules,
  });

  test("accepts the current owner with optional SYSTEM and Administrators access", () => {
    expect(() => assertPrivateWindowsAcl("snapshot", acl(), 0o500)).not.toThrow();
    expect(() =>
      assertPrivateWindowsAcl(
        "snapshot",
        acl([rule(), rule("S-1-5-18"), rule("S-1-5-32-544")]),
        0o400,
      ),
    ).not.toThrow();
  });

  test.each(["S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-21-1-2-3-1002"])(
    "rejects ordinary principal %s including inherited-only grants",
    (sid) => {
      for (const inheritOnly of [false, true]) {
        expect(() =>
          assertPrivateWindowsAcl("snapshot", acl([rule(), rule(sid, 1, inheritOnly)]), 0o400),
        ).toThrow("owner-only");
      }
    },
  );

  test("requires current-user ownership even if another owner grants full access", () => {
    expect(() =>
      assertPrivateWindowsAcl("snapshot", { ...acl(), owner: "S-1-5-32-544" }, 0o400),
    ).toThrow("owned by the current user");
  });

  test("rejects null, empty, malformed, unrecognized and denied DACLs", () => {
    for (const value of [
      undefined,
      {},
      { ...acl(), daclPresent: false },
      acl([]),
      { ...acl(), aceCount: 2 },
      acl([{ ...rule(), type: "Deny" }]),
      acl([{ ...rule(), rights: "FullControl" }]),
      acl([{ ...rule(), rights: -1 }]),
      acl([{ ...rule(), inheritOnly: undefined }]),
    ]) {
      expect(() => assertPrivateWindowsAcl("snapshot", value, 0o400)).toThrow("owner-only");
    }
  });

  test("requires effective owner read permissions and directory traversal", () => {
    expect(() =>
      assertPrivateWindowsAcl("snapshot", acl([rule(user, 0x20089)]), 0o400),
    ).not.toThrow();
    expect(() => assertPrivateWindowsAcl("snapshot", acl([rule(user, 0x20089)]), 0o500)).toThrow(
      "owner-only",
    );
    expect(() =>
      assertPrivateWindowsAcl("snapshot", acl([rule(user, 0x1f01ff, true)]), 0o400),
    ).toThrow("owner-only");
    expect(() => assertPrivateWindowsAcl("snapshot", acl([rule("S-1-5-18")]), 0o400)).toThrow(
      "owner-only",
    );
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
