import { createClient } from "@supabase/supabase-js"

export interface QuoteData {
  quote_code: string
  pricing: { total: number; valid_until: string }
  time_result: { suggested_days: number }
  expires_at?: string
  pdf_url?: string
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return createClient(url, key)
}

export async function lookupQuote(quoteCode: string): Promise<QuoteData | null> {
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from("quotes")
      .select("quote_code, pricing, time_result, expires_at, pdf_url")
      .eq("quote_code", quoteCode)
      .maybeSingle()

    if (error) {
      console.error("Supabase query error:", error.message)
      return null
    }
    if (!data) return null
    return data as QuoteData
  } catch (err) {
    console.error("Failed to lookup quote:", quoteCode, err)
    return null
  }
}
