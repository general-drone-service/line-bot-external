import { getChannelAccessToken } from "@/lib/line"
import { drone168SignedHeaders } from "@/lib/botdb/gateway"
import { crmOutboxStore, type CrmOutboxRow, type CrmOutboxStore } from "./store"

// Worst case per row: profile 5s + claim RPC 5s + ingest 8s + finish RPC 5s = 23s (RPCs time out
// at 5s in store.ts). Rows start only before the 30s deadline, so a run ends by ~53s plus the
// initial lease RPC: under the cron route's maxDuration (60s) and far under the lease.
const BATCH_SIZE = 10
const LEASE_SECONDS = 300
const MAX_ATTEMPTS = 10
const PROFILE_TIMEOUT_MS = 5_000
const INGEST_TIMEOUT_MS = 8_000
const RUN_DEADLINE_MS = 30_000

/** CRM line-inquiry-ingest payload (drone168 CRM spec 2026-10-16 §4). */
export function toIngestPayload(row: CrmOutboxRow, displayName: string | null) {
  const matched = row.attribution_status === "matched"
  return {
    accountId: row.account_id,
    lineUserId: row.line_user_id,
    sourceKey: matched ? row.source_key : null,
    crmSourceCode: matched ? row.crm_source_code : null,
    attributionStatus: matched ? "matched" : row.attribution_status === "conflict" ? "conflict" : "unknown",
    displayName,
    firstTouchAt: matched ? row.first_touch_at : null,
    inquiryAt: row.first_inquiry_at,
    botEventRef: row.event_id,
    isTest: row.is_test,
  }
}

// 422 (bad payload) and 405 never succeed on retry; 401/503/5xx can once config or the switch is fixed
function isRetryable(status: number) {
  return !(status === 422 || status === 405 || (status >= 400 && status < 500 && ![401, 408, 429].includes(status)))
}

async function fetchDisplayName(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${getChannelAccessToken()}` },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const profile = (await res.json()) as { displayName?: string }
    return profile.displayName ?? null
  } catch {
    return null
  }
}

async function pushRow(row: CrmOutboxRow, displayName: string | null, url: string, secret: string) {
  const body = JSON.stringify(toIngestPayload(row, displayName))
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: drone168SignedHeaders(secret, body),
      body,
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, retryable: false }
    return { ok: false, retryable: isRetryable(res.status), error: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Pushes due LINE inquiries to CRM. Safe to run concurrently (rows are leased) and repeatedly
 * (CRM ingest is idempotent on botEventRef). Off unless CRM_PUSH_ENABLED=true and configured.
 */
export async function flushCrmOutbox(store: CrmOutboxStore = crmOutboxStore, now: () => number = Date.now) {
  const url = process.env.CRM_INGEST_URL
  const secret = process.env.LINE_INQUIRY_INGEST_SECRET
  if (process.env.CRM_PUSH_ENABLED !== "true" || !url || !secret) return { skipped: "disabled" as const }

  const deadline = now() + RUN_DEADLINE_MS
  const rows = await store.leaseCrm(BATCH_SIZE, LEASE_SECONDS)
  const summary = { sent: 0, retry: 0, failed: 0, skipped: 0 }
  for (const row of rows) {
    // Unstarted rows keep their lease and are picked up again once it expires
    if (now() >= deadline) break
    const displayName = await fetchDisplayName(row.line_user_id)
    // Atomic claim immediately before sending: an unsend may have cancelled it, or our lease lapsed
    if (!(await store.claimSend(row.event_id, row.lease_token))) {
      summary.skipped++
      continue
    }
    const result = await pushRow(row, displayName, url, secret)
    try {
      await store.finishCrm(row.event_id, row.lease_token, result, MAX_ATTEMPTS)
    } catch (err) {
      // The lease expires and the row is retried; CRM dedupes on botEventRef
      console.error("CRM outbox: failed to store result", row.event_id, err)
    }
    if (result.ok) summary.sent++
    else if (result.retryable) summary.retry++
    else summary.failed++
    if (!result.ok) console.error("CRM outbox: push failed", row.event_id, result.error)
  }
  return summary
}
