/**
 * Produces a payload-safe structural diff between a Kiro CLI/IDE request dump
 * and a kiro-provider SDK command dump.
 *
 * The input files may contain either a raw GenerateAssistantResponse input or
 * an envelope with `request`, `input`, or `commandInput`. Raw strings, tool
 * names, ids, signatures, credentials, and binary data are summarized before
 * any output is written.
 *
 * Usage:
 *   bun run scripts/kiro-cli-wire-diff.ts \
 *     --cli /tmp/kiro-cli-request.json \
 *     --provider /tmp/kiro-provider-request.json \
 *     [--out /tmp/kiro-wire-diff.json]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

const SENSITIVE_KEY =
  /authorization|access.?token|refresh.?token|client.?secret|signature|encrypted|credential|cookie/i;
const ID_KEY = /(^|_)(id|conversationId|agentContinuationId|toolUseId|callId|profileArn)$/i;
const TEXT_KEY = /content|text|innerContext|description|prompt|input|output/i;
const NAME_KEY = /(^|_)(name|toolName)$/i;
const SAFE_STRING_KEY =
  /^(modelId|model|origin|chatTriggerType|agentTaskType|format|status|type|role|stopReason)$/;

export interface SafeDiff {
  readonly path: string;
  readonly cli?: unknown;
  readonly provider?: unknown;
}

export interface WireDiffReport {
  readonly schema_version: 1;
  readonly cli_source_hash: string;
  readonly provider_source_hash: string;
  readonly cli: unknown;
  readonly provider: unknown;
  readonly differences: readonly SafeDiff[];
}

function hash16(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summary(label: string, value: string): string {
  return `<${label}:chars=${value.length}:sha256=${hash16(value)}>`;
}

function unwrapRequest(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of ["request", "input", "commandInput", "command_input"]) {
    const nested = value[key];
    if (isRecord(nested) && "conversationState" in nested) return nested;
  }
  return value;
}

export function sanitizeWireValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (value instanceof Uint8Array) {
    return `<bytes:length=${value.byteLength}:sha256=${hash16(value)}>`;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeWireValue(item, key));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, sanitizeWireValue(child, childKey)]),
    );
  }
  if (typeof value !== "string") return value;
  if (SAFE_STRING_KEY.test(key)) return value;
  if (ID_KEY.test(key)) return summary("id", value);
  if (NAME_KEY.test(key)) return summary("name", value);
  if (TEXT_KEY.test(key)) return summary("text", value);
  return summary("string", value);
}

export function diffSafeValues(cli: unknown, provider: unknown, path = "$"): SafeDiff[] {
  if (Object.is(cli, provider)) return [];
  if (Array.isArray(cli) && Array.isArray(provider)) {
    const differences: SafeDiff[] = [];
    const length = Math.max(cli.length, provider.length);
    for (let index = 0; index < length; index += 1) {
      differences.push(...diffSafeValues(cli[index], provider[index], `${path}[${index}]`));
    }
    return differences;
  }
  if (isRecord(cli) && isRecord(provider)) {
    const differences: SafeDiff[] = [];
    const keys = new Set([...Object.keys(cli), ...Object.keys(provider)]);
    for (const key of [...keys].sort()) {
      differences.push(...diffSafeValues(cli[key], provider[key], `${path}.${key}`));
    }
    return differences;
  }
  return [
    {
      path,
      ...(cli === undefined ? {} : { cli }),
      ...(provider === undefined ? {} : { provider }),
    },
  ];
}

export function buildWireDiffReport(
  cliBytes: Uint8Array,
  providerBytes: Uint8Array,
): WireDiffReport {
  const cliRaw: unknown = JSON.parse(new TextDecoder().decode(cliBytes));
  const providerRaw: unknown = JSON.parse(new TextDecoder().decode(providerBytes));
  const cli = sanitizeWireValue(unwrapRequest(cliRaw));
  const provider = sanitizeWireValue(unwrapRequest(providerRaw));
  return {
    schema_version: 1,
    cli_source_hash: createHash("sha256").update(cliBytes).digest("hex"),
    provider_source_hash: createHash("sha256").update(providerBytes).digest("hex"),
    cli,
    provider,
    differences: diffSafeValues(cli, provider),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main(): void {
  const cliPath = argument("--cli");
  const providerPath = argument("--provider");
  const outPath = argument("--out");
  if (!cliPath || !providerPath) {
    throw new Error(
      "usage: bun run scripts/kiro-cli-wire-diff.ts --cli <json> --provider <json> [--out <json>]",
    );
  }
  const report = buildWireDiffReport(readFileSync(cliPath), readFileSync(providerPath));
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, rendered, { mode: 0o600 });
  else process.stdout.write(rendered);
}

if (import.meta.main) main();
