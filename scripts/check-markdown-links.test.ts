import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMarkdownLinks, markdownAnchors } from "./check-markdown-links.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kiro-provider-markdown-links-"));
  mkdirSync(join(root, "docs"));
  return root;
}

describe("markdownAnchors", () => {
  test("matches GitHub underscores and duplicate heading suffixes", () => {
    expect(markdownAnchors("# Request `request_shape`\n# Repeat\n# Repeat")).toEqual(
      new Set(["request-request_shape", "repeat", "repeat-1"]),
    );
  });

  test("omits inline HTML tags without allowing tag fragments into anchors", () => {
    expect(
      markdownAnchors(
        "# Intro <span>overview</span>\n# <script>alert</script> Safety\n# Unsafe <tag",
      ),
    ).toEqual(new Set(["intro-overview", "alert-safety", "unsafe-tag"]));
  });
});

describe("checkMarkdownLinks", () => {
  test("accepts files, anchors, reference links, and fenced examples", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      [
        "[Guide](docs/guide.md#request-shape)",
        "[Reference][guide]",
        "[guide]: docs/guide.md",
        "```md",
        "[Ignored](missing.md)",
        "```",
      ].join("\n"),
    );
    writeFileSync(join(root, "docs/guide.md"), "# Request `shape`\n");

    const result = await checkMarkdownLinks(root);

    expect(result.problems).toEqual([]);
    expect(result.checkedCount).toBe(2);
  });

  test("reports missing targets and missing anchors", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      "[Missing](docs/missing.md)\n[Bad anchor](docs/guide.md#absent)\n",
    );
    writeFileSync(join(root, "docs/guide.md"), "# Present\n");

    const result = await checkMarkdownLinks(root);

    expect(result.problems).toEqual([
      { source: "README.md", target: "docs/missing.md", reason: "missing-target" },
      { source: "README.md", target: "docs/guide.md#absent", reason: "missing-anchor" },
    ]);
  });
});
