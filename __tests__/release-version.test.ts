import { describe, expect, test } from "bun:test";
import {
  CHECKSUM_MANIFEST_NAME,
  compareVersionStrings,
  detectInstallKind,
  isCompiledEntryPath,
  normalizeReleaseTag,
  parseChecksumManifest,
  parseSemanticVersion,
  RELEASE_ASSET_NAMES,
  releaseAssetName,
  releaseAssetUrl,
  releasePageUrl,
  releaseVersionFromTag,
} from "../src/cli/release-version.js";

describe("parseSemanticVersion", () => {
  test("accepts plain, tagged, prerelease, and build-metadata versions", () => {
    expect(parseSemanticVersion("3.3.1")).toEqual({
      major: 3,
      minor: 3,
      patch: 1,
      prerelease: [],
    });
    expect(parseSemanticVersion("v10.0.2")).toEqual({
      major: 10,
      minor: 0,
      patch: 2,
      prerelease: [],
    });
    expect(parseSemanticVersion("3.4.0-rc.1")?.prerelease).toEqual(["rc", "1"]);
    expect(parseSemanticVersion("3.4.0+build.5")?.prerelease).toEqual([]);
  });

  test.each(["", "3.4", "3.4.0.1", "next", "v", "3.4.0-", "-1.0.0"])(
    "rejects %p",
    (candidate: string) => {
      expect(parseSemanticVersion(candidate)).toBeUndefined();
    },
  );
});

describe("compareVersionStrings", () => {
  test.each([
    { left: "3.3.1", right: "3.4.0", expected: -1 },
    { left: "3.4.0", right: "3.3.1", expected: 1 },
    { left: "3.4.0", right: "v3.4.0", expected: 0 },
    { left: "3.10.0", right: "3.9.9", expected: 1 },
    { left: "4.0.0", right: "3.99.99", expected: 1 },
    { left: "3.4.1", right: "3.4.0", expected: 1 },
  ])("orders $left against $right", ({ left, right, expected }) => {
    expect(compareVersionStrings(left, right)).toBe(expected);
  });

  test("orders prereleases below the matching stable release", () => {
    expect(compareVersionStrings("3.4.0-rc.1", "3.4.0")).toBe(-1);
    expect(compareVersionStrings("3.4.0", "3.4.0-rc.1")).toBe(1);
    expect(compareVersionStrings("3.4.0-rc.1", "3.4.0-rc.2")).toBe(-1);
    expect(compareVersionStrings("3.4.0-rc.2", "3.4.0-rc.10")).toBe(-1);
    expect(compareVersionStrings("3.4.0-alpha", "3.4.0-beta")).toBe(-1);
    expect(compareVersionStrings("3.4.0-rc", "3.4.0-rc.1")).toBe(-1);
    expect(compareVersionStrings("3.4.0-1", "3.4.0-alpha")).toBe(-1);
    expect(compareVersionStrings("3.4.0-rc.1", "3.4.0-rc.1")).toBe(0);
  });

  test("returns undefined when either side is not a release version", () => {
    expect(compareVersionStrings("3.3.1", "latest")).toBeUndefined();
    expect(compareVersionStrings("dev", "3.3.1")).toBeUndefined();
  });
});

describe("release tags", () => {
  test("normalizes versions and tags to the published tag format", () => {
    expect(normalizeReleaseTag("3.4.0")).toBe("v3.4.0");
    expect(normalizeReleaseTag("v3.4.0")).toBe("v3.4.0");
    expect(normalizeReleaseTag("  3.4.0  ")).toBe("v3.4.0");
    expect(normalizeReleaseTag("3.4.0-rc.1")).toBe("v3.4.0-rc.1");
    expect(normalizeReleaseTag("latest")).toBeUndefined();
  });

  test("strips the tag prefix and builds release URLs", () => {
    expect(releaseVersionFromTag("v3.4.0")).toBe("3.4.0");
    expect(releaseVersionFromTag("3.4.0")).toBe("3.4.0");
    expect(releasePageUrl("v3.4.0")).toBe(
      "https://github.com/sunerpy/kiro-provider/releases/tag/v3.4.0",
    );
    expect(releaseAssetUrl("v3.4.0", CHECKSUM_MANIFEST_NAME)).toBe(
      "https://github.com/sunerpy/kiro-provider/releases/download/v3.4.0/SHA256SUMS",
    );
  });
});

