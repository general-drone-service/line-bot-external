export function normalizeQuoteCode(input: string): string {
  return input.trim().toUpperCase()
}

/**
 * Extracts quote code from raw user text.
 * Supports messages such as "我要報價單 Q-20260325-858 😕".
 */
export function extractQuoteCode(raw: string): string | null {
  const normalized = normalizeQuoteCode(raw)
  const match = normalized.match(/\bQ-\d{8}-\d+\b/)
  return match ? match[0] : null
}
