import Anthropic from "@anthropic-ai/sdk"

/**
 * Loggable form of an error. Anthropic SDK errors become fixed fields only (status, error type,
 * request id); Workers Logs otherwise show just the minified stack. The API's free-text message
 * and the connection cause are left out because nothing guarantees they never echo the request
 * (customer text). Other errors keep only name, numeric status and code: their message can carry
 * secrets (a malformed API key lands in the SDK's header error) or customer text.
 */
export function describeError(err: unknown): { status: number | null; type: string | null; requestId: string | null } {
  // Subclasses first: timeout extends connection error; neither has an HTTP status
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { status: null, type: "timeout", requestId: null }
  if (err instanceof Anthropic.APIConnectionError) return { status: null, type: "connection_error", requestId: null }
  if (err instanceof Anthropic.APIUserAbortError) return { status: null, type: "aborted", requestId: null }
  if (!(err instanceof Anthropic.APIError)) {
    if (!(err instanceof Error)) return { status: null, type: null, requestId: null }
    const { status, code } = err as { status?: unknown; code?: unknown }
    return { status: typeof status === "number" ? status : null, type: typeof code === "string" ? code : err.name, requestId: null }
  }
  const body = err.error as { error?: { type?: string } } | undefined
  return { status: err.status ?? null, type: body?.error?.type ?? null, requestId: err.requestID ?? null }
}
