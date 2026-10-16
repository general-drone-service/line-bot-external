import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { handleWebhookRequest } from "@/lib/line/webhook"
import type { LineEvent } from "@/lib/line"

const SECRET = "test-channel-secret"
let savedSecret: string | undefined

beforeEach(() => {
  savedSecret = process.env.LINE_CHANNEL_SECRET
  process.env.LINE_CHANNEL_SECRET = SECRET
})

afterEach(() => {
  if (savedSecret === undefined) delete process.env.LINE_CHANNEL_SECRET
  else process.env.LINE_CHANNEL_SECRET = savedSecret
})

function sign(body: string) {
  return crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
}

function webhookRequest(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (signature !== null) headers["x-line-signature"] = signature
  return new Request("https://example.test/api/webhook", { method: "POST", headers, body })
}

function recorder(failOn?: number) {
  const seen: LineEvent[] = []
  const handle = async (event: LineEvent) => {
    seen.push(event)
    if (seen.length === failOn) throw new Error("boom")
  }
  return { seen, handle }
}

const textEvent = (text: string): LineEvent => ({
  type: "message",
  replyToken: "r",
  source: { type: "user", userId: "U1" },
  message: { type: "text", id: "m1", text },
})

test("missing signature header returns 401", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(`{"events":[]}`, null), handle)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("missing channel secret returns 500 and does not handle events", async () => {
  const body = JSON.stringify({ events: [textEvent("hi")] })
  const req = webhookRequest(body)
  delete process.env.LINE_CHANNEL_SECRET
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(req, handle)
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: "Server misconfigured" })
  assert.equal(seen.length, 0)
})

test("wrong-length signature is rejected", async () => {
  const body = JSON.stringify({ events: [textEvent("hi")] })
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(body, "short"), handle)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("same-length wrong signature is rejected", async () => {
  const body = JSON.stringify({ events: [textEvent("hi")] })
  const forged = sign(body + "x")
  assert.equal(forged.length, sign(body).length)
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(body, forged), handle)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("valid signature over multibyte body is accepted", async () => {
  const body = JSON.stringify({ events: [textEvent("您好，我想了解外牆清洗服務")] })
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(body), handle)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message?.text, "您好，我想了解外牆清洗服務")
})

test("empty events returns 200", async () => {
  const { handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(`{"destination":"Ubot","events":[]}`), handle)
  assert.equal(res.status, 200)
})

test("invalid JSON returns 400", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest("{not json"), handle)
  assert.equal(res.status, 400)
  assert.equal(seen.length, 0)
})

test("one failing event still processes others and returns 500", async () => {
  const body = JSON.stringify({ events: [textEvent("a"), textEvent("b"), textEvent("c")] })
  const { seen, handle } = recorder(2)
  const res = await handleWebhookRequest(webhookRequest(body), handle)
  assert.equal(seen.length, 3)
  assert.equal(res.status, 500)
})
