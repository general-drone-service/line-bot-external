import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { POST } from "@/app/api/webhook/route"

const SECRET = "test-channel-secret"
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }
let pushedTo: string[] = []

beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token"
  pushedTo = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...savedEnv }
})

// Every outbound call is intercepted; `respond` decides the LINE push result per recipient
function mockLinePush(respond: (to: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    assert.equal(url, "https://api.line.me/v2/bot/message/push", `unexpected fetch ${url}`)
    const { to } = JSON.parse(String(init?.body))
    pushedTo.push(to)
    return respond(to)
  }) as typeof fetch
}

function followBatch(...userIds: string[]) {
  const body = JSON.stringify({
    destination: "Ubot",
    events: userIds.map((userId) => ({ type: "follow", source: { type: "user", userId } })),
  })
  const signature = crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
  return new Request("https://example.test/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  })
}

test("LINE push returning 503 makes the webhook return 500", async () => {
  mockLinePush(() => new Response("unavailable", { status: 503 }))
  const res = await POST(followBatch("U1"))
  assert.equal(res.status, 500)
  assert.deepEqual(pushedTo, ["U1"])
})

test("a failed push still lets the next event in the batch run", async () => {
  mockLinePush((to) => {
    if (to === "U1") throw new TypeError("network down")
    return new Response("{}", { status: 200 })
  })
  const res = await POST(followBatch("U1", "U2"))
  assert.equal(res.status, 500)
  assert.deepEqual(pushedTo, ["U1", "U2"])
})

test("successful pushes return 200", async () => {
  mockLinePush(() => new Response("{}", { status: 200 }))
  const res = await POST(followBatch("U1", "U2"))
  assert.equal(res.status, 200)
})

function signedRequest(events: unknown[]) {
  const body = JSON.stringify({ destination: "Ubot", events })
  const signature = crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
  return new Request("https://example.test/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  })
}

const imageEvent = {
  type: "message",
  replyToken: "r1",
  source: { type: "user", userId: "U1" },
  message: { type: "image", id: "img1" },
}
const followU2 = { type: "follow", source: { type: "user", userId: "U2" } }

// Force "outside business hours" and "not paused" so the image branch is reached
function mockImagePath(imageResult: () => Response) {
  process.env.BUSINESS_HOURS_DAYS = "7"
  process.env.SUPABASE_URL = "https://supabase.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith("https://supabase.test/")) return Response.json([], { status: 200 })
    if (url === "https://api-data.line.me/v2/bot/message/img1/content") return imageResult()
    if (url === "https://api.line.me/v2/bot/message/push") return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return calls
}

test("image download returning 503 makes the webhook return 500 and the next event still runs", async () => {
  const calls = mockImagePath(() => new Response("unavailable", { status: 503 }))
  const res = await POST(signedRequest([imageEvent, followU2]))
  assert.equal(res.status, 500)
  assert.ok(calls.includes("https://api-data.line.me/v2/bot/message/img1/content"))
  assert.ok(calls.includes("https://api.line.me/v2/bot/message/push"))
})

test("image download network error makes the webhook return 500 and the next event still runs", async () => {
  const calls = mockImagePath(() => {
    throw new TypeError("network down")
  })
  const res = await POST(signedRequest([imageEvent, followU2]))
  assert.equal(res.status, 500)
  assert.ok(calls.includes("https://api-data.line.me/v2/bot/message/img1/content"))
  assert.ok(calls.includes("https://api.line.me/v2/bot/message/push"))
})
