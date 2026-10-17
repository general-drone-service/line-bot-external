import assert from "node:assert/strict"
import { test } from "node:test"
import { GET } from "@/app/api/health/anthropic/route"

// Own file: the cached Anthropic client must be built with this malformed key
process.env.BOT_PAUSE_API_TOKEN = "test-bot-pause-token"
process.env.ANTHROPIC_API_KEY = "sk-ant-leak\nme"
let calls = 0
globalThis.fetch = (async () => {
  calls++
  return new Response("{}", { status: 200 })
}) as typeof fetch

test("a malformed key is never echoed back", async () => {
  const res = await GET(new Request("https://example.test/api/health/anthropic", { headers: { authorization: "Bearer test-bot-pause-token" } }))
  const text = await res.text()
  assert.equal(res.status, 502)
  assert.deepEqual(JSON.parse(text), { status: null, type: "TypeError", requestId: null })
  assert.doesNotMatch(text, /leak/)
  assert.equal(calls, 0)
})
