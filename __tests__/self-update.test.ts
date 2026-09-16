import { describe, expect, test } from "bun:test";
import {
  checkForUpdate,
  type FetchLike,
  formatSelfUpdateResult,
  formatUpdateCheck,
  formatVersion,
  redactProxyUrl,
  resolveUpdateProxyUrl,
  runSelfUpdate,
  type SelfUpdateResult,
  shouldParkOldImage,
} from "../src/cli/self-update.js";

const LATEST_URL = "https://api.github.com/repos/sunerpy/kiro-provider/releases/latest";
const TAG_URL = "https://api.github.com/repos/sunerpy/kiro-provider/releases/tags/v3.2.0";
const RELEASE_URL = "https://github.com/sunerpy/kiro-provider/releases/tag/v3.4.0";

type StubResponse = {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

type FetchRecord = { readonly url: string; readonly init?: RequestInit & { proxy?: string } };

function stubFetch(routes: Readonly<Record<string, StubResponse>>): {
  readonly fetch: FetchLike;
  readonly calls: FetchRecord[];
} {
  const calls: FetchRecord[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const route = routes[url];
    if (route === undefined) return new Response("missing", { status: 404 });
    return new Response(route.body ?? "", {
      status: route.status ?? 200,
      ...(route.headers ? { headers: { ...route.headers } } : {}),
    });
  };
  return { fetch: fetchImpl, calls };
}

function releaseBody(tag: string): string {
  return JSON.stringify({
    tag_name: tag,
    html_url: `https://github.com/sunerpy/kiro-provider/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
  });
}

async function rejectingConfirm(): Promise<boolean> {
  throw new Error("confirm must not be called");
}

describe("checkForUpdate", () => {
  test("reports a newer release", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      [LATEST_URL]: { body: releaseBody("v3.4.0") },
    });
    const check = await checkForUpdate({ currentVersion: "3.3.1", fetch: fetchImpl });
    expect(check).toEqual({
      currentVersion: "3.3.1",
      latestVersion: "3.4.0",
      latestTag: "v3.4.0",
      releaseUrl: RELEASE_URL,
      updateAvailable: true,
      localIsNewer: false,
    });
    expect(calls[0]?.url).toBe(LATEST_URL);
    expect(calls[0]?.init?.headers).toMatchObject({ accept: "application/vnd.github+json" });
  });

  test("reports an equal release as no update", async () => {
    const { fetch: fetchImpl } = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.3.1") } });
    const check = await checkForUpdate({ currentVersion: "3.3.1", fetch: fetchImpl });
    expect(check.updateAvailable).toBe(false);
    expect(check.localIsNewer).toBe(false);
  });

  test("reports a local build that is ahead of the newest release", async () => {
    const { fetch: fetchImpl } = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.3.1") } });
    const check = await checkForUpdate({ currentVersion: "3.4.0", fetch: fetchImpl });
    expect(check.updateAvailable).toBe(false);
    expect(check.localIsNewer).toBe(true);
  });

  test("queries the tag endpoint when a release is pinned", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ [TAG_URL]: { body: releaseBody("v3.2.0") } });
    const check = await checkForUpdate({
      currentVersion: "3.3.1",
      tag: "3.2.0",
      fetch: fetchImpl,
    });
    expect(calls[0]?.url).toBe(TAG_URL);
    expect(check.latestTag).toBe("v3.2.0");
    expect(check.updateAvailable).toBe(false);
  });

  test("passes the proxy through to fetch", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      [LATEST_URL]: { body: releaseBody("v3.4.0") },
    });
    await checkForUpdate({
      currentVersion: "3.3.1",
      proxyUrl: "http://127.0.0.1:7890",
      fetch: fetchImpl,
    });
    expect(calls[0]?.init?.proxy).toBe("http://127.0.0.1:7890");
  });

  test("resolves the documented environment proxy fallback itself", async () => {
    const fromEnv = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.4.0") } });
    await checkForUpdate({
      currentVersion: "3.3.1",
      fetch: fromEnv.fetch,
      env: { KIRO_PROVIDER_PROXY_URL: "http://env:2", HTTPS_PROXY: "http://shell:3" },
    });
    expect(fromEnv.calls[0]?.init?.proxy).toBe("http://env:2");

    const shell = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.4.0") } });
    await checkForUpdate({
      currentVersion: "3.3.1",
      fetch: shell.fetch,
      env: { HTTP_PROXY: "http://shell:5" },
    });
    expect(shell.calls[0]?.init?.proxy).toBe("http://shell:5");

    // An explicitly empty --proxy suppresses the environment fallback rather
    // than falling through to it; Bun's own HTTPS_PROXY handling is separate.
    const direct = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.4.0") } });
    await checkForUpdate({
      currentVersion: "3.3.1",
      proxyUrl: "",
      fetch: direct.fetch,
      env: { KIRO_PROVIDER_PROXY_URL: "http://env:2" },
    });
    expect(direct.calls[0]?.init?.proxy).toBeUndefined();
  });

  test("refuses release metadata that declares or streams more than the cap", async () => {
    const declared = stubFetch({
      [LATEST_URL]: { body: releaseBody("v3.4.0"), headers: { "content-length": "9999999" } },
    });
    await expect(
      checkForUpdate({ currentVersion: "3.3.1", fetch: declared.fetch, env: {} }),
    ).rejects.toThrow("Refusing to read 9999999 bytes of the latest release");

    // No content-length at all: the running total is what has to stop the read.
    const chunk = new Uint8Array(64 * 1024);
    const endless: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
      );
    await expect(
      checkForUpdate({ currentVersion: "3.3.1", fetch: endless, env: {} }),
    ).rejects.toThrow("exceeded 2097152 bytes");
  });

  test("rejects a pinned value that is not a release version", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});
    await expect(
      checkForUpdate({ currentVersion: "3.3.1", tag: "nightly", fetch: fetchImpl }),
    ).rejects.toThrow("Not a release version: nightly");
    expect(calls).toHaveLength(0);
  });

  test.each([
    { status: 404, message: "was not found (HTTP 404)" },
    { status: 403, message: "rate-limited" },
    { status: 429, message: "rate-limited" },
    { status: 500, message: "GitHub returned HTTP 500" },
  ])("surfaces HTTP $status as a typed failure", async ({ status, message }) => {
    const { fetch: fetchImpl } = stubFetch({ [LATEST_URL]: { status, body: "" } });
    await expect(checkForUpdate({ currentVersion: "3.3.1", fetch: fetchImpl })).rejects.toThrow(
      message,
    );
  });

  test("rejects invalid JSON and unexpected metadata", async () => {
    const invalid = stubFetch({ [LATEST_URL]: { body: "not json" } });
    await expect(checkForUpdate({ currentVersion: "3.3.1", fetch: invalid.fetch })).rejects.toThrow(
      "invalid JSON",
    );

    const unexpected = stubFetch({ [LATEST_URL]: { body: JSON.stringify({ name: "v3.4.0" }) } });
    await expect(
      checkForUpdate({ currentVersion: "3.3.1", fetch: unexpected.fetch }),
    ).rejects.toThrow("unexpected release metadata");

    const badTag = stubFetch({ [LATEST_URL]: { body: JSON.stringify({ tag_name: "nightly" }) } });
    await expect(checkForUpdate({ currentVersion: "3.3.1", fetch: badTag.fetch })).rejects.toThrow(
      "unrecognized release tag: nightly",
    );
  });

  test("falls back to the canonical release page when html_url is absent", async () => {
    const { fetch: fetchImpl } = stubFetch({
      [LATEST_URL]: { body: JSON.stringify({ tag_name: "v3.4.0" }) },
    });
    const check = await checkForUpdate({ currentVersion: "3.3.1", fetch: fetchImpl });
    expect(check.releaseUrl).toBe(RELEASE_URL);
  });

  test("reports an unreachable network as a typed failure", async () => {
    const failing: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(checkForUpdate({ currentVersion: "3.3.1", fetch: failing })).rejects.toThrow(
      "Unable to reach GitHub while fetching the latest release",
    );
  });

  test("cannot compare an unparseable local version", async () => {
    const { fetch: fetchImpl } = stubFetch({ [LATEST_URL]: { body: releaseBody("v3.4.0") } });
    await expect(checkForUpdate({ currentVersion: "dev", fetch: fetchImpl })).rejects.toThrow(
      "Cannot compare the installed version (dev)",
    );
  });
});

describe("resolveUpdateProxyUrl", () => {
  test("prefers the explicit flag, then the provider variable, then the shell variables", () => {
    expect(
      resolveUpdateProxyUrl("http://flag:1", {
        KIRO_PROVIDER_PROXY_URL: "http://env:2",
        HTTPS_PROXY: "http://shell:3",
      }),
    ).toBe("http://flag:1");
    expect(
      resolveUpdateProxyUrl(undefined, {
        KIRO_PROVIDER_PROXY_URL: "http://env:2",
        HTTPS_PROXY: "http://shell:3",
      }),
    ).toBe("http://env:2");
    expect(resolveUpdateProxyUrl(undefined, { HTTPS_PROXY: "http://shell:3" })).toBe(
      "http://shell:3",
    );
    expect(resolveUpdateProxyUrl(undefined, { https_proxy: "http://shell:4" })).toBe(
      "http://shell:4",
    );
    expect(resolveUpdateProxyUrl(undefined, { HTTP_PROXY: "http://shell:5" })).toBe(
      "http://shell:5",
    );
    expect(resolveUpdateProxyUrl(undefined, {})).toBeUndefined();
    expect(resolveUpdateProxyUrl("", { KIRO_PROVIDER_PROXY_URL: "" })).toBeUndefined();
  });

  test("rejects a malformed or non-http proxy", () => {
    expect(() => resolveUpdateProxyUrl("not a url", {})).toThrow("Invalid proxy URL");
    expect(() => resolveUpdateProxyUrl("socks5://127.0.0.1:1080", {})).toThrow(
      "Unsupported proxy protocol",
    );
  });

  test("treats an explicitly empty flag as no proxy, not a fallback", () => {
    expect(
      resolveUpdateProxyUrl("", {
        KIRO_PROVIDER_PROXY_URL: "http://env:2",
        HTTPS_PROXY: "http://shell:3",
      }),
    ).toBeUndefined();
  });

  test("never echoes proxy credentials when rejecting a malformed value", () => {
    for (const candidate of [
      "http://proxy-user:proxy-secret@",
      "http://proxy-user:pw@host:99999999999/path@tail",
      "://proxy-user:proxy-secret@host",
    ]) {
      let message = "";
      try {
        resolveUpdateProxyUrl(candidate, {});
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Invalid proxy URL");
      expect(message).not.toContain("proxy-secret");
      expect(message).not.toContain(":pw@");
    }

    let fromEnv = "";
    try {
      resolveUpdateProxyUrl(undefined, { HTTPS_PROXY: "http://shell-user:shell-secret@" });
    } catch (error) {
      fromEnv = error instanceof Error ? error.message : String(error);
    }
    expect(fromEnv).toContain("***@");
    expect(fromEnv).not.toContain("shell-secret");

    // A parseable proxy on an unsupported scheme reports the scheme only.
    let unsupported = "";
    try {
      resolveUpdateProxyUrl("socks5://proxy-user:proxy-secret@127.0.0.1:1080", {});
    } catch (error) {
      unsupported = error instanceof Error ? error.message : String(error);
    }
    expect(unsupported).toBe("Unsupported proxy protocol for the update download: socks5:");
  });
});

describe("redactProxyUrl", () => {
  test.each([
    { value: "http://user:secret@proxy:8080", expected: "http://***@proxy:8080" },
    { value: "http://user@proxy:8080/path", expected: "http://***@proxy:8080/path" },
    { value: "user:secret@proxy:8080", expected: "***@proxy:8080" },
    { value: "http://proxy:8080", expected: "http://proxy:8080" },
    // An `@` past the authority is part of the path and carries no credential.
    { value: "http://proxy:8080/a@b", expected: "http://proxy:8080/a@b" },
    { value: "", expected: "" },
  ])("redacts $value", ({ value, expected }) => {
    expect(redactProxyUrl(value)).toBe(expected);
  });
});

describe("shouldParkOldImage", () => {
  test("parks the old image only for a locked target on Windows", () => {
    for (const code of ["EACCES", "EBUSY", "EEXIST", "EPERM", "ETXTBSY", "UNKNOWN"]) {
      expect(shouldParkOldImage(Object.assign(new Error(code), { code }), "win32")).toBe(true);
      // POSIX renames over a running image, so a failure there is a real error.
      expect(shouldParkOldImage(Object.assign(new Error(code), { code }), "linux")).toBe(false);
    }
  });

  test("refuses to park for an unrelated failure", () => {
    expect(
      shouldParkOldImage(Object.assign(new Error("EISDIR"), { code: "EISDIR" }), "win32"),
    ).toBe(false);
    expect(shouldParkOldImage(new Error("no code"), "win32")).toBe(false);
    expect(shouldParkOldImage(undefined, "win32")).toBe(false);
  });
});

describe("runSelfUpdate guard rails", () => {
  test("refuses to replace an npm package install", async () => {
    await expect(
      runSelfUpdate(
        { currentVersion: "3.3.1", check: false, force: false, assumeYes: true },
        {
          confirm: rejectingConfirm,
          env: {},
          runtime: { entryPath: "/usr/lib/node_modules/@sunerpy/kiro-provider/dist" },
        },
      ),
    ).rejects.toThrow("self-update only replaces the standalone release binary");
  });

  test("refuses a platform with no published binary", async () => {
    await expect(
      runSelfUpdate(
        { currentVersion: "3.3.1", check: false, force: false, assumeYes: true },
        {
          confirm: rejectingConfirm,
          env: {},
          runtime: { entryPath: "/$bunfs/root", platform: "win32", arch: "arm64" },
        },
      ),
    ).rejects.toThrow("No release binary is published for win32-arm64");
  });

  test("reports a missing target binary instead of writing one", async () => {
    await expect(
      runSelfUpdate(
        { currentVersion: "3.3.1", check: false, force: false, assumeYes: true },
        {
          confirm: rejectingConfirm,
          env: {},
          runtime: {
            entryPath: "/$bunfs/root",
            platform: "linux",
            arch: "x64",
            executablePath: "/nonexistent/kiro-provider",
          },
        },
      ),
    ).rejects.toThrow("Cannot locate the installed binary to replace");
  });
});

describe("output formatting", () => {
  test("prints the bare version unchanged", () => {
    expect(formatVersion("3.3.1", false)).toEqual(["kiro-provider 3.3.1"]);
  });

  test("prints the version as JSON on request", () => {
    const parsed = JSON.parse(formatVersion("3.3.1", true)[0] ?? "{}") as {
      version: string;
      install_kind: string;
    };
    expect(parsed.version).toBe("3.3.1");
    // The suite runs from source, never from a compiled single-file binary.
    expect(parsed.install_kind).toBe("package");
  });

  test("renders an available update, an up-to-date check, and a newer local build", () => {
    const base = {
      currentVersion: "3.3.1",
      latestVersion: "3.4.0",
      latestTag: "v3.4.0",
      releaseUrl: RELEASE_URL,
    };
    expect(
      formatUpdateCheck({ ...base, updateAvailable: true, localIsNewer: false }, false),
    ).toEqual([
      "kiro-provider 3.3.1",
      `Latest release: 3.4.0 (${RELEASE_URL})`,
      "Update available. Install it with: kiro-provider self-update",
    ]);
    expect(
      formatUpdateCheck(
        { ...base, latestVersion: "3.3.1", updateAvailable: false, localIsNewer: false },
        false,
      ).at(-1),
    ).toBe("Already on the latest release.");
    expect(
      formatUpdateCheck(
        { ...base, latestVersion: "3.2.0", updateAvailable: false, localIsNewer: true },
        false,
      ).at(-1),
    ).toBe("This build is newer than the latest published release.");
  });

  test("renders the update check as JSON", () => {
    const lines = formatUpdateCheck(
      {
        currentVersion: "3.3.1",
        latestVersion: "3.4.0",
        latestTag: "v3.4.0",
        releaseUrl: RELEASE_URL,
        updateAvailable: true,
        localIsNewer: false,
      },
      true,
    );
    expect(JSON.parse(lines.join("\n"))).toEqual({
      version: "3.3.1",
      latest_version: "3.4.0",
      latest_tag: "v3.4.0",
      update_available: true,
      local_is_newer: false,
      release_url: RELEASE_URL,
    });
  });

  test.each([
    {
      label: "up-to-date",
      result: {
        status: "up-to-date",
        currentVersion: "3.3.1",
        latestVersion: "3.3.1",
        releaseUrl: RELEASE_URL,
        localIsNewer: false,
      } satisfies SelfUpdateResult,
      expected: "kiro-provider 3.3.1 is already the latest release.",
    },
    {
      label: "available",
      result: {
        status: "available",
        currentVersion: "3.3.1",
        latestVersion: "3.4.0",
        releaseUrl: RELEASE_URL,
        asset: "kiro-provider-linux-x64",
        executablePath: "/home/dev/.local/bin/kiro-provider",
      } satisfies SelfUpdateResult,
      expected: "Update available: 3.3.1 → 3.4.0",
    },
    {
      label: "cancelled",
      result: {
        status: "cancelled",
        currentVersion: "3.3.1",
        latestVersion: "3.4.0",
        executablePath: "/home/dev/.local/bin/kiro-provider",
      } satisfies SelfUpdateResult,
      expected: "Update cancelled. /home/dev/.local/bin/kiro-provider was not changed.",
    },
    {
      label: "updated",
      result: {
        status: "updated",
        currentVersion: "3.3.1",
        latestVersion: "3.4.0",
        releaseUrl: RELEASE_URL,
        asset: "kiro-provider-linux-x64",
        executablePath: "/home/dev/.local/bin/kiro-provider",
        sha256: "c".repeat(64),
      } satisfies SelfUpdateResult,
      expected: "Updated kiro-provider 3.3.1 → 3.4.0",
    },
  ])("renders the $label result", ({ result, expected }) => {
    expect(formatSelfUpdateResult(result, false)[0]).toBe(expected);
    const parsed = JSON.parse(formatSelfUpdateResult(result, true).join("\n")) as {
      status: string;
    };
    expect(parsed.status).toBe(result.status);
  });

  test("tells the operator to restart the service after a successful update", () => {
    const lines = formatSelfUpdateResult(
      {
        status: "updated",
        currentVersion: "3.3.1",
        latestVersion: "3.4.0",
        releaseUrl: RELEASE_URL,
        asset: "kiro-provider-linux-x64",
        executablePath: "/home/dev/.local/bin/kiro-provider",
        sha256: "c".repeat(64),
      },
      false,
    );
    expect(lines.at(-1)).toContain("systemctl --user restart kiro-provider.service");
    expect(lines.join("\n")).toContain(`Verified sha256: ${"c".repeat(64)}`);
  });

  test("does not call a locally newer build the latest release", () => {
    const result: SelfUpdateResult = {
      status: "up-to-date",
      currentVersion: "3.5.0",
      latestVersion: "3.4.0",
      releaseUrl: RELEASE_URL,
      localIsNewer: true,
    };
    expect(formatSelfUpdateResult(result, false)).toEqual([
      "kiro-provider 3.5.0 is newer than the latest release 3.4.0. Use --force to reinstall it, or --tag to pin a release.",
    ]);
    expect(JSON.parse(formatSelfUpdateResult(result, true).join("\n"))).toMatchObject({
      status: "up-to-date",
      version: "3.5.0",
      latest_version: "3.4.0",
      local_is_newer: true,
    });
  });
});
