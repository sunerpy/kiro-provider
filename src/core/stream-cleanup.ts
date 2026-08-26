import { auditLog } from "./audit-log.js";

export const CLEANUP_GRACE_MS = 500;

export function reportFinalizeError(error: unknown): void {
  auditLog("warn", "stream_cleanup_failed", {
    error_type: error instanceof Error ? error.name : typeof error,
  });
}

export function safeStep(fn: () => void, onError?: (error: unknown) => void): void {
  try {
    fn();
  } catch (error) {
    const reporter = onError ?? reportFinalizeError;
    try {
      reporter(error);
    } catch {
      // Reporting failures must not recurse, retry, or escape cleanup.
    }
  }
}

export function runCleanupSteps(...steps: readonly (() => void)[]): void {
  for (const step of steps) safeStep(step);
}

export function boundedCleanup(operation: () => unknown): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const operationSettlement = Promise.resolve()
    .then(operation)
    .then(
      () => undefined,
      () => undefined,
    );
  const graceExpiry = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, CLEANUP_GRACE_MS);
  });

  return Promise.race([operationSettlement, graceExpiry]).then(
    () => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    },
    () => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    },
  );
}
