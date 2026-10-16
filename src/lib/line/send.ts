import crypto from "node:crypto"
import { getChannelAccessToken } from "./client"
import type { LineMessage } from "./types"

const LINE_API_BASE = "https://api.line.me/v2/bot/message"

/** A response from the LINE API with a non-2xx status (network failures throw the fetch error instead). */
export class LineApiError extends Error {
  constructor(readonly endpoint: string, readonly status: number) {
    super(`LINE API ${endpoint} failed: ${status}`)
  }
}

async function callLineApi(endpoint: string, body: Record<string, unknown>, retryKey?: string) {
  const token = getChannelAccessToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  if (retryKey) headers["X-Line-Retry-Key"] = retryKey
  const res = await fetch(`${LINE_API_BASE}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  // A retried push that LINE already accepted: the message was delivered by the earlier attempt
  if (retryKey && res.status === 409 && res.headers.get("x-line-accepted-request-id")) return
  if (!res.ok) {
    const text = await res.text()
    console.error(`LINE API ${endpoint} failed:`, res.status, text)
    // Surface to the webhook so a failed send is not acknowledged to LINE as success
    throw new LineApiError(endpoint, res.status)
  }
}

/** Deterministic UUID-formatted retry key, so a redelivered event's push is deduplicated by LINE (valid 24h). */
export function retryKeyFor(webhookEventId: string): string {
  const b = crypto.createHash("sha256").update(webhookEventId).digest().subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export async function reply(replyToken: string, messages: LineMessage[]) {
  await callLineApi("reply", { replyToken, messages })
}

export async function push(userId: string, messages: LineMessage[], retryKey?: string) {
  await callLineApi("push", { to: userId, messages }, retryKey)
}
