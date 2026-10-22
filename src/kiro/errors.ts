export class KiroTokenRefreshError extends Error {
  code?: string;
  originalError?: Error;
  readonly status?: number;
  readonly retryAt?: number;

  constructor(
    message: string,
    code?: string,
    originalError?: Error,
    metadata: { readonly status?: number; readonly retryAt?: number } = {},
  ) {
    super(message);
    this.name = "KiroTokenRefreshError";
    this.code = code;
    this.originalError = originalError;
    this.status = metadata.status;
    this.retryAt = metadata.retryAt;
  }
}
