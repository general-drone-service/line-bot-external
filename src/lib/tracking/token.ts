import crypto from "node:crypto"

export const LINE_OA_BASIC_ID = "@058xfgns"

// Hex body: no "-" or "q", so a token can never be read as a quote code (Q-xxxxxxxx-xxx)
const TOKEN_RE = /L-[0-9a-f]{32}/
const WRAPPED_TOKEN_RE = /\s*〔來源：L-[0-9a-f]{32}〕/g

/** Same secret + idempotency key → same token, so a lost response can be rebuilt without storing the raw token. */
export function deriveToken(secret: string, idempotencyKey: string): string {
  const mac = crypto.createHmac("sha256", secret).update(`line-touch:${idempotencyKey}`).digest("hex")
  return `L-${mac.slice(0, 32)}`
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function extractToken(text: string): string | null {
  return text.match(TOKEN_RE)?.[0] ?? null
}

/** Removes the source code before text reaches the AI or chat_history. */
export function stripToken(text: string): string {
  return text
    .replace(WRAPPED_TOKEN_RE, "")
    .replace(new RegExp(`\\s*${TOKEN_RE.source}`, "g"), "")
    .trim()
}

export function prefillMessage(token: string): string {
  return `您好，我想了解外牆清洗服務。〔來源：${token}〕`
}

export function lineChatUrl(text: string): string {
  return `https://line.me/R/oaMessage/${encodeURIComponent(LINE_OA_BASIC_ID)}/?${encodeURIComponent(text)}`
}
