import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { POST } from "@/app/api/webhook/route"
import { retryKeyFor } from "@/lib/line"

const SECRET = "test-channel-secret"
const SUPABASE = "https://supabase.test"
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token"
  process.env.SUPABASE_URL = SUPABASE
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
  // Force "outside business hours" so message events reach the handlers
  process.env.BUSINESS_HOURS_DAYS = "7"
  process.env.LINE_TRACKING_ENABLED = "true"
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...savedEnv }
})

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>

/**
 * Intercepts every outbound call. Supabase tracking RPCs get a minimal in-memory implementation;
 * `routes` handles LINE (and anything else) by URL, and unexpected URLs fail the test.
 */
function mockNetwork(routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const reply = new Map<string, string>()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const rpc = url.match(/^https:\/\/supabase\.test\/rest\/v1\/rpc\/(\w+)/)?.[1]
    if (rpc) {
      const args = JSON.parse(String(init?.body))
      switch (rpc) {
        case "line_tracking_record_events":
          for (const e of args.p_events) if (!reply.has(e.webhook_event_id)) reply.set(e.webhook_event_id, "pending")
          return new Response(null, { status: 204 })
        case "line_tracking_process_event":
          return Response.json("no_token")
        case "line_tracking_claim_reply": {
          if (reply.get(args.p_webhook_event_id) !== "pending") return Response.json(0)
          reply.set(args.p_webhook_event_id, "sending")
          return Response.json(1)
        }
        case "line_tracking_finish_reply":
          reply.set(args.p_webhook_event_id, args.p_status)
          return new Response(null, { status: 204 })
      }
    }
    if (url.startsWith(`${SUPABASE}/rest/v1/bot_pause`)) return Response.json([], { status: 200 })
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return handler(url, init)
  }) as typeof fetch
  return { calls, reply, rpcArgs: (fn: string) => calls.filter((c) => c.url.endsWith(`/rpc/${fn}`)).map((c) => JSON.parse(String(c.init?.body))) }
}

function signedRequest(events: unknown[]) {
  const body = JSON.stringify({ destination: "Ubot", events })
  const signature = crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
  return new Request("https://example.test/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  })
}

const follow = (id: string, userId: string) => ({
  type: "follow",
  webhookEventId: id,
  timestamp: 1760600000000,
  deliveryContext: { isRedelivery: false },
  source: { type: "user", userId },
  follow: { isUnblocked: true },
})
const image = {
  type: "message",
  webhookEventId: "img-ev",
  timestamp: 1760600000000,
  replyToken: "r1",
  source: { type: "user", userId: "U1" },
  message: { type: "image", id: "img1" },
}

const PUSH = "https://api.line.me/v2/bot/message/push"
const IMAGE = "https://api-data.line.me/v2/bot/message/img1/content"
const pushedTo = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === PUSH).map((c) => JSON.parse(String(c.init?.body)).to)

test("with tracking switched off the webhook never calls the tracking database (P0 behaviour)", async () => {
  delete process.env.LINE_TRACKING_ENABLED
  const net = mockNetwork({ [PUSH]: () => Response.json({}) })
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 200)
  assert.deepEqual(net.calls.filter((c) => c.url.includes("/rpc/")), [])
  assert.deepEqual(pushedTo(net.calls), ["U1"])
})

test("records the batch with only tracking fields before replying", async () => {
  const net = mockNetwork({ [PUSH]: () => Response.json({}) })
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 200)
  const [record] = net.rpcArgs("line_tracking_record_events")
  assert.equal(record.p_account_id, "Ubot")
  assert.deepEqual(record.p_events, [{
    webhook_event_id: "f1", event_type: "follow", message_type: null, source_type: "user",
    timestamp_ms: 1760600000000, is_redelivery: false, is_unblocked: true, line_user_id: "U1",
    message_id: null, is_inquiry: false,
  }])
  const order = net.calls.map((c) => c.url.split("/").pop())
  assert.ok(order.indexOf("line_tracking_record_events") < order.indexOf("push"))
  assert.deepEqual(net.rpcArgs("line_tracking_finish_reply").map((a) => a.p_status), ["sent"])
})

