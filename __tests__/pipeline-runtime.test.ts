import { describe, expect, spyOn, test } from "bun:test";
import { abortableSleep } from "../src/core/pipeline-runtime.js";

describe("abortableSleep", () => {
  test("resolves after the delay when the signal stays quiet", async () => {
    const startedAt = Date.now();

    await abortableSleep(20, new AbortController().signal);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  test("resolves immediately for a non-positive delay", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      await expect(abortableSleep(0, new AbortController().signal)).resolves.toBeUndefined();
      await expect(abortableSleep(-5, new AbortController().signal)).resolves.toBeUndefined();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("rejects right away for an already-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new DOMException("gone", "AbortError");
    controller.abort(reason);

    await expect(abortableSleep(60_000, controller.signal)).rejects.toBe(reason);
  });

  test("rejects promptly on abort and clears the underlying timer (C7)", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Request deadline exceeded", "TimeoutError");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const sleeping = abortableSleep(60_000, controller.signal);
      const startedAt = Date.now();

      controller.abort(reason);

      await expect(sleeping).rejects.toBe(reason);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("does not leave an abort listener behind after a completed sleep", async () => {
    const controller = new AbortController();
    const removeListener = spyOn(controller.signal, "removeEventListener");
    try {
      await abortableSleep(5, controller.signal);

      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      removeListener.mockRestore();
    }
  });
});
