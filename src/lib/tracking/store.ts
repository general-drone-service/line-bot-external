import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { LineEvent } from "@/lib/line"
import { isInquiryEvent } from "./inquiry"

export type ReplyStatus = "pending" | "skipped" | "sent" | "failed" | "unknown"

/** Persistence for webhook tracking; every method throws on database errors. */
export interface TrackingStore {
  recordEvents(accountId: string, events: LineEvent[]): Promise<void>
  processEvent(accountId: string, webhookEventId: string, tokenHash: string | null, isTestUser: boolean): Promise<string>
  /** Attempt number (1 = first) when claimed, 0 when another delivery already owns or finished it. */
  claimReply(accountId: string, webhookEventId: string): Promise<number>
  finishReply(accountId: string, webhookEventId: string, status: ReplyStatus): Promise<void>
}

export interface TouchStore {
  /**
   * null when the source is unknown or disabled; throws "idempotency_conflict" on key reuse and
   * "rate_limited" when the source exceeded maxPerMinute new touches.
   */
  createTouch(
    sourceKey: string, idempotencyKey: string, tokenHash: string, ttlDays: number, maxPerMinute: number
  ): Promise<{ expiresAt: string } | null>
}

export interface CrmOutboxRow {
  event_id: string
  lease_token: string
  account_id: string
  line_user_id: string
  source_key: string | null
  crm_source_code: string | null
  entry_type: string | null
  attribution_status: string
  first_touch_at: string | null
  first_inquiry_at: string
  is_test: boolean
}

export interface CrmOutboxStore {
  leaseCrm(limit: number, leaseSeconds: number): Promise<CrmOutboxRow[]>
  /**
   * Atomic decision to start a push (pending/sending -> sending under this unexpired lease).
   * false when an unsend cancelled it first or the lease moved on; then the row must not be sent.
   */
  claimSend(eventId: string, leaseToken: string): Promise<boolean>
  /** No-op unless the row is still claimed (sending) under this lease token. */
  finishCrm(
    eventId: string, leaseToken: string, result: { ok: boolean; retryable: boolean; error?: string }, maxAttempts: number
  ): Promise<void>
}

/** Row shape for line_tracking_record_events; keeps only what tracking needs (no text, no reply token). */
export function toEventRow(event: LineEvent) {
  return {
    webhook_event_id: event.webhookEventId,
    event_type: event.type,
    message_type: event.message?.type ?? null,
    source_type: event.source?.type ?? null,
    timestamp_ms: event.timestamp,
    is_redelivery: event.deliveryContext?.isRedelivery ?? false,
    is_unblocked: event.follow?.isUnblocked ?? null,
    line_user_id: event.source?.userId ?? null,
    message_id: event.unsend?.messageId ?? event.message?.id ?? null,
    is_inquiry: isInquiryEvent(event),
  }
}

let client: SupabaseClient | null = null
const RPC_TIMEOUT_MS = 5_000

function getSupabaseAdmin() {
  if (client) return client
  const url = process.env.SUPABASE_URL ?? process.env.QUOTE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  // Bound every tracking RPC so a slow database cannot outlive the webhook or cron time budget
  client = createClient(url, key, {
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS) }) },
  })
  return client
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseAdmin().rpc(fn, args)
  if (error) throw new Error(`${fn} failed: ${error.message}`)
  return data as T
}

/** Tracking is off until the migration is applied and LINE_TRACKING_ENABLED=true (also the kill switch). */
export function trackingEnabled() {
  return process.env.LINE_TRACKING_ENABLED === "true"
}

/** Used while tracking is off: no DB, every delivery is handled (P0 behaviour, no dedupe). */
export const passthroughTrackingStore: TrackingStore = {
  async recordEvents() {},
  async processEvent() {
    return "disabled"
  },
  async claimReply() {
    return 1
  },
  async finishReply() {},
}

export const supabaseTrackingStore: TrackingStore = {
  async recordEvents(accountId, events) {
    await rpc("line_tracking_record_events", { p_account_id: accountId, p_events: events.map(toEventRow) })
  },
  processEvent(accountId, webhookEventId, tokenHash, isTestUser) {
    return rpc<string>("line_tracking_process_event", {
      p_account_id: accountId,
      p_webhook_event_id: webhookEventId,
      p_token_hash: tokenHash,
      p_is_test_user: isTestUser,
    })
  },
  claimReply(accountId, webhookEventId) {
    return rpc<number>("line_tracking_claim_reply", { p_account_id: accountId, p_webhook_event_id: webhookEventId })
  },
  async finishReply(accountId, webhookEventId, status) {
    await rpc("line_tracking_finish_reply", {
      p_account_id: accountId,
      p_webhook_event_id: webhookEventId,
      p_status: status,
    })
  },
}

export const supabaseTouchStore: TouchStore = {
  async createTouch(sourceKey, idempotencyKey, tokenHash, ttlDays, maxPerMinute) {
    const rows = await rpc<{ touch_id: string; expires_at: string }[]>("line_tracking_create_touch", {
      p_source_key: sourceKey,
      p_idempotency_key: idempotencyKey,
      p_token_hash: tokenHash,
      p_ttl_days: ttlDays,
      p_max_per_minute: maxPerMinute,
    })
    return rows[0] ? { expiresAt: rows[0].expires_at } : null
  },
}

export const supabaseCrmOutboxStore: CrmOutboxStore = {
  leaseCrm(limit, leaseSeconds) {
    return rpc<CrmOutboxRow[]>("line_tracking_lease_crm", { p_limit: limit, p_lease_seconds: leaseSeconds })
  },
  claimSend(eventId, leaseToken) {
    return rpc<boolean>("line_tracking_claim_crm_send", { p_event_id: eventId, p_lease_token: leaseToken })
  },
  async finishCrm(eventId, leaseToken, result, maxAttempts) {
    await rpc("line_tracking_finish_crm", {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_ok: result.ok,
      p_retryable: result.retryable,
      p_error: result.error ?? null,
      p_max_attempts: maxAttempts,
    })
  },
}
