import { describe, expect, test } from "bun:test";
import { type LoginDependencies, runLogin } from "../src/cli/login.js";
import { ConfigSchema } from "../src/config/schema.js";
import { type KiroAvailableProfile, KiroManagementError } from "../src/kiro/management-client.js";
import type { KiroAuthDetails, ManagedAccount } from "../src/kiro/types.js";
import type { StoredAccount } from "../src/storage/accounts-db.js";

const config = ConfigSchema.parse({
  api_keys: ["sk-test"],
  auth_source: "local",
  quota_recheck_timeout_ms: 1_234,
});

const PLACEHOLDER = "builder-id@aws.amazon.com";
const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE1";
const ORG_START_URL = "https://acme.awsapps.com/start";
const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

function stored(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: "existing-id",
    email: "dev@example.com",
    authMethod: "idc",
    region: "us-east-1",
    oidcRegion: "us-east-1",
    clientId: "old-client",
    clientSecret: "old-secret",
    profileArn: PROFILE_ARN,
    refreshToken: "old-refresh",
    accessToken: "old-access",
    expiresAt: 1,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 40,
    limitCount: 100,
    overageCount: 0,
    lastSync: 5,
    lastUsed: 42,
    generation: 2,
    ...overrides,
  };
}

type Harness = {
  readonly deps: LoginDependencies;
  readonly inserted: ManagedAccount[];
  readonly removed: string[];
  readonly stdout: string[];
  readonly stderr: string[];
  readonly profileCalls: Array<{ auth: KiroAuthDetails; region: string }>;
  readonly usageCalls: KiroAuthDetails[];
  readonly usageOptions: Array<{ proxyUrl?: string; timeoutMs?: number } | undefined>;
};