test("tracking database down returns 500 and sends nothing", async () => {
  const net = mockNetwork({ [PUSH]: () => Response.json({}) })
  const mocked = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/rpc/line_tracking_record_events")) return Response.json({ message: "down" }, { status: 503 })
    return mocked(input, init)
  }) as typeof fetch
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 500)
  assert.deepEqual(pushedTo(net.calls), [])
})

test("follow push carries a retry key derived from the event id", async () => {
  const net = mockNetwork({ [PUSH]: () => Response.json({}) })
  await POST(signedRequest([follow("f1", "U1")]))
  const push = net.calls.find((c) => c.url === PUSH)!
  assert.equal(new Headers(push.init?.headers).get("x-line-retry-key"), retryKeyFor("f1"))
  assert.match(retryKeyFor("f1"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("redelivered follow whose push LINE already accepted (409) is treated as sent", async () => {
  const net = mockNetwork({
    [PUSH]: () => Response.json({ message: "The retry key is already accepted" }, {
      status: 409,
      headers: { "x-line-accepted-request-id": "abc" },
    }),
  })
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 200)
  assert.equal(net.reply.get("f1"), "sent")
})

test("LINE push returning 503 makes the webhook return 500 and leaves it retryable", async () => {
  const net = mockNetwork({ [PUSH]: () => new Response("unavailable", { status: 503 }) })
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 500)
  assert.equal(net.reply.get("f1"), "pending")
})

test("LINE push returning 400 is terminal and returns 200", async () => {
  const net = mockNetwork({ [PUSH]: () => new Response("bad", { status: 400 }) })
  const res = await POST(signedRequest([follow("f1", "U1")]))
  assert.equal(res.status, 200)
  assert.equal(net.reply.get("f1"), "failed")
})

test("a failed push still lets the next event in the batch run", async () => {
  const net = mockNetwork({
    [PUSH]: (_url, init) => {
      if (JSON.parse(String(init?.body)).to === "U1") throw new TypeError("network down")
      return Response.json({})
    },
  })
  const res = await POST(signedRequest([follow("f1", "U1"), follow("f2", "U2")]))
  assert.equal(res.status, 500)
  assert.deepEqual(pushedTo(net.calls), ["U1", "U2"])
})

test("image download returning 503 makes the webhook return 500 and the next event still runs", async () => {
  const net = mockNetwork({
    [IMAGE]: () => new Response("unavailable", { status: 503 }),
    [PUSH]: () => Response.json({}),
  })
  const res = await POST(signedRequest([image, follow("f2", "U2")]))
  assert.equal(res.status, 500)
  assert.ok(net.calls.some((c) => c.url === IMAGE))
  assert.deepEqual(pushedTo(net.calls), ["U2"])
  assert.equal(net.reply.get("img-ev"), "pending")
})

test("image download returning 404 is terminal: 200, failed, next event still runs", async () => {
  const net = mockNetwork({
    [IMAGE]: () => new Response("gone", { status: 404 }),
    [PUSH]: () => Response.json({}),
  })
  const res = await POST(signedRequest([image, follow("f2", "U2")]))
  assert.equal(res.status, 200)
  assert.equal(net.reply.get("img-ev"), "failed")
  assert.deepEqual(pushedTo(net.calls), ["U2"])
  // Redelivery does not download the unavailable content again
  const before = net.calls.filter((c) => c.url === IMAGE).length
  await POST(signedRequest([image]))
  assert.equal(net.calls.filter((c) => c.url === IMAGE).length, before)
})

test("image download network error makes the webhook return 500 and the next event still runs", async () => {
  const net = mockNetwork({
    [IMAGE]: () => {
      throw new TypeError("network down")
    },
    [PUSH]: () => Response.json({}),
  })
  const res = await POST(signedRequest([image, follow("f2", "U2")]))
  assert.equal(res.status, 500)
  assert.deepEqual(pushedTo(net.calls), ["U2"])
})
