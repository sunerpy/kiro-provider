import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "coverage", "dist"]);
const EXTERNAL_SCHEMES = ["http:", "https:", "mailto:", "tel:", "data:"];

export type MarkdownLinkProblem = {
  readonly source: string;
  readonly target: string;
  readonly reason: "missing-target" | "missing-anchor";
};

export type MarkdownLinkResult = {
  readonly fileCount: number;
  readonly checkedCount: number;
  readonly problems: readonly MarkdownLinkProblem[];
};

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isIgnored(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((part) => IGNORED_DIRECTORIES.has(part));
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/^\s*(```|~~~).*?^\s*\1\s*$/gms, "");
}

function stripInlineHtmlTags(text: string): string {
  let plain = "";
  let offset = 0;

  while (offset < text.length) {
    const open = text.indexOf("<", offset);
    if (open === -1) return plain + text.slice(offset);

    plain += text.slice(offset, open);
    const close = text.indexOf(">", open + 1);
    if (close === -1) return plain + text.slice(open + 1);
    offset = close + 1;
  }

  return plain;
}

function githubSlug(text: string): string {
  const plain = stripInlineHtmlTags(text).replace(/[`*~]/g, "").trim().toLocaleLowerCase();
  return Array.from(plain)
    .filter((character) => /[\p{L}\p{N}\s_-]/u.test(character))
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function markdownAnchors(markdown: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of stripFencedCode(markdown).split("\n")) {
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match?.[1]) continue;
    const base = githubSlug(match[1]);
    const duplicate = seen.get(base) ?? 0;
    seen.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return anchors;
}

function linkTargets(markdown: string): readonly string[] {
  const text = stripFencedCode(markdown);
  const targets: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    if (match[1]) targets.push(match[1]);
  }
  for (const line of text.split("\n")) {
    const match = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
    const target = match?.[1] ?? match?.[2];
    if (target) targets.push(target);
  }
  return targets;
}

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close !== -1) return trimmed.slice(1, close);
  }
  return trimmed.split(/\s+["']/u, 1)[0] ?? "";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function targetExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function checkMarkdownLinks(root = "."): Promise<MarkdownLinkResult> {
  const absoluteRoot = resolve(root);
  const files = [...(await Array.fromAsync(new Bun.Glob("**/*.md").scan(absoluteRoot)))]
    .map(normalizePath)
    .filter((path) => !isIgnored(path))
    .sort();
  const anchorCache = new Map<string, ReadonlySet<string>>();
  const problems: MarkdownLinkProblem[] = [];
  let checkedCount = 0;

  const anchorsFor = (path: string): ReadonlySet<string> => {
    const cached = anchorCache.get(path);
    if (cached) return cached;
    const anchors = markdownAnchors(readFileSync(path, "utf8"));
    anchorCache.set(path, anchors);
    return anchors;
  };

  for (const source of files) {
    const absoluteSource = resolve(absoluteRoot, source);
    for (const rawTarget of linkTargets(readFileSync(absoluteSource, "utf8"))) {
      const target = normalizeTarget(rawTarget);
      if (!target || EXTERNAL_SCHEMES.some((scheme) => target.startsWith(scheme))) continue;
      checkedCount += 1;

      const [rawPath = "", rawFragment] = target.split("#", 2);
      const targetPath = rawPath
        ? resolve(absoluteSource, "..", safeDecode(rawPath))
        : absoluteSource;
      if (!targetExists(targetPath)) {
        problems.push({ source, target, reason: "missing-target" });
        continue;
      }
      if (!rawFragment || !targetPath.toLocaleLowerCase().endsWith(".md")) continue;

      const fragment = safeDecode(rawFragment).toLocaleLowerCase();
      if (!anchorsFor(targetPath).has(fragment)) {
        problems.push({ source, target, reason: "missing-anchor" });
      }
    }
  }

  return { fileCount: files.length, checkedCount, problems };
}

async function main(): Promise<number> {
  const result = await checkMarkdownLinks(process.argv[2] ?? ".");
  if (result.problems.length === 0) {
    console.log(
      `markdown-links: PASS (${result.fileCount} files, ${result.checkedCount} local links and anchors)`,
    );
    return 0;
  }
  console.error(`markdown-links: FAIL (${result.problems.length} problem(s))`);
  for (const problem of result.problems) {
    console.error(`  ${problem.source}: ${problem.target} (${problem.reason})`);
  }
  return 1;
}

if (import.meta.main) process.exitCode = await main();
