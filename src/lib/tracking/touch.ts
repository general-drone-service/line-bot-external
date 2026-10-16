import { NextResponse } from "next/server"
import { supabaseTouchStore, trackingEnabled, type TouchStore } from "./store"
import { deriveToken, hashToken, lineChatUrl, prefillMessage } from "./token"

const SOURCE_KEY_RE = /^[a-z0-9_]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_TTL_DAYS = 30
// Far above real ad traffic; bounds table growth if the public endpoint is scripted (per-IP limits belong in the WAF)
const MAX_NEW_TOUCHES_PER_MINUTE = 120
const MAX_BODY_BYTES = 1024

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

/**
 * POST { source, idempotencyKey } → { url, message }. Only enabled sources create a touch, and the
 * destination is always the official account, so this cannot be used as an open redirect.
 */
export async function handleTouchRequest(request: Request, store: TouchStore = supabaseTouchStore): Promise<Response> {
  // JSON only: a cross-site <form> or text/plain POST cannot create touches without a CORS preflight
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Unsupported content type" }, 415)
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "Body too large" }, 413)
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json({ error: "Body too large" }, 413)
  let input: { source?: unknown; idempotencyKey?: unknown }
  try {
    input = JSON.parse(raw)
  } catch {
    return json({ error: "Invalid JSON" }, 400)
  }
  const { source, idempotencyKey } = input ?? {}
  if (typeof source !== "string" || !SOURCE_KEY_RE.test(source)) return json({ error: "Invalid source" }, 400)
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) {
    return json({ error: "Invalid idempotencyKey" }, 400)
  }

  const secret = process.env.LINE_TRACKING_TOKEN_SECRET
  if (!secret || !trackingEnabled()) {
    console.error("LINE touch rejected: LINE_TRACKING_TOKEN_SECRET is not set")
    return json({ error: "Not configured" }, 503)
  }
  const ttlDays = Number(process.env.LINE_TRACKING_TOKEN_TTL_DAYS) || DEFAULT_TTL_DAYS

  const key = idempotencyKey.toLowerCase()
  const token = deriveToken(secret, key)
  try {
    const touch = await store.createTouch(source, key, hashToken(token), ttlDays, MAX_NEW_TOUCHES_PER_MINUTE)
    if (!touch) return json({ error: "Unknown source" }, 404)
  } catch (err) {
    if (err instanceof Error && err.message.includes("idempotency_conflict")) {
      return json({ error: "Idempotency key already used" }, 409)
    }
    if (err instanceof Error && err.message.includes("rate_limited")) {
      return json({ error: "Too many requests" }, 429)
    }
    console.error("LINE touch failed:", err)
    return json({ error: "Internal error" }, 500)
  }

  const message = prefillMessage(token)
  return json({ url: lineChatUrl(message), message }, 200)
}
