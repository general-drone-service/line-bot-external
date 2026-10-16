import crypto from "node:crypto"
import { createClient } from "@supabase/supabase-js"

/**
 * The bot's own tables (chat_history, bot_pause, knowledge_chunks) behind one interface, so the
 * CRM migration only swaps the implementation. Methods throw on failure; errors carry the
 * database `code` so callers can recognise the cutover seal.
 */
export interface BotDb {
  recentMessages(userId: string, since: string, limit: number): Promise<ChatRow[]>
  /** Idempotent on `id`: a row that already exists is left as is. */
  insertMessage(row: NewChatRow): Promise<void>
  pausedUntil(userId: string): Promise<string | null>
  setPause(userId: string, pausedUntil: string): Promise<void>
  clearPause(userId: string): Promise<void>
  matchKnowledge(embedding: number[], count: number, threshold: number): Promise<unknown[]>
}

export interface ChatRow {
  role: "user" | "assistant"
  content: string
}

export interface NewChatRow extends ChatRow {
  id: string
  user_id: string
}

/** SQLSTATE raised by the cutover seal trigger on the source tables. */
export const SEALED_CODE = "LB423"

export const isSealed = (err: unknown) => (err as { code?: string } | null)?.code === SEALED_CODE

export const cutoverFrozen = () => process.env.BOT_CUTOVER_FREEZE === "on"

export class CutoverFrozenError extends Error {
  constructor() {
    super("bot database cutover in progress")
  }
}

function dbError(error: { message: string; code?: string }) {
  return Object.assign(new Error(error.message), { code: error.code })
}

export function supabaseBotDb(url: string, key: string): BotDb {
  const db = createClient(url, key)
  return {
    async recentMessages(userId, since, limit) {
      const { data, error } = await db
        .from("chat_history")
        .select("role, content")
        .eq("user_id", userId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (error) throw dbError(error)
      return (data ?? []) as ChatRow[]
    },
    async insertMessage(row) {
      const { error } = await db.from("chat_history").upsert(row, { onConflict: "id", ignoreDuplicates: true })
      if (error) throw dbError(error)
    },
    async pausedUntil(userId) {
      const { data, error } = await db.from("bot_pause").select("paused_until").eq("user_id", userId).maybeSingle()
      if (error) throw dbError(error)
      return data?.paused_until ?? null
    },
    async setPause(userId, pausedUntil) {
      const { error } = await db
        .from("bot_pause")
        .upsert({ user_id: userId, paused_until: pausedUntil }, { onConflict: "user_id" })
      if (error) throw dbError(error)
    },
    async clearPause(userId) {
      const { error } = await db.from("bot_pause").delete().eq("user_id", userId)
      if (error) throw dbError(error)
    },
    async matchKnowledge(embedding, count, threshold) {
      const { data, error } = await db.rpc("match_knowledge", {
        query_embedding: embedding,
        match_count: count,
        match_threshold: threshold,
      })
      if (error) throw dbError(error)
      return data ?? []
    },
  }
}

export interface BotDbs {
  primary: BotDb
  /** Where chat_history writes go once the primary is sealed; null until the CRM gateway exists. */
  fallback: BotDb | null
}

function quoteDb(): BotDb {
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  return supabaseBotDb(url, key)
}

let override: BotDbs | null = null

/** Tests only. */
export function setBotDbsForTest(dbs: BotDbs | null) {
  override = dbs
}

// shortcut: only quote-drone168 exists; add the CRM gateway client and the BOT_DB=quote|crm switch here.
export function botDbs(): BotDbs {
  return override ?? { primary: quoteDb(), fallback: null }
}

/** Writes to the primary; if the cutover sealed it, writes the same row to the other side. */
export async function insertMessageWithFallback(dbs: BotDbs, row: NewChatRow) {
  try {
    await dbs.primary.insertMessage(row)
  } catch (err) {
    if (!isSealed(err) || !dbs.fallback) throw err
    console.warn("chat_history: primary sealed, writing to fallback", row.id)
    await dbs.fallback.insertMessage(row)
  }
}

const CHAT_ID_NAMESPACE = "6f1c0b8e-4a4b-4f0e-9d55-2b7e3c1a9d10"

/** RFC 4122 v5 UUID (SHA-1, name-based). */
export function uuidV5(name: string, namespace = CHAT_ID_NAMESPACE): string {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const h = hash.subarray(0, 16).toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Same id on every LINE delivery of one event. Assumes each event writes at most one row per role
 * (chat.ts and image.ts both write one user + one assistant); a second row of the same role would
 * be swallowed by the idempotent insert.
 */
export const chatMessageId = (accountId: string, webhookEventId: string, role: ChatRow["role"]) =>
  uuidV5(`${accountId}:${webhookEventId}:${role}`)