function createHarness(
  existing: readonly StoredAccount[],
  fetchUsage: LoginDependencies["fetchUsage"],
  clientId = "fresh-client",
  profiles: readonly KiroAvailableProfile[] = [
    {
      arn: PROFILE_ARN,
      profileName: "Primary",
      startUrl: ORG_START_URL,
      status: "ACTIVE",
    },
  ],
): Harness {
  const inserted: ManagedAccount[] = [];
  const removed: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const profileCalls: Harness["profileCalls"] = [];
  const usageCalls: KiroAuthDetails[] = [];
  const usageOptions: Harness["usageOptions"] = [];
  const deps: LoginDependencies = {
    authorize: async (region, startUrl) => ({
      verificationUrl: "https://device.example/verify",
      verificationUriComplete: "https://device.example/verify?code=ABCD",
      userCode: "ABCD",
      deviceCode: "device-code",
      clientId,
      clientSecret: "fresh-secret",
      interval: 5,
      expiresIn: 600,
      region: region ?? "us-east-1",
      startUrl: startUrl ?? "https://view.awsapps.com/start",
    }),
    poll: async () => ({
      refreshToken: "fresh-refresh",
      accessToken: "fresh-access",
      expiresAt: 999_999,
      email: PLACEHOLDER,
      clientId,
      clientSecret: "fresh-secret",
      region: "us-east-1",
      authMethod: "idc",
    }),
    listProfiles: async (auth, region) => {
      profileCalls.push({ auth, region });
      return profiles.filter((profile) => profile.arn.split(":")[3] === region);
    },
    fetchUsage: async (auth, options) => {
      usageCalls.push(auth);
      usageOptions.push(options);
      if (!fetchUsage) throw new Error("no usage stub");
      return fetchUsage(auth, options);
    },
    openDb: () => ({
      getAccounts: () => [...existing],
      insertAccount: (account) => {
        inserted.push(account);
        return { ...account, generation: 3 };
      },
      removeAccount: (id) => {
        removed.push(id);
      },
      close: () => undefined,
    }),
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return {
    deps,
    inserted,
    removed,
    stdout,
    stderr,
    profileCalls,
    usageCalls,
    usageOptions,
  };
}

describe("runLogin profile discovery", () => {
  test.each([undefined, "https://view.awsapps.com/"])(
    "uses the Builder ID service profile without calling its unsupported catalog for start URL %j",
    async (startUrl) => {
      const harness = createHarness([], async () => ({
        email: "free@example.com",
        usedCount: 1,
        limitCount: 50,
        overageCount: 0,
      }));
      let catalogCalls = 0;

      const result = await runLogin(config, startUrl === undefined ? {} : { startUrl }, {
        ...harness.deps,
        listProfiles: async () => {
          catalogCalls += 1;
          throw new Error("AWS Builder ID is not supported for this operation (HTTP 403)");
        },
      });

      expect(catalogCalls).toBe(0);
      expect(harness.usageCalls[0]).toMatchObject({
        profileArn: BUILDER_ID_PROFILE_ARN,
        region: "us-east-1",
      });
      expect(result.account).toMatchObject({
        email: "free@example.com",
        profileArn: BUILDER_ID_PROFILE_ARN,
        region: "us-east-1",
      });
    },
  );

  test("rejects an organization profile override before starting Builder ID authorization", async () => {
    const harness = createHarness([], async () => ({
      email: "free@example.com",
      usedCount: 0,
      limitCount: 50,
      overageCount: 0,
    }));
    let authorizationCalls = 0;
    const authorize = harness.deps.authorize;
    if (authorize === undefined) throw new Error("missing authorization fixture");

    await expect(
      runLogin(
        config,
        { profileArn: PROFILE_ARN },
        {
          ...harness.deps,
          authorize: async (...args) => {
            authorizationCalls += 1;
            return authorize(...args);
          },
        },
      ),
    ).rejects.toThrow(/Builder ID cannot be bound to an organization Kiro profile ARN/);

    expect(authorizationCalls).toBe(0);
    expect(harness.inserted).toEqual([]);
  });

  test("persists authorization client metadata and clears the previous credential epoch on relogin", async () => {
    const previous = stored({
      clientIdIssuedAt: 100,
      clientSecretExpiresAt: 200,
      refreshFailureCount: 3,
      refreshFailureCode: "invalid_request",
      refreshFailedAt: 300,
      refreshRetryAt: 400,
      lastRefreshAt: 500,
    });
    for (const metadata of [
      { clientIdIssuedAt: 1_700_000_000_000, clientSecretExpiresAt: 1_800_000_000_000 },
      {},
    ]) {
      const harness = createHarness([previous], async () => ({
        email: previous.email,
        usedCount: 1,
        limitCount: 100,
        overageCount: 0,
      }));
      const authorize = harness.deps.authorize;
      if (authorize === undefined) throw new Error("missing authorization fixture");
      const result = await runLogin(
        config,
        { replaceAccount: previous },
        {
          ...harness.deps,
          authorize: async (...args) => ({ ...(await authorize(...args)), ...metadata }),
        },
      );
      expect(result.account.id).toBe(previous.id);
      expect(result.account.clientIdIssuedAt).toBe(metadata.clientIdIssuedAt);
      expect(result.account.clientSecretExpiresAt).toBe(metadata.clientSecretExpiresAt);
      for (const key of [
        "refreshFailureCount",
        "refreshFailureCode",
        "refreshFailedAt",
        "refreshRetryAt",
        "lastRefreshAt",
      ] as const)
        expect(result.account).not.toHaveProperty(key);
      expect(result.account).toMatchObject({
        clientId: "fresh-client",
        clientSecret: "fresh-secret",
        refreshToken: "fresh-refresh",
        profileArn: PROFILE_ARN,
      });
    }
  });

  test("discovers and persists a profile before requesting usage", async () => {
    const harness = createHarness([], async () => ({
      email: "dev@example.com",
      usedCount: 1,
      limitCount: 100,
      overageCount: 0,
    }));

    const result = await runLogin(config, { startUrl: ORG_START_URL }, harness.deps);

    expect(harness.profileCalls.map(({ region }) => region)).toEqual(["us-east-1", "eu-central-1"]);
    for (const call of harness.profileCalls) {
      expect(call.auth).toMatchObject({ access: "fresh-access", oidcRegion: "us-east-1" });
      expect(call.auth).not.toHaveProperty("profileArn");
    }
    expect(harness.usageCalls[0]?.profileArn).toBe(PROFILE_ARN);
    expect(harness.inserted[0]?.profileArn).toBe(PROFILE_ARN);
    expect(result.account.profileArn).toBe(PROFILE_ARN);
  });

  test("does not apply the Builder ID fallback to an organization login", async () => {
    const harness = createHarness([], async () => ({
      email: "org@example.com",
      usedCount: 0,
      limitCount: 100,
      overageCount: 0,
    }));

    await expect(
      runLogin(
        config,
        { startUrl: ORG_START_URL },
        {
          ...harness.deps,
          listProfiles: async () => {
            throw new KiroManagementError("fixture secret", 403);
          },
        },
      ),
    ).rejects.toThrow(/profile discovery failed \(HTTP 403\).*No credentials were stored/);

    expect(harness.usageCalls).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });

  test("selects an explicitly requested profile from multiple available profiles", async () => {
    const secondArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE2";
    const harness = createHarness(
      [],
      async () => ({ email: "dev@example.com", usedCount: 0, limitCount: 1, overageCount: 0 }),
      "fresh-client",
      [
        { arn: PROFILE_ARN, profileName: "Primary" },
        { arn: secondArn, profileName: "Secondary" },
      ],
    );

    const result = await runLogin(
      config,
      { profileArn: secondArn, startUrl: ORG_START_URL },
      harness.deps,
    );

    expect(result.account.profileArn).toBe(secondArn);
    expect(harness.usageCalls[0]?.profileArn).toBe(secondArn);
    expect(harness.profileCalls.map(({ region }) => region)).toEqual(["us-east-1"]);
  });

  test("keeps the OIDC region separate from a profile in another region", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU_PROFILE";
    const harness = createHarness(
      [],
      async () => ({ email: "dev@example.com", usedCount: 0, limitCount: 1, overageCount: 0 }),
      "fresh-client",
      [{ arn: profileArn, profileName: "Europe" }],
    );

    const result = await runLogin(config, { startUrl: ORG_START_URL }, harness.deps);

    expect(harness.profileCalls.map(({ region }) => region)).toEqual(["us-east-1", "eu-central-1"]);
    expect(harness.usageCalls[0]).toMatchObject({
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
    expect(harness.inserted[0]).toMatchObject({
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
    expect(result.account).toMatchObject({
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
  });

  test("queries only the requested profile region when an ARN is explicit", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU_PROFILE";
    const harness = createHarness(
      [],
      async () => ({ email: "dev@example.com", usedCount: 0, limitCount: 1, overageCount: 0 }),
      "fresh-client",
      [{ arn: profileArn }],
    );

    const result = await runLogin(config, { profileArn, startUrl: ORG_START_URL }, harness.deps);

    expect(harness.profileCalls.map(({ region }) => region)).toEqual(["eu-central-1"]);
    expect(result.account).toMatchObject({
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
  });

  test("rejects an explicit profile ARN outside the supported control-plane regions", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/OTHER_PROFILE";
    const harness = createHarness([], async () => ({
      email: "dev@example.com",
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    }));

    await expect(
      runLogin(config, { profileArn, startUrl: ORG_START_URL }, harness.deps),
    ).rejects.toThrow(/unsupported region or invalid format/);

    expect(harness.profileCalls).toEqual([]);
    expect(harness.usageCalls).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });

  test("uses a unique start URL match and rejects an ambiguous profile list", async () => {
    const secondArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE2";
    const profiles = [
      { arn: PROFILE_ARN, startUrl: "https://first.awsapps.com/start" },
      { arn: secondArn, startUrl: "https://second.awsapps.com/start" },
    ];
    const usage = async () => ({
      email: "dev@example.com",
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    });
    const matched = createHarness([], usage, "fresh-client", profiles);
    const selected = await runLogin(
      config,
      { startUrl: "https://second.awsapps.com/" },
      matched.deps,
    );
    expect(selected.account.profileArn).toBe(secondArn);

    const ambiguous = createHarness([], usage, "fresh-client", profiles);
    await expect(runLogin(config, { startUrl: ORG_START_URL }, ambiguous.deps)).rejects.toThrow(
      /returned 2 available profiles.*--profile-arn/,
    );
    expect(ambiguous.inserted).toEqual([]);
  });

  test("derives distinct account IDs for distinct profiles of the same identity", async () => {
    const secondArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROFILE2";
    const profiles = [{ arn: PROFILE_ARN }, { arn: secondArn }];
    const usage = async () => ({
      email: "dev@example.com",
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    });
    const first = createHarness([], usage, "fresh-client", profiles);
    const second = createHarness([], usage, "fresh-client", profiles);

    const [a, b] = await Promise.all([
      runLogin(config, { profileArn: PROFILE_ARN, startUrl: ORG_START_URL }, first.deps),
      runLogin(config, { profileArn: secondArn, startUrl: ORG_START_URL }, second.deps),
    ]);

    expect(a.account.id).not.toBe(b.account.id);
  });

  test("fails before usage or persistence when no usable profile is available", async () => {
    const harness = createHarness(
      [],
      async () => ({ email: "dev@example.com", usedCount: 0, limitCount: 1, overageCount: 0 }),
      "fresh-client",
      [],
    );

    await expect(runLogin(config, { startUrl: ORG_START_URL }, harness.deps)).rejects.toThrow(
      /no available Kiro profile/i,
    );
    expect(harness.usageCalls).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });

  test("keeps a known profile during re-login without rediscovery", async () => {
    const selected = stored();
    const harness = createHarness([selected], async () => ({
      email: selected.email,
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    }));

    await runLogin(config, { replaceAccount: selected }, harness.deps);

    expect(harness.profileCalls).toEqual([]);
    expect(harness.usageCalls[0]?.profileArn).toBe(PROFILE_ARN);
  });

  test("keeps a known cross-region profile during re-login", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/EU_PROFILE";
    const selected = stored({ region: "eu-central-1", profileArn });
    const harness = createHarness([selected], async () => ({
      email: selected.email,
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    }));

    const result = await runLogin(config, { replaceAccount: selected }, harness.deps);

    expect(harness.profileCalls).toEqual([]);
    expect(harness.usageCalls[0]).toMatchObject({
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
    expect(result.account).toMatchObject({
      id: selected.id,
      region: "eu-central-1",
      oidcRegion: "us-east-1",
      profileArn,
    });
  });

  test("rejects changing the profile of an existing account ID", async () => {
    const selected = stored();
    const replacementArn = "arn:aws:codewhisperer:us-east-1:123456789012:profile/OTHER_PROFILE";
    const harness = createHarness(
      [selected],
      async () => ({
        email: selected.email,
        usedCount: 0,
        limitCount: 1,
        overageCount: 0,
      }),
      "fresh-client",
      [{ arn: PROFILE_ARN }, { arn: replacementArn }],
    );

    await expect(
      runLogin(config, { replaceAccount: selected, profileArn: replacementArn }, harness.deps),
    ).rejects.toThrow(/cannot change the Kiro profile bound to an existing account/);

    expect(harness.profileCalls).toEqual([]);
    expect(harness.usageCalls).toEqual([]);
    expect(harness.inserted).toEqual([]);
  });
});

describe("runLogin fresh login identity", () => {
  test("fetches usage before deriving the account ID and stores the real email", async () => {
    const harness = createHarness([], async () => ({
      email: "Real.Person@example.com",
      usedCount: 3,
      limitCount: 100,
      overageCount: 0,
    }));

    const result = await runLogin(config, {}, harness.deps);

    expect(harness.usageCalls).toHaveLength(1);
    expect(harness.usageCalls[0]).toMatchObject({
      access: "fresh-access",
      clientId: "fresh-client",
      authMethod: "idc",
    });
    expect(harness.usageOptions[0]).toMatchObject({ timeoutMs: 1_234 });
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      email: "Real.Person@example.com",
      usedCount: 3,
      limitCount: 100,
    });
    expect(harness.inserted[0]?.email).not.toBe(PLACEHOLDER);
    expect(result.account.email).toBe("Real.Person@example.com");
    expect(harness.stdout.at(-1)).toBe("Login successful: Real.Person@example.com");
    expect(harness.stderr).toEqual([]);
  });

  test("keeps the placeholder email and warns when the usage lookup fails", async () => {
    const harness = createHarness([], async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const result = await runLogin(config, {}, harness.deps);

    expect(result.account.email).toBe(PLACEHOLDER);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      email: PLACEHOLDER,
      usedCount: 0,
      limitCount: 0,
      lastSync: 0,
    });
    expect(harness.stderr).toHaveLength(1);
    expect(harness.stderr[0]).toContain("Warning");
    expect(harness.stderr[0]).toContain("getaddrinfo ENOTFOUND");
    expect(harness.stderr[0]).toContain(PLACEHOLDER);
    expect(harness.stdout.at(-1)).toBe(`Login successful: ${PLACEHOLDER}`);
  });

  test("warns when usage succeeds without an email", async () => {
    const harness = createHarness([], async () => ({
      usedCount: 1,
      limitCount: 50,
      overageCount: 0,
    }));

    const result = await runLogin(config, {}, harness.deps);

    expect(result.account.email).toBe(PLACEHOLDER);
    expect(result.account.usedCount).toBe(1);
    expect(harness.stderr).toHaveLength(1);
    expect(harness.stderr[0]).toContain("did not include an account email");
  });
});

describe("runLogin fresh login de-duplication", () => {
  test("treats the implicit and explicit Builder ID start URLs as one identity", async () => {
    const existing = stored({
      email: "free@example.com",
      profileArn: BUILDER_ID_PROFILE_ARN,
      startUrl: undefined,
    });
    const harness = createHarness([existing], async () => ({
      email: "FREE@example.com",
      usedCount: 2,
      limitCount: 50,
      overageCount: 0,
    }));

    const result = await runLogin(config, { startUrl: "https://view.awsapps.com/" }, harness.deps);

    expect(result.account.id).toBe(existing.id);
    expect(harness.inserted).toHaveLength(1);
    expect(harness.removed).toEqual([]);
  });

  test("updates the existing row for the same person instead of inserting a duplicate", async () => {
    const existing = stored({ startUrl: ORG_START_URL });
    const harness = createHarness([existing], async () => ({
      email: "DEV@example.com",
      usedCount: 7,
      limitCount: 100,
      overageCount: 0,
    }));

    const result = await runLogin(config, { startUrl: ORG_START_URL }, harness.deps);

    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      id: "existing-id",
      email: "DEV@example.com",
      clientId: "fresh-client",
      refreshToken: "fresh-refresh",
      accessToken: "fresh-access",
      lastUsed: 42,
      usedCount: 7,
    });
    expect(harness.removed).toEqual([]);
    expect(result.account.id).toBe("existing-id");
    expect(result.removedDuplicateIds).toEqual([]);
    expect(harness.stdout.at(-1)).toBe(
      "Login successful: DEV@example.com [existing-id] (updated existing account)",
    );
  });

  test("collapses earlier duplicate rows for the same person", async () => {
    const first = stored({
      id: "first-id",
      lastUsed: 10,
      startUrl: "https://acme.awsapps.com/start",
    });
    const second = stored({
      id: "second-id",
      startUrl: "https://acme.awsapps.com/start/",
    });
    const other = stored({
      id: "other-id",
      email: "someone-else@example.com",
      startUrl: "https://acme.awsapps.com/start",
    });
    const builderId = stored({ id: "builder-id-row" });
    const otherStartUrl = stored({
      id: "other-start-url",
      startUrl: "https://other.awsapps.com/start",
    });
    const harness = createHarness([first, second, other, builderId, otherStartUrl], async () => ({
      email: "dev@example.com",
      usedCount: 1,
      limitCount: 100,
      overageCount: 0,
    }));

    const result = await runLogin(
      config,
      { startUrl: "https://acme.awsapps.com/start" },
      harness.deps,
    );

    expect(harness.inserted[0]?.id).toBe("first-id");
    expect(harness.inserted[0]?.lastUsed).toBe(10);
    expect(harness.removed).toEqual(["second-id"]);
    expect(result.removedDuplicateIds).toEqual(["second-id"]);
    expect(harness.stdout).toContain("Removed 1 duplicate account record(s).");
  });

  test("matches on the normalized start URL used for the login", async () => {
    const existing = stored({ startUrl: "https://acme.awsapps.com/start" });
    const harness = createHarness([existing], async () => ({
      email: "dev@example.com",
      usedCount: 1,
      limitCount: 100,
      overageCount: 0,
    }));

    await runLogin(config, { startUrl: "https://acme.awsapps.com/landing/" }, harness.deps);
    expect(harness.inserted[0]?.id).not.toBe("existing-id");

    const matching = createHarness([existing], async () => ({
      email: "dev@example.com",
      usedCount: 1,
      limitCount: 100,
      overageCount: 0,
    }));
    await runLogin(config, { startUrl: "https://acme.awsapps.com/" }, matching.deps);
    expect(matching.inserted[0]?.id).toBe("existing-id");
  });

  test("never merges rows when the identity could not be verified", async () => {
    const placeholderRow = stored({
      id: "placeholder-row",
      email: PLACEHOLDER,
      profileArn: BUILDER_ID_PROFILE_ARN,
    });
    const harness = createHarness([placeholderRow], async () => {
      throw new Error("offline");
    });

    const result = await runLogin(config, {}, harness.deps);

    expect(result.account.id).not.toBe("placeholder-row");
    expect(harness.removed).toEqual([]);
  });

  test("derives distinct IDs for distinct verified emails", async () => {
    const a = createHarness([], async () => ({
      email: "a@example.com",
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    }));
    const b = createHarness([], async () => ({
      email: "b@example.com",
      usedCount: 0,
      limitCount: 1,
      overageCount: 0,
    }));

    const [resultA, resultB] = await Promise.all([
      runLogin(config, {}, a.deps),
      runLogin(config, {}, b.deps),
    ]);

    expect(resultA.account.id).not.toBe(resultB.account.id);
  });
});

describe("runLogin re-login", () => {
  test("fails closed when the usage lookup fails during re-login", async () => {
    const selected = stored();
    const harness = createHarness([selected], async () => {
      throw new Error("timeout");
    });

    await expect(runLogin(config, { replaceAccount: selected }, harness.deps)).rejects.toThrow(
      /usage verification failed.*No credentials were changed/,
    );
    expect(harness.inserted).toEqual([]);
  });

  test("upgrades a placeholder row to the verified email", async () => {
    const selected = stored({ email: PLACEHOLDER });
    const harness = createHarness([selected], async () => ({
      email: "dev@example.com",
      usedCount: 0,
      limitCount: 100,
      overageCount: 0,
    }));

    const result = await runLogin(config, { replaceAccount: selected }, harness.deps);

    expect(result.account.id).toBe("existing-id");
    expect(result.account.email).toBe("dev@example.com");
  });
});
