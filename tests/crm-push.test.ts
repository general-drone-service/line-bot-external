import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { flushCrmOutbox, toIngestPayload } from "@/lib/tracking/crm-push"
import type { CrmOutboxRow, CrmOutboxStore } from "@/lib/tracking/store"

const INGEST = "https://crm.test/functions/v1/line-inquiry-ingest"
const SECRET = "test-ingest-secret"
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.CRM_PUSH_ENABLED = "true"
  process.env.CRM_INGEST_URL = INGEST
  process.env.LINE_INQUIRY_INGEST_SECRET = SECRET
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token"
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...savedEnv }
})

const row = (over: Partial<CrmOutboxRow> = {}): CrmOutboxRow => ({
  event_id: "5b1f2c4e-0000-4000-8000-000000000001",
  lease_token: "9c1f2c4e-0000-4000-8000-0000000000aa",
  account_id: "Ubot",
  line_user_id: "U1",
  source_key: "meta_facility_202610",
  crm_source_code: "meta",
  entry_type: "line_ad",
  attribution_status: "matched",
  first_touch_at: "2026-10-16T01:00:00+00:00",
  first_inquiry_at: "2026-10-16T01:05:00+00:00",
  is_test: false,
  ...over,
})

function outbox(rows: CrmOutboxRow[], invalid = new Set<string>()) {
  const finished: { id: string; token: string; ok: boolean; retryable: boolean; error?: string }[] = []
  let leased = 0
  const store: CrmOutboxStore = {
    async leaseCrm() {
      leased++
      return leased === 1 ? rows : []
    },
    async claimSend(id) {
      return !invalid.has(id)
    },
    async finishCrm(id, token, result) {
      finished.push({ id, token, ...result })
    },
  }
  return { store, finished, invalid, leasedCount: () => leased }
}

/** Mocks LINE profile + CRM ingest; `ingest` decides the CRM response. */
function mockFetch(ingest: (req: { headers: Headers; body: string }) => Response | Promise<Response>) {
  const ingestCalls: { headers: Headers; body: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return Response.json({ displayName: "王小明" })
    if (url === INGEST) {
      const req = { headers: new Headers(init?.headers), body: String(init?.body) }
      ingestCalls.push(req)
      return ingest(req)
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return ingestCalls
}

test("matched row maps to the CRM payload contract", () => {
  assert.deepEqual(toIngestPayload(row(), "王小明"), {
    accountId: "Ubot",
    lineUserId: "U1",
    sourceKey: "meta_facility_202610",
    crmSourceCode: "meta",
    attributionStatus: "matched",
    displayName: "王小明",
    firstTouchAt: "2026-10-16T01:00:00+00:00",
    inquiryAt: "2026-10-16T01:05:00+00:00",
    botEventRef: "5b1f2c4e-0000-4000-8000-000000000001",
    isTest: false,
  })
})

test("non-matched statuses become unknown or conflict without a source", () => {
  for (const [status, expected] of [
    ["no_token", "unknown"], ["unknown_token", "unknown"], ["expired", "unknown"],
    ["revoked_token", "unknown"], ["conflict", "conflict"],
  ] as const) {
    const p = toIngestPayload(row({ attribution_status: status, source_key: null, crm_source_code: null, first_touch_at: null }), null)
    assert.equal(p.attributionStatus, expected, status)
    assert.equal(p.sourceKey, null)
    assert.equal(p.crmSourceCode, null)
  }
})

test("signs timestamp.body with HMAC-SHA256 and marks success", async () => {
  const { store, finished } = outbox([row()])
  const calls = mockFetch(() => Response.json({ inquiryId: "x", created: true, status: "new" }))
  const result = await flushCrmOutbox(store)
  assert.deepEqual(result, { sent: 1, retry: 0, failed: 0, skipped: 0 })
  const { headers, body } = calls[0]
  const ts = headers.get("x-drone168-timestamp")!
  assert.match(ts, /^\d{10}$/)
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 5)
  const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")
  assert.equal(headers.get("x-drone168-signature"), `sha256=${expected}`)
  assert.equal(JSON.parse(body).displayName, "王小明")
  assert.deepEqual(finished, [{ id: row().event_id, token: row().lease_token, ok: true, retryable: false }])
})

test("422 and 405 are terminal; 401, 500, 503 and network errors retry", async () => {
  for (const [status, retryable] of [[422, false], [405, false], [401, true], [500, true], [503, true]] as const) {
    const { store, finished } = outbox([row()])
    mockFetch(() => new Response("x", { status }))
    await flushCrmOutbox(store)
    assert.equal(finished[0].ok, false, String(status))
    assert.equal(finished[0].retryable, retryable, String(status))
    assert.match(finished[0].error!, new RegExp(`HTTP ${status}`))
  }
  const { store, finished } = outbox([row()])
  mockFetch(() => {
    throw new TypeError("network down")
  })
  await flushCrmOutbox(store)
  assert.deepEqual({ ok: finished[0].ok, retryable: finished[0].retryable }, { ok: false, retryable: true })
})

test("profile lookup failure still pushes with a null display name", async () => {
  const { store } = outbox([row()])
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return new Response("gone", { status: 404 })
    calls.push(String(init?.body))
    return Response.json({})
  }) as typeof fetch
  await flushCrmOutbox(store)
  assert.equal(JSON.parse(calls[0]).displayName, null)
})

