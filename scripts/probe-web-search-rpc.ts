/**
 * Live evidence probe for the provider-owned InvokeMCP web search client.
 *
 *   bun run scripts/probe-web-search-rpc.ts --out /tmp/web-search-rpc.json \
 *     [--accounts-db <copy>] [--proxy http://127.0.0.1:1080]
 *
 * Uses the same `listWebSearchTool` / `callWebSearch` code as the gateway with
 * one healthy us-east-1 account whose access token stays valid for at least
 * fifteen minutes. The account store is opened read-only and never refreshed
 * or written. Output holds only enums, counts, lengths, types and SHA-256
 * prefixes: no token, query, URL, title, snippet or backend message.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  callWebSearch,
  listWebSearchTool,
  type McpCallContext,
  WEB_SEARCH_USER_AGENT,
  webSearchErrorCode,
} from "../src/web-search/mcp-client.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function fail(code: string): never {
  process.stderr.write(`${JSON.stringify({ pass: false, code })}\n`);
  process.exit(1);
}

const QUERIES = [
  "Bun JavaScript runtime latest release notes",
  "TypeScript 5 release notes satisfies operator",
] as const;

async function main(): Promise<void> {
  const out = option("--out");
  if (!out) fail("output_required");
  const repository = resolve(import.meta.dir, "..");
  if (resolve(out).startsWith(`${repository}/`)) fail("evidence_must_be_outside_repository");
  const dbPath =
    option("--accounts-db") ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kiro-provider", "accounts.db");
  const database = new Database(dbPath, { readonly: true });
  const now = Date.now();
  const row = database
    .query<
      { id: string; access_token: string; profile_arn: string | null; region: string },
      [number, number]
    >(
      `SELECT id, access_token, profile_arn, region FROM accounts
       WHERE is_healthy = 1 AND expires_at > ? AND COALESCE(rate_limit_reset, 0) < ?
         AND profile_arn LIKE 'arn:aws:codewhisperer:us-east-1:%'
       ORDER BY used_count ASC LIMIT 1`,
    )
    .get(now + 15 * 60_000, now);
  database.close();
  if (!row?.profile_arn) fail("no_usable_account");
  const base: McpCallContext = {
    accessToken: row.access_token,
    profileArn: row.profile_arn,
    region: "us-east-1",
    ...(option("--proxy") ? { proxyUrl: option("--proxy") } : {}),
    signal: AbortSignal.timeout(120_000),
    timeoutMs: 15_000,
  };
  const evidence: Record<string, unknown> = {
    schema_version: 1,
    revision: process.env.KIRO_PROBE_REVISION ?? null,
    user_agent: WEB_SEARCH_USER_AGENT,
    account_hash: hash16(row.id),
    region: "us-east-1",
  };
  const tool = await listWebSearchTool(base);
  evidence.tools_list = {
    ok: true,
    name: tool.name,
    description_chars: tool.description.length,
    description_sha256_16: hash16(tool.description),
    input_schema_keys: Object.keys(tool.inputSchema).sort(),
    required: tool.inputSchema.required,
    fingerprint_16: tool.fingerprint.slice(0, 16),
    cites_inline_markdown_links: tool.description.includes("[description](url)"),
  };
  const searches = [];
  for (const query of QUERIES) {
    const outcome = await callWebSearch(base, query, 262_144);
    searches.push(
      outcome.ok
        ? {
            ok: true,
            duration_ms: outcome.durationMs,
            response_bytes: outcome.responseBytes,
            schema_version: outcome.result.schemaVersion,
            source_count: outcome.result.sources.length,
            total_results: outcome.result.totalResults,
            echo_equals_query: outcome.result.query === query,
            https_sources: outcome.result.sources.filter((source) =>
              source.url.startsWith("https:"),
            ).length,
            dated_sources: outcome.result.sources.filter(
              (source) => source.publishedDate !== undefined,
            ).length,
            verbatim_limits: [
              ...new Set(outcome.result.sources.map((source) => source.maxVerbatimWordLimit)),
            ],
            public_domain_values: [
              ...new Set(outcome.result.sources.map((source) => source.publicDomain)),
            ],
            domain_field_matches_host: outcome.result.sources.filter((source) => {
              const host = new URL(source.url).hostname;
              return host === source.domain || host.endsWith(`.${source.domain}`);
            }).length,
            max_snippet_chars: Math.max(
              0,
              ...outcome.result.sources.map((source) => source.snippet.length),
            ),
          }
        : { ok: false, failure: outcome.failure, status: outcome.status ?? null },
    );
  }
  evidence.searches = searches;
  const failures = [];
  for (const [label, query] of [
    ["over_backend_200_chars", "bun runtime release notes ".repeat(10).trim()],
    ["whitespace_only", "   "],
  ] as const) {
    const outcome = await callWebSearch(base, query, 262_144);
    failures.push({
      label,
      ok: outcome.ok,
      ...(outcome.ok
        ? {}
        : {
            failure: outcome.failure,
            public_error_code: webSearchErrorCode(outcome.failure),
            dispatched: outcome.dispatched,
          }),
    });
  }
  evidence.failures = failures;
  const pass =
    searches.every((search) => search.ok && (search.source_count as number) > 0) &&
    failures.every((entry) => !entry.ok);
  evidence.pass = pass;
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ pass, searches: searches.length })}\n`);
  if (!pass) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const failure =
    typeof error === "object" && error !== null && "failure" in error
      ? String((error as { failure: unknown }).failure)
      : "probe_failed";
  fail(failure);
});
