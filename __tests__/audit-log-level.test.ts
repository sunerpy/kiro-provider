import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  auditLog,
  getAuditLogLevel,
  resetAuditLogLevel,
  setAuditLogLevel,
} from "../src/core/audit-log.js";

function captureAuditLines(run: () => void): Array<Record<string, unknown>> {
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    run();
    return errorSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    errorSpy.mockRestore();
  }
}

afterEach(() => {
  resetAuditLogLevel();
});

describe("auditLog level threshold", () => {
  test("defaults to info and drops debug events", () => {
    expect(getAuditLogLevel()).toBe("info");

    const lines = captureAuditLines(() => {
      auditLog("debug", "debug_event");
      auditLog("info", "info_event");
      auditLog("warn", "warn_event");
      auditLog("error", "error_event");
    });

    expect(lines.map((line) => line.event)).toEqual(["info_event", "warn_event", "error_event"]);
  });

  test("emits no info lines at warn", () => {
    setAuditLogLevel("warn");

    const lines = captureAuditLines(() => {
      auditLog("info", "upstream_affinity_selected", { account_hash: "abc" });
      auditLog("debug", "noise");
      auditLog("warn", "protocol_projection_rejected", { code: "x" });
      auditLog("error", "boom");
    });

    expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
    expect(lines.some((line) => line.event === "upstream_affinity_selected")).toBe(false);
  });

  test("emits only errors at error and everything at debug", () => {
    setAuditLogLevel("error");
    const errorsOnly = captureAuditLines(() => {
      auditLog("warn", "w");
      auditLog("error", "e");
    });
    expect(errorsOnly.map((line) => line.event)).toEqual(["e"]);

    setAuditLogLevel("debug");
    const everything = captureAuditLines(() => {
      auditLog("debug", "d");
      auditLog("info", "i");
    });
    expect(everything.map((line) => line.event)).toEqual(["d", "i"]);
  });

  test("keeps the JSON line format and drops undefined fields", () => {
    const [line] = captureAuditLines(() => {
      auditLog("warn", "shape_check", {
        kept: 1,
        flag: false,
        empty: null,
        dropped: undefined,
      });
    });

    expect(line).toMatchObject({
      level: "warn",
      event: "shape_check",
      kept: 1,
      flag: false,
      empty: null,
    });
    expect(line).not.toHaveProperty("dropped");
    expect(typeof line?.timestamp).toBe("string");
  });

  test("resetAuditLogLevel restores the default", () => {
    setAuditLogLevel("error");
    resetAuditLogLevel();
    expect(getAuditLogLevel()).toBe("info");
  });
});