test("disabled or unconfigured push leaves the outbox untouched", async () => {
  for (const unset of ["CRM_PUSH_ENABLED", "CRM_INGEST_URL", "LINE_INQUIRY_INGEST_SECRET"]) {
    process.env = { ...savedEnv, CRM_PUSH_ENABLED: "true", CRM_INGEST_URL: INGEST, LINE_INQUIRY_INGEST_SECRET: SECRET }
    delete process.env[unset]
    const { store, leasedCount } = outbox([row()])
    const result = await flushCrmOutbox(store)
    assert.deepEqual(result, { skipped: "disabled" }, unset)
    assert.equal(leasedCount(), 0)
  }
})

test("one failing row does not stop the rest of the batch", async () => {
  const { store, finished } = outbox([row(), row({ event_id: "5b1f2c4e-0000-4000-8000-000000000002" })])
  let n = 0
  mockFetch(() => (++n === 1 ? new Response("x", { status: 500 }) : Response.json({})))
  const result = await flushCrmOutbox(store)
  assert.deepEqual(result, { sent: 1, retry: 1, failed: 0, skipped: 0 })
  assert.equal(finished.length, 2)
})

test("row cancelled after leasing (unsend while an earlier row is in flight) is never sent", async () => {
  const second = row({ event_id: "5b1f2c4e-0000-4000-8000-000000000002" })
  const box = outbox([row(), second])
  const calls = mockFetch((req) => {
    // While the first push is in flight, the second inquiry is unsent and its CRM push cancelled
    box.invalid.add(second.event_id)
    return Response.json({ botEventRef: JSON.parse(req.body).botEventRef })
  })
  const result = await flushCrmOutbox(box.store)
  assert.deepEqual(result, { sent: 1, retry: 0, failed: 0, skipped: 1 })
  assert.deepEqual(calls.map((c) => JSON.parse(c.body).botEventRef), [row().event_id])
  assert.deepEqual(box.finished.map((f) => f.id), [row().event_id])
})

test("a cancel that commits just after a successful send claim does not stop the push", async () => {
  // The claim is the decision point: once it succeeded the push counts as started and is finished normally
  const box = outbox([row()])
  const calls = mockFetch(() => {
    box.invalid.add(row().event_id) // the unsend arrives after the claim
    return Response.json({})
  })
  const result = await flushCrmOutbox(box.store)
  assert.equal(calls.length, 1)
  assert.deepEqual(result, { sent: 1, retry: 0, failed: 0, skipped: 0 })
})

test("rows are not started after the run deadline", async () => {
  const rows = [1, 2, 3].map((n) => row({ event_id: `5b1f2c4e-0000-4000-8000-00000000000${n}` }))
  const box = outbox(rows)
  let clock = 0
  const calls = mockFetch(() => {
    clock += 20_000 // each push takes 20s of wall clock; the third would start after the 30s deadline
    return Response.json({})
  })
  const result = await flushCrmOutbox(box.store, () => clock)
  assert.equal(calls.length, 2)
  assert.deepEqual(result, { sent: 2, retry: 0, failed: 0, skipped: 0 })
})
