import { createHash } from "node:crypto";

export function auditHash(value: string): string {
  return createHash("sha256")
    .update("kiro-provider-audit-v1\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

export function auditLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null | undefined>> = {},
): void {
  const present = Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string | number | boolean | null] =>
      entry[1] !== undefined,
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
