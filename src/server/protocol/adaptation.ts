export interface ProtocolFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly param?: string;
}

export type ProtocolResult<T> = { readonly ok: true; readonly value: T } | ProtocolFailure;

export function protocolFailure(
  code: string,
  message: string,
  param?: string,
): ProtocolFailure {
  return param === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, param };
}
