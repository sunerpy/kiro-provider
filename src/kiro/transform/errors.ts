export class RequestTransformError extends Error {
  readonly name = 'RequestTransformError'

  constructor(
    message: string,
    readonly code = 'invalid_request',
    readonly param?: string
  ) {
    super(message)
  }
}
