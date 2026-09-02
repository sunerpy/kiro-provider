export interface ProtocolFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly param?: string;
}

export type ProtocolResult<T> = { readonly ok: true; readonly value: T } | ProtocolFailure;

export function protocolFailure(code: string, message: string, param?: string): ProtocolFailure {
  return param === undefined ? { ok: false, code, message } : { ok: false, code, message, param };
}

export type AllowedKeysValidator = (
  value: Readonly<Record<string, unknown>>,
  path: string,
  allowed: ReadonlySet<string>,
) => ProtocolResult<undefined>;

/**
 * Build the strict allowed-key check shared by the Responses and Chat
 * adapters. Every key outside `allowed` fails closed as `unsupported_parameter`
 * with `param` pointing at the offending key; `label` names the protocol in
 * the message (for example `Responses field`).
 */
export function allowedKeysValidator(label: string): AllowedKeysValidator {
  return (value, path, allowed) => {
    for (const key of Object.keys(value)) {
      if (allowed.has(key)) continue;
      return protocolFailure(
        "unsupported_parameter",
        `${label} ${path}.${key} is not supported`,
        `${path}.${key}`,
      );
    }
    return { ok: true, value: undefined };
  };
}