describe("releaseAssetName", () => {
  test.each([
    { platform: "linux", arch: "x64", expected: "kiro-provider-linux-x64" },
    { platform: "linux", arch: "arm64", expected: "kiro-provider-linux-arm64" },
    { platform: "darwin", arch: "x64", expected: "kiro-provider-darwin-x64" },
    { platform: "darwin", arch: "arm64", expected: "kiro-provider-darwin-arm64" },
    { platform: "win32", arch: "x64", expected: "kiro-provider-windows-x64.exe" },
  ])("maps $platform-$arch to its published asset", ({ platform, arch, expected }) => {
    expect(releaseAssetName(platform, arch)).toBe(expected);
  });

  test.each([
    { platform: "win32", arch: "arm64" },
    { platform: "linux", arch: "ia32" },
    { platform: "freebsd", arch: "x64" },
  ])("has no asset for $platform-$arch", ({ platform, arch }) => {
    expect(releaseAssetName(platform, arch)).toBeUndefined();
  });

  test("exposes every published asset name for error messages", () => {
    expect(RELEASE_ASSET_NAMES).toEqual([
      "kiro-provider-darwin-arm64",
      "kiro-provider-darwin-x64",
      "kiro-provider-linux-arm64",
      "kiro-provider-linux-x64",
      "kiro-provider-windows-x64.exe",
    ]);
  });
});

describe("parseChecksumManifest", () => {
  const digest = "a".repeat(64);
  const other = "b".repeat(64);

  test("parses sha256sum lines, tolerating the binary marker and blank lines", () => {
    const manifest = [
      `${digest}  kiro-provider-linux-x64`,
      "",
      `${other.toUpperCase()} *kiro-provider-windows-x64.exe`,
      "# a comment",
      "not a checksum line",
    ].join("\n");
    const digests = parseChecksumManifest(manifest);
    expect(digests.get("kiro-provider-linux-x64")).toBe(digest);
    expect(digests.get("kiro-provider-windows-x64.exe")).toBe(other);
    expect(digests.size).toBe(2);
  });

  test("keeps the first entry for a duplicated asset name", () => {
    const manifest = `${digest}  asset\n${other}  asset\n`;
    expect(parseChecksumManifest(manifest).get("asset")).toBe(digest);
  });

  test("ignores truncated digests", () => {
    expect(parseChecksumManifest(`${"a".repeat(63)}  asset`).size).toBe(0);
    expect(parseChecksumManifest(`${"a".repeat(65)}  asset`).size).toBe(0);
  });
});

describe("detectInstallKind", () => {
  test.each([
    "/$bunfs/root/main.js",
    "/$bunfs/root",
    "B:\\~BUN\\root\\main.js",
    "b:/~bun/root/cli/main.js",
  ])("treats %p as a compiled binary", (entryPath: string) => {
    expect(isCompiledEntryPath(entryPath)).toBe(true);
    expect(detectInstallKind(entryPath)).toBe("binary");
  });

  test.each([
    "/home/dev/kiro-provider/src/cli",
    "/usr/lib/node_modules/@sunerpy/kiro-provider/dist",
    "C:\\Users\\dev\\project\\src\\cli",
  ])("treats %p as a package install", (entryPath: string) => {
    expect(isCompiledEntryPath(entryPath)).toBe(false);
    expect(detectInstallKind(entryPath)).toBe("package");
  });
});
