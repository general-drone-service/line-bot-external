import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { GET } from "@/app/api/health/anthropic/route"

const TOKEN = "test-bot-pause-token"
process.env.BOT_PAUSE_API_TOKEN = TOKEN
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key"

// The Anthropic client captures fetch when first built, so one dispatcher serves every test
let upstream: () => Response
const calls: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  calls.push(String(input instanceof Request ? input.url : input))
  return upstream()
}) as typeof fetch

beforeEach(() => {
  calls.length = 0
})

const url = "https://example.test/api/health/anthropic"
const authed = () => new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } })
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_1" } })

test("without bearer returns 401 and never calls Anthropic", async () => {
  const res = await GET(new Request(url))
  assert.equal(res.status, 401)
  assert.equal(calls.length, 0)
})

test("valid key reports 200 from the models endpoint for the chat model", async () => {
  upstream = () => json(200, { type: "model", id: "claude-haiku-4-5-20251001", display_name: "x", created_at: "2025-10-01T00:00:00Z" })
  const res = await GET(authed())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 200 })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/v1\/models\/claude-haiku-4-5-20251001$/)
})

test("rejected key reports upstream status and error type only", async () => {
  upstream = () => json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
  const res = await GET(authed())
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.deepEqual(body, { status: 401, type: "authentication_error", requestId: "req_1" })
  assert.doesNotMatch(JSON.stringify(body), /sk-ant|invalid x-api-key/)
})

test("network failure reports connection_error", async () => {
  upstream = () => {
    throw new TypeError("fetch failed")
  }
  const res = await GET(authed())
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), { status: null, type: "connection_error", requestId: null })
})
