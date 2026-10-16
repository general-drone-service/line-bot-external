import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { handleTouchRequest } from "@/lib/tracking/touch"
import type { TouchStore } from "@/lib/tracking/store"
import { deriveToken, hashToken, prefillMessage, lineChatUrl } from "@/lib/tracking/token"

const SECRET = "test-token-secret"
const KEY = "3f2b8c1e-6d4a-4f7b-9a1c-2e5d8b7a6c40"
const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.LINE_TRACKING_TOKEN_SECRET = SECRET
  process.env.LINE_TRACKING_ENABLED = "true"
  delete process.env.LINE_TRACKING_TOKEN_TTL_DAYS
})

afterEach(() => {
  process.env = { ...savedEnv }
})

function store(result: { expiresAt: string } | null | Error = { expiresAt: "2026-11-15T00:00:00Z" }) {
  const calls: Parameters<TouchStore["createTouch"]>[] = []
  const s: TouchStore = {
    async createTouch(...args) {
      calls.push(args)
      if (result instanceof Error) throw result
      return result
    },
  }
  return { s, calls }
}

const post = (body: unknown) =>
  new Request("https://example.test/api/line/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

test("creates a touch and returns the prefilled LINE chat url", async () => {
  const { s, calls } = store()
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("cache-control"), "no-store")
  const token = deriveToken(SECRET, KEY)
  assert.deepEqual(await res.json(), { url: lineChatUrl(prefillMessage(token)), message: prefillMessage(token) })
  assert.deepEqual(calls, [["meta_facility_202610", KEY, hashToken(token), 30, 120]])
})

test("retry with the same idempotency key returns the same url", async () => {
  const { s } = store()
  const a = await (await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)).json()
  const b = await (await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)).json()
  assert.equal(a.url, b.url)
})

test("token ttl is configurable", async () => {
  process.env.LINE_TRACKING_TOKEN_TTL_DAYS = "7"
  const { s, calls } = store()
  await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(calls[0][3], 7)
})

test("unknown or disabled source returns 404", async () => {
  const { s } = store(null)
  const res = await handleTouchRequest(post({ source: "meta_unknown", idempotencyKey: KEY }), s)
  assert.equal(res.status, 404)
})

test("malformed input is rejected before the database", async () => {
  const { s, calls } = store()
  for (const body of [
    "{not json",
    { source: "https://evil.example", idempotencyKey: KEY },
    { source: "META_UPPER", idempotencyKey: KEY },
    { source: "meta_facility_202610", idempotencyKey: "not-a-uuid" },
    { source: "meta_facility_202610" },
  ]) {
    assert.equal((await handleTouchRequest(post(body), s)).status, 400, JSON.stringify(body))
  }
  assert.equal(calls.length, 0)
})

test("missing token secret returns 503", async () => {
  delete process.env.LINE_TRACKING_TOKEN_SECRET
  const { s, calls } = store()
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(res.status, 503)
  assert.equal(calls.length, 0)
})

test("tracking switched off returns 503 without touching the database", async () => {
  delete process.env.LINE_TRACKING_ENABLED
  const { s, calls } = store()
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(res.status, 503)
  assert.equal(calls.length, 0)
})

test("idempotency key reused for another source returns 409", async () => {
  const { s } = store(new Error("line_tracking_create_touch failed: idempotency_conflict"))
  const res = await handleTouchRequest(post({ source: "meta_tech_facility", idempotencyKey: KEY }), s)
  assert.equal(res.status, 409)
})

test("non-JSON content types are rejected before the database (cross-site form posts)", async () => {
  const { s, calls } = store()
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const req = new Request("https://example.test/api/line/touch", {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify({ source: "meta_facility_202610", idempotencyKey: KEY }),
    })
    assert.equal((await handleTouchRequest(req, s)).status, 415, type)
  }
  assert.equal(calls.length, 0)
})

test("oversized body is rejected before the database", async () => {
  const { s, calls } = store()
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY, pad: "x".repeat(2000) }), s)
  assert.equal(res.status, 413)
  assert.equal(calls.length, 0)
})

test("body limit counts UTF-8 bytes, not characters", async () => {
  const { s, calls } = store()
  const body = JSON.stringify({ source: "meta_facility_202610", idempotencyKey: KEY, pad: "中".repeat(400) })
  assert.ok(body.length < 1024 && Buffer.byteLength(body) > 1024)
  const req = new Request("https://example.test/api/line/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  assert.equal((await handleTouchRequest(req, s)).status, 413)
  assert.equal(calls.length, 0)
})

test("source over its per-minute cap returns 429", async () => {
  const { s } = store(new Error("line_tracking_create_touch failed: rate_limited"))
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(res.status, 429)
})

test("database failure returns 500", async () => {
  const { s } = store(new Error("line_tracking_create_touch failed: connection refused"))
  const res = await handleTouchRequest(post({ source: "meta_facility_202610", idempotencyKey: KEY }), s)
  assert.equal(res.status, 500)
})
