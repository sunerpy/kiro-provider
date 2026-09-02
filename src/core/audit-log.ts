import { createHash } from "node:crypto";

export type AuditLogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Readonly<Record<AuditLogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LEVEL: AuditLogLevel = "info";

let threshold: AuditLogLevel = DEFAULT_LEVEL;

/**
 * Sets the minimum level that `auditLog` emits. Levels order as
 * debug < info < warn < error; events below the threshold are dropped.
 * Called with `config.log_level` once configuration is loaded.
 */
export function setAuditLogLevel(level: AuditLogLevel): void {
  threshold = level;
}

export function getAuditLogLevel(): AuditLogLevel {
  return threshold;
}

/** Restores the built-in default (`info`). Intended for tests. */
export function resetAuditLogLevel(): void {
  threshold = DEFAULT_LEVEL;
}

export function auditHash(value: string): string {
  return createHash("sha256")
    .update("kiro-provider-audit-v1\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

export function auditLog(
  level: AuditLogLevel,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const present = Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
    ),
  );
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...present,
    }),
  );
}
