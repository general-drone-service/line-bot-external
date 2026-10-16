import crypto from "node:crypto"
import type { BotDb, ChatRow } from "./index"

/**
 * Client for the CRM edge function `line-bot-data` (CRM repo
 * supabase/functions/line-bot-data/handler.ts). The bot holds only this HMAC secret, never CRM
 * database credentials. `args` keys must match the RPC parameter names exactly.
 */

const TIMEOUT_MS = 5_000

/** X-Drone168 headers shared with line-inquiry-ingest: sha256= hex HMAC of "<unix seconds>.<raw body>". */
export function drone168SignedHeaders(secret: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  return {
    "Content-Type": "application/json",
    "X-Drone168-Timestamp": timestamp,
    "X-Drone168-Signature": `sha256=${signature}`,
  }
}

/** Non-200 from the gateway. `code` is the Postgres error code when the RPC failed (e.g. LB423 seal). */
export class GatewayError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(`line-bot-data ${action} -> ${status}: ${message}`)
  }
}

export function gatewayConfigured() {
  return Boolean(process.env.LINE_BOT_DATA_URL && process.env.LINE_BOT_DATA_SECRET)
}

export async function callGateway<T>(action: string, args: Record<string, unknown>): Promise<T> {
  const url = process.env.LINE_BOT_DATA_URL
  const secret = process.env.LINE_BOT_DATA_SECRET
  if (!url || !secret) throw new Error("Missing LINE_BOT_DATA_URL or LINE_BOT_DATA_SECRET")
  const body = JSON.stringify({ action, args })
  const res = await fetch(url, {
    method: "POST",
    headers: drone168SignedHeaders(secret, body),
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status !== 200) {
    const json = (await res.json().catch(() => null)) as { error?: string | { code?: string | null; message?: string } } | null
    const error = json?.error
    const code = typeof error === "object" ? error?.code ?? undefined : undefined
    const message = typeof error === "object" ? error?.message ?? "" : error ?? res.statusText
    throw new GatewayError(action, res.status, code, message)
  }
  // A 200 whose body cannot be read is not a success: callers act on `data` (claims, pause state)
  const json = (await res.json()) as { data?: unknown } | null
  if (!json || typeof json !== "object" || !("data" in json)) {
    throw new Error(`line-bot-data ${action}: 200 without data`)
  }
  return json.data as T
}

/** 422: data or constraint violation (CRM handler statusOf) — retrying cannot succeed. */
export const isTerminalGatewayError = (err: unknown) => err instanceof GatewayError && err.status === 422

export const gatewayBotDb: BotDb = {
  async recentMessages(userId, since, limit) {
    const rows = await callGateway<ChatRow[]>("history.load", { p_user_id: userId, p_since: since, p_limit: limit })
    return rows.map(({ role, content }) => ({ role, content }))
  },
  async insertMessage(row) {
    await callGateway("history.append", { p_id: row.id, p_user_id: row.user_id, p_role: row.role, p_content: row.content })
  },
  async pausedUntil(userId) {
    return (await callGateway<string | null>("pause.get", { p_user_id: userId })) ?? null
  },
  async setPause(userId, pausedUntil) {
    await callGateway("pause.set", { p_user_id: userId, p_paused_until: pausedUntil })
  },
  async clearPause(userId) {
    await callGateway("pause.clear", { p_user_id: userId })
  },
  matchKnowledge(embedding, count, threshold) {
    // The RPC casts a JSON-array string to vector(1024)
    return callGateway<unknown[]>("knowledge.match", {
      p_query_embedding: JSON.stringify(embedding),
      p_match_count: count,
      p_match_threshold: threshold,
    })
  },
}
