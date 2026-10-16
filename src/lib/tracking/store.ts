import type { LineEvent } from "@/lib/line"
import { callGateway } from "@/lib/botdb/gateway"
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

/** Row shape for tracking.recordEvents; keeps only what tracking needs (no text, no reply token). */
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

/**
 * Tracking is off until the CRM line_bot schema and gateway are live and LINE_TRACKING_ENABLED=true
 * (also the kill switch). Tracking lives only in the CRM, behind the line-bot-data gateway.
 */
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

export const crmTrackingStore: TrackingStore = {
  async recordEvents(accountId, events) {
    await callGateway("tracking.recordEvents", { p_account_id: accountId, p_events: events.map(toEventRow) })
  },
  processEvent(accountId, webhookEventId, tokenHash, isTestUser) {
    return callGateway<string>("tracking.processEvent", {
      p_account_id: accountId,
      p_webhook_event_id: webhookEventId,
      p_token_hash: tokenHash,
      p_is_test_user: isTestUser,
    })
  },
  async claimReply(accountId, webhookEventId) {
    const attempt = await callGateway<unknown>("tracking.claimReply", { p_account_id: accountId, p_webhook_event_id: webhookEventId })
    // A malformed claim must not be read as "go ahead": only 0 skips, so anything else would reply
    if (!Number.isInteger(attempt) || (attempt as number) < 0) throw new Error(`tracking.claimReply: invalid attempt ${attempt}`)
    return attempt as number
  },
  async finishReply(accountId, webhookEventId, status) {
    await callGateway("tracking.finishReply", {
      p_account_id: accountId,
      p_webhook_event_id: webhookEventId,
      p_status: status,
    })
  },
}

export const crmTouchStore: TouchStore = {
  async createTouch(sourceKey, idempotencyKey, tokenHash, ttlDays, maxPerMinute) {
    // Gateway answers 409 with message "idempotency_conflict" / "rate_limited"; GatewayError carries it
    const touch = await callGateway<{ touch_id: string; expires_at: string } | null>("tracking.createTouch", {
      p_source_key: sourceKey,
      p_idempotency_key: idempotencyKey,
      p_token_hash: tokenHash,
      p_ttl_days: ttlDays,
      p_max_per_minute: maxPerMinute,
    })
    return touch ? { expiresAt: touch.expires_at } : null
  },
}

export const crmOutboxStore: CrmOutboxStore = {
  leaseCrm(limit, leaseSeconds) {
    return callGateway<CrmOutboxRow[]>("tracking.leaseCrm", { p_limit: limit, p_lease_seconds: leaseSeconds })
  },
  claimSend(eventId, leaseToken) {
    return callGateway<boolean>("tracking.claimCrmSend", { p_event_id: eventId, p_lease_token: leaseToken })
  },
  async finishCrm(eventId, leaseToken, result, maxAttempts) {
    await callGateway("tracking.finishCrm", {
      p_event_id: eventId,
      p_lease_token: leaseToken,
      p_ok: result.ok,
      p_retryable: result.retryable,
      p_error: result.error ?? null,
      p_max_attempts: maxAttempts,
    })
  },
}
