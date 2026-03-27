/**
 * Public base URL for the quote app.
 * Override with NEXT_PUBLIC_QUOTE_APP_URL in deployment.
 */
export function getQuoteAppOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_QUOTE_APP_URL?.trim()
  if (raw) {
    try {
      return new URL(raw).origin
    } catch {
      /* fall through */
    }
  }
  return "https://quote.drone168.com"
}
