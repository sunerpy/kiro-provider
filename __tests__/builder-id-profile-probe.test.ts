import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILDER_ID_SERVICE_PROFILE_ARN,
  inspectBuilderProfileBinary,
} from "../scripts/probe-builder-id-profile.js";
import { KIRO_AUTH_SERVICE } from "../src/kiro/constants.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("the Builder ID artifact probe finds a split service profile literal without executing the target", async () => {
  expect(BUILDER_ID_SERVICE_PROFILE_ARN).toBe(KIRO_AUTH_SERVICE.BUILDER_ID_PROFILE_ARN);
  root = mkdtempSync(join(tmpdir(), "builder-profile-probe-"));
  const path = join(root, "kiro-cli-fixture");
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.alloc(65_500, 0x61),
      Buffer.from(BUILDER_ID_SERVICE_PROFILE_ARN),
      Buffer.from("crates/fig_api_client/src/profile_resolver.rs"),
    ]),
  );

  const result = await inspectBuilderProfileBinary(path);

  expect(result).toMatchObject({
    file: "kiro-cli-fixture",
    service_profile_occurrences: 1,
    passed: true,
  });
  expect(result.source_markers["crates/fig_api_client/src/profile_resolver.rs"]).toBe(true);
  expect(result.sha256).toHaveLength(64);
});

test("the Builder ID artifact probe reports a binary with no matching routing evidence", async () => {
  root = mkdtempSync(join(tmpdir(), "builder-profile-probe-empty-"));
  const path = join(root, "unrelated-fixture");
  writeFileSync(path, "synthetic unrelated binary bytes");

  const result = await inspectBuilderProfileBinary(path);

  expect(result.service_profile_occurrences).toBe(0);
  expect(result.passed).toBe(false);
});
