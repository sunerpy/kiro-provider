import { auditLog } from "../core/audit-log.js";
import { safeStep } from "../core/stream-cleanup.js";

export type ShutdownReason = "SIGTERM" | "SIGINT" | "lock_compromised";

/** The subset of `Bun.Server` the shutdown routine relies on. */
export interface ShutdownServer {
  stop(closeActiveConnections?: boolean): unknown;
  readonly pendingRequests?: number;
}

export interface GracefulShutdownOptions {
  readonly server: ShutdownServer;
  readonly maintenance?: { stop(): void };
  readonly lease?: { release(): void };
  readonly exit: (code: number) => void;
  readonly drainTimeoutMs: number;
  readonly drainPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type GracefulShutdown = (reason: ShutdownReason, exitCode: number) => Promise<void>;

export const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
export const DEFAULT_SHUTDOWN_POLL_MS = 50;

function settle(value: unknown): void {
  Promise.resolve(value).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Builds the single shutdown routine shared by signal handling and the
 * fail-closed single-instance lock: stop accepting connections, drain
 * in-flight requests within a bounded window (then force-close), stop
 * background maintenance, release the lock, and exit. Subsequent invocations
 * join the first run so overlapping SIGTERM/SIGINT deliveries cannot double
 * exit or reorder the steps.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const pollMs = options.drainPollMs ?? DEFAULT_SHUTDOWN_POLL_MS;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  const pendingRequests = (): number => options.server.pendingRequests ?? 0;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<boolean> => {
    const deadline = Date.now() + options.drainTimeoutMs;
    while (pendingRequests() > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(pollMs, remaining));
    }
    return true;
  };

  const run = async (reason: ShutdownReason, exitCode: number): Promise<void> => {
    const level = exitCode === 0 ? "info" : "error";
    auditLog(level, "server_shutdown_started", {
      reason,
      exit_code: exitCode,
      pending_requests: pendingRequests(),
      drain_timeout_ms: options.drainTimeoutMs,
    });
    // 1. Stop accepting new connections; in-flight requests keep running.
    safeStep(() => settle(options.server.stop(false)));
    // 2. Drain within the bounded window, then force-close what is left.
    const drained = await drain();
    if (!drained) safeStep(() => settle(options.server.stop(true)));
    // 3. Stop background maintenance and release the single-instance lock only
    //    once request work is finished so no second instance can overlap it.
    safeStep(() => options.maintenance?.stop());
    safeStep(() => options.lease?.release());
    auditLog(level, "server_shutdown_completed", {
      reason,
      exit_code: exitCode,
      drained,
      pending_requests: pendingRequests(),
    });
    options.exit(exitCode);
  };

  return (reason, exitCode) => {
    if (running === undefined) running = run(reason, exitCode);
    return running;
  };
}
