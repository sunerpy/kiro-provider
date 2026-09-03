import { spyOn } from "bun:test";

export type AuditRecord = Readonly<Record<string, unknown>> & {
  readonly level: string;
  readonly event: string;
};

/**
 * Captures structured audit log lines (auditLog writes JSON to console.error)
 * so tests can assert on event names and fields without parsing prose.
 */
export function captureAuditEvents(): {
  readonly events: (name?: string) => AuditRecord[];
  readonly restore: () => void;
} {
  const records: AuditRecord[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const [line] = args;
    if (typeof line !== "string" || !line.startsWith("{")) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof Reflect.get(parsed, "event") === "string" &&
        typeof Reflect.get(parsed, "level") === "string"
      ) {
        records.push(parsed as AuditRecord);
      }
    } catch {
      // Not an audit line.
    }
  });
  return {
    events: (name) => (name === undefined ? [...records] : records.filter((r) => r.event === name)),
    restore: () => spy.mockRestore(),
  };
}
