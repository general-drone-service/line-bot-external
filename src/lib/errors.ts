import Anthropic from "@anthropic-ai/sdk"

/**
 * Loggable form of an error. Anthropic SDK errors become fixed fields only (status, error type,
 * request id); Workers Logs otherwise show just the minified stack. The API's free-text message
 * and the connection cause are left out because nothing guarantees they never echo the request
 * (customer text). Other errors are returned unchanged.
 */
export function describeError(err: unknown): unknown {
  // Subclasses first: timeout extends connection error; neither has an HTTP status
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { status: null, type: "timeout", requestId: null }
  if (err instanceof Anthropic.APIConnectionError) return { status: null, type: "connection_error", requestId: null }
  if (err instanceof Anthropic.APIUserAbortError) return { status: null, type: "aborted", requestId: null }
  if (!(err instanceof Anthropic.APIError)) return err
  const body = err.error as { error?: { type?: string } } | undefined
  return { status: err.status ?? null, type: body?.error?.type ?? null, requestId: err.requestID ?? null }
}
