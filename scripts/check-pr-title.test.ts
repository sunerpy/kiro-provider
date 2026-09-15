import { describe, expect, test } from "bun:test";
import { validatePullRequestTitle } from "./check-pr-title.js";

describe("validatePullRequestTitle", () => {
  test("accepts scoped project titles", () => {
    expect(validatePullRequestTitle("fix(ci): 精简发布验证链路")).toEqual({ ok: true });
    expect(validatePullRequestTitle("feat(api)!: 移除旧协议")).toEqual({ ok: true });
  });

  test("accepts the generated release title without a scope", () => {
    expect(validatePullRequestTitle("chore: release 3.2.6")).toEqual({
      ok: true,
      releaseVersion: "3.2.6",
    });
  });

  test("rejects unscoped normal titles and unsupported types", () => {
    expect(validatePullRequestTitle("fix: missing scope")).toEqual({
      ok: false,
      errors: ["normal project PR titles require a lowercase scope"],
    });
    expect(validatePullRequestTitle("update(ci): refresh workflow")).toEqual({
      ok: false,
      errors: ["unsupported type 'update'"],
    });
  });

  test("rejects malformed scope and trailing punctuation", () => {
    expect(validatePullRequestTitle("fix(CI): bad scope.")).toEqual({
      ok: false,
      errors: [
        "title must not end with punctuation",
        "title must use Conventional Commits: type(scope): subject",
      ],
    });
  });
});
