export type Intent =
  | "quote_lookup"
  | "booking"
  | "mission_status"
  | "support"
  | "unknown"

const QUOTE_CODE_PATTERN = /\bQ-\d{8}-\d+\b/i

const BOOKING_KEYWORDS = ["預約", "預定", "訂", "安排時間", "booking"]
const MISSION_KEYWORDS = ["進度", "任務", "施工", "排程", "mission", "status"]
const SUPPORT_KEYWORDS = ["客服", "幫助", "問題", "help", "support", "聯絡"]

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

export function detectIntent(text: string): Intent {
  if (QUOTE_CODE_PATTERN.test(text)) return "quote_lookup"
  if (matchesAny(text, BOOKING_KEYWORDS)) return "booking"
  if (matchesAny(text, MISSION_KEYWORDS)) return "mission_status"
  if (matchesAny(text, SUPPORT_KEYWORDS)) return "support"
  return "unknown"
}

export function extractQuoteCode(text: string): string | null {
  const match = text.toUpperCase().match(QUOTE_CODE_PATTERN)
  return match ? match[0] : null
}
