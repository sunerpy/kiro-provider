import { describe, expect, test } from "bun:test";
import { RequestDiagnostics } from "../src/core/request-diagnostics.js";
import { captureAuditEvents } from "./audit-test-helpers.js";

describe("queue and upstream timing audit", () => {
  test("separates waiting, preparation, headers and first frame without logging queue keys", async () => {
    const audit = captureAuditEvents();
    try {
      const diagnostics = new RequestDiagnostics("req-timing-fixture", ["private-fixture"]);
      const release = await diagnostics.waitForQueue("account", async () => {
        await Bun.sleep(20);
        return () => {};
      });
      await Bun.sleep(5);
      diagnostics.dispatch(1);
      diagnostics.headers(200, {});
      diagnostics.rawFrame();
      diagnostics.rawFrame();
      diagnostics.dispatch(2);
      release();
      const queue = audit.events("request_queue_wait");
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ queue: "account", outcome: "acquired" });
      expect(Number(queue[0]?.duration_ms)).toBeGreaterThanOrEqual(15);
      const attempts = audit.events("upstream_attempt_started");
      expect(Number(attempts[0]?.preparation_ms)).toBeGreaterThanOrEqual(1);
      expect(attempts[1]?.preparation_ms).toBeUndefined();
      expect(audit.events("upstream_headers_received")[0]?.wait_ms).toBeNumber();
      expect(audit.events("upstream_first_frame")).toHaveLength(1);
      expect(JSON.stringify(audit.events())).not.toContain("private-fixture");
    } finally {
      audit.restore();
    }
  });

  test("records an aborted queue without logging the rejection payload", async () => {
    const audit = captureAuditEvents();
    try {
      const diagnostics = new RequestDiagnostics("req-queue-abort");
      await expect(
        diagnostics.waitForQueue("session", async () => {
          throw new Error("private-fixture-reason");
        }),
      ).rejects.toThrow("private-fixture-reason");
      expect(audit.events("request_queue_wait")).toEqual([
        expect.objectContaining({ queue: "session", outcome: "aborted" }),
      ]);
      expect(JSON.stringify(audit.events())).not.toContain("private-fixture-reason");
    } finally {
      audit.restore();
    }
  });
});
