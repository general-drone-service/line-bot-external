export interface QuoteData {
  quote_code: string
  pricing: { total: number; valid_until: string }
  time_result: { suggested_days: number }
  expires_at?: string
  pdf_url?: string
}

const QUOTE_API_BASE = process.env.QUOTE_API_BASE_URL ?? "https://quote.drone168.com"

export async function lookupQuote(quoteCode: string): Promise<QuoteData | null> {
  try {
    const res = await fetch(`${QUOTE_API_BASE}/api/quote/lookup?code=${encodeURIComponent(quoteCode)}`, {
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok) return null
    const data = (await res.json()) as QuoteData
    return data
  } catch (err) {
    console.error("Failed to lookup quote:", quoteCode, err)
    return null
  }
}
