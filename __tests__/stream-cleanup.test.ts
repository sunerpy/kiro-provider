import { describe, expect, jest, mock, spyOn, test } from "bun:test";
import {
  boundedCleanup,
  CLEANUP_GRACE_MS,
  reportFinalizeError,
  runCleanupSteps,
  safeStep,
} from "../src/core/stream-cleanup.js";

async function captureUnhandledRejections(run: () => Promise<void>): Promise<readonly unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await run();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return reasons;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

describe("stream cleanup steps", () => {
  test("a throwing cleanup step does not skip later independent steps", () => {
    const failure = new Error("first cleanup failed");
    const calls: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        runCleanupSteps(
          () => {
            calls.push("first");
            throw failure;
          },
          () => calls.push("second"),
          () => calls.push("third"),
        ),
      ).not.toThrow();
      expect(calls).toEqual(["first", "second", "third"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.length).toBe(1);
      const logged = String(consoleError.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toMatchObject({
        level: "warn",
        event: "stream_cleanup_failed",
        error_type: "Error",
      });
      expect(logged).not.toContain(failure.message);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a throwing custom reporter is swallowed after exactly one invocation", () => {
    const failure = new Error("cleanup failed");
    const reporterFailure = new Error("reporter failed");
    const reporter = mock(() => {
      throw reporterFailure;
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        safeStep(() => {
          throw failure;
        }, reporter),
      ).not.toThrow();
      expect(reporter).toHaveBeenCalledTimes(1);
      expect(reporter).toHaveBeenCalledWith(failure);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("a custom reporter returning undefined does not also invoke the default reporter", () => {
    const failure = new Error("cleanup failed");
    const reporter = mock((_error: unknown): undefined => undefined);
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      safeStep(() => {
        throw failure;
      }, reporter);
      expect(reporter).toHaveBeenCalledTimes(1);
      expect(reporter).toHaveBeenCalledWith(failure);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("omitting a custom reporter invokes the default reporter exactly once", () => {
    const failure = new Error("cleanup failed");
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        safeStep(() => {
          throw failure;
        }),
      ).not.toThrow();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.length).toBe(1);
      const logged = String(consoleError.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toMatchObject({
        level: "warn",
        event: "stream_cleanup_failed",
        error_type: "Error",
      });
      expect(logged).not.toContain(failure.message);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("reportFinalizeError reports the cleanup failure without throwing", () => {
    const failure = new Error("cleanup failed");
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => reportFinalizeError(failure)).not.toThrow();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0]?.length).toBe(1);
      const logged = String(consoleError.mock.calls[0]?.[0]);
      expect(JSON.parse(logged)).toMatchObject({
        level: "warn",
        event: "stream_cleanup_failed",
        error_type: "Error",
      });
      expect(logged).not.toContain(failure.message);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("boundedCleanup", () => {
  test("captures a synchronous throw from the operation call and never rejects", async () => {
    const failure = new Error("synchronous cleanup failure");
    const operation = mock(() => {
      throw failure;
    });

    const unhandled = await captureUnhandledRejections(async () => {
      const cleanup = boundedCleanup(operation);
      expect(operation).not.toHaveBeenCalled();
      const result = await cleanup;
      expect(result).toBeUndefined();
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  test("absorbs an operation's rejected promise without an unhandled rejection", async () => {
    const failure = new Error("asynchronous cleanup failure");
    const operation = mock(() => Promise.reject(failure));

    const unhandled = await captureUnhandledRejections(async () => {
      const result = await boundedCleanup(operation);
      expect(result).toBeUndefined();
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });

  test("bounds a hanging operation at CLEANUP_GRACE_MS and never rejects", async () => {
    jest.useFakeTimers({ now: 0 });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const operation = mock(() => new Promise<void>(() => undefined));
      let settled = false;
      const cleanup = boundedCleanup(operation).then(() => {
        settled = true;
      });

      expect(operation).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(operation).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      jest.advanceTimersByTime(CLEANUP_GRACE_MS - 1);
      await Promise.resolve();
      expect(settled).toBe(false);

      jest.advanceTimersByTime(1);
      await cleanup;
      expect(settled).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      jest.useRealTimers();
    }
  });
});
