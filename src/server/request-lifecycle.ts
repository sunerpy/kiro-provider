export type IngressSignals = {
  readonly combined: AbortSignal;
  readonly deadline: AbortSignal;
  readonly client: AbortSignal;
  readonly requestId?: string;
  readonly deadlineAt?: number;
};

export interface RequestIdleTimeoutLease {
  disable(): void;
  restore(): void;
}

export type RequestIdleTimeoutLeaseMaker = (
  request: Request,
  server: Bun.Server<undefined>,
) => RequestIdleTimeoutLease | undefined;
