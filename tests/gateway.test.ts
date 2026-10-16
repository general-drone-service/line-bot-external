import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { botDbs, chatMessageId, insertMessageWithFallback, isSealed } from "@/lib/botdb"
import { callGateway, gatewayBotDb, GatewayError } from "@/lib/botdb/gateway"
import { crmOutboxStore, crmTouchStore, crmTrackingStore } from "@/lib/tracking/store"
import { handleTouchRequest } from "@/lib/tracking/touch"
import { handleWebhookRequest } from "@/lib/line/webhook"

const GATEWAY = "https://crm.test/functions/v1/line-bot-data"
const SECRET = "test-gateway-secret"
const QUOTE = "https://quote.test"
const realFetch = globalThis.fetch
const savedEnv = { ...process.env }

// Copy of ACTIONS in the CRM repo supabase/functions/line-bot-data/handler.ts (PR #1207); the
// gateway rejects any request whose args keys differ from these.
const CONTRACT: Record<string, string[]> = {
  "history.load": ["p_user_id", "p_since", "p_limit"],
  "history.append": ["p_id", "p_user_id", "p_role", "p_content"],
  "pause.get": ["p_user_id"],
  "pause.set": ["p_user_id", "p_paused_until"],
  "pause.clear": ["p_user_id"],
  "knowledge.match": ["p_query_embedding", "p_match_count", "p_match_threshold"],
  "tracking.recordEvents": ["p_account_id", "p_events"],
  "tracking.processEvent": ["p_account_id", "p_webhook_event_id", "p_token_hash", "p_is_test_user"],
  "tracking.claimReply": ["p_account_id", "p_webhook_event_id"],
  "tracking.finishReply": ["p_account_id", "p_webhook_event_id", "p_status"],
  "tracking.createTouch": ["p_source_key", "p_idempotency_key", "p_token_hash", "p_ttl_days", "p_max_per_minute"],
  "tracking.leaseCrm": ["p_limit", "p_lease_seconds"],
  "tracking.claimCrmSend": ["p_event_id", "p_lease_token"],
  "tracking.finishCrm": ["p_event_id", "p_lease_token", "p_ok", "p_retryable", "p_error", "p_max_attempts"],
}

/** Gateway double that enforces the CRM handler's signature and args checks. */
function mockGateway(answer: (action: string, args: Record<string, unknown>) => Response = () => Response.json({ data: null })) {
  const seen: { action: string; args: Record<string, unknown> }[] = []
  const quoteCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith(QUOTE)) {
      quoteCalls.push(url)
      // PostgREST answer for the seal trigger's raise
      return Response.json({ code: "LB423", message: "sealed for cutover", details: null, hint: null }, { status: 400 })
    }
    assert.equal(url, GATEWAY)
    const raw = String(init?.body)
    const headers = new Headers(init?.headers)
    const ts = headers.get("x-drone168-timestamp") ?? ""
    assert.match(ts, /^\d{1,12}$/)
    assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)
    const expected = crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")
    assert.equal(headers.get("x-drone168-signature"), `sha256=${expected}`)
    const { action, args } = JSON.parse(raw)
    assert.ok(action in CONTRACT, `unknown action ${action}`)
    assert.deepEqual(Object.keys(args).sort(), [...CONTRACT[action]].sort(), action)
    seen.push({ action, args })
    return answer(action, args)
  }) as typeof fetch
  return { seen, quoteCalls }
}

beforeEach(() => {
  process.env.LINE_BOT_DATA_URL = GATEWAY
  process.env.LINE_BOT_DATA_SECRET = SECRET
  process.env.SUPABASE_URL = QUOTE
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
  delete process.env.QUOTE_SUPABASE_URL
  delete process.env.QUOTE_SUPABASE_SERVICE_ROLE_KEY
  delete process.env.BOT_DB
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...savedEnv }
})

test("every BotDb and tracking store method sends a contract-exact, signed request", async () => {
  const net = mockGateway((action) =>
    Response.json({
      data: action === "tracking.claimReply" ? 1 : ["history.load", "tracking.leaseCrm", "knowledge.match"].includes(action) ? [] : null,
    })
  )
  await gatewayBotDb.recentMessages("U1", "2026-10-15T00:00:00Z", 20)
  await gatewayBotDb.insertMessage({ id: chatMessageId("Ubot", "e1", "user"), user_id: "U1", role: "user", content: "hi" })
  await gatewayBotDb.pausedUntil("U1")
  await gatewayBotDb.setPause("U1", "2026-10-16T12:00:00Z")
  await gatewayBotDb.clearPause("U1")
  await gatewayBotDb.matchKnowledge([0.1, 0.2], 3, 0.3)
  await crmTrackingStore.recordEvents("Ubot", [])
  await crmTrackingStore.processEvent("Ubot", "e1", null, false)
  await crmTrackingStore.claimReply("Ubot", "e1")
  await crmTrackingStore.finishReply("Ubot", "e1", "sent")
  await crmTouchStore.createTouch("web", crypto.randomUUID(), "hash", 30, 120)
  await crmOutboxStore.leaseCrm(10, 120)
  await crmOutboxStore.claimSend(crypto.randomUUID(), crypto.randomUUID())
  await crmOutboxStore.finishCrm(crypto.randomUUID(), crypto.randomUUID(), { ok: true, retryable: false }, 8)
  assert.deepEqual(net.seen.map((s) => s.action).sort(), Object.keys(CONTRACT).sort())
  assert.equal(net.seen.find((s) => s.action === "knowledge.match")!.args.p_query_embedding, "[0.1,0.2]")
})

test("history rows come back without created_at, in the gateway's order", async () => {
  mockGateway(() =>
    Response.json({ data: [
      { role: "assistant", content: "b", created_at: "2026-10-16T01:00:00Z" },
      { role: "user", content: "a", created_at: "2026-10-16T00:00:00Z" },
    ] })
  )
  assert.deepEqual(await gatewayBotDb.recentMessages("U1", "x", 20), [
    { role: "assistant", content: "b" },
    { role: "user", content: "a" },
  ])
})

test("createTouch maps the jsonb object and null", async () => {
  mockGateway(() => Response.json({ data: { touch_id: "t1", expires_at: "2026-11-15T00:00:00Z" } }))
  assert.deepEqual(await crmTouchStore.createTouch("web", crypto.randomUUID(), "h", 30, 120), { expiresAt: "2026-11-15T00:00:00Z" })
  mockGateway(() => Response.json({ data: null }))
  assert.equal(await crmTouchStore.createTouch("web", crypto.randomUUID(), "h", 30, 120), null)
})

test("gateway errors keep status and Postgres code; a CRM-side seal is recognised", async () => {
  mockGateway(() => Response.json({ error: { code: "LB423", message: "sealed" } }, { status: 500 }))
  const err = await callGateway("pause.get", { p_user_id: "U1" }).catch((e) => e)
  assert.ok(err instanceof GatewayError)
  assert.equal(err.status, 500)
  assert.ok(isSealed(err))
  mockGateway(() => Response.json({ error: "Disabled", flag: "line_bot_data" }, { status: 503 }))
  const off = (await callGateway("pause.get", { p_user_id: "U1" }).catch((e) => e)) as GatewayError
  assert.equal(off.status, 503)
  assert.ok(!isSealed(off))
})

test("gateway 409 rate_limited / idempotency_conflict reach the touch API as 429 / 409", async () => {
  process.env.LINE_TRACKING_ENABLED = "true"
  process.env.LINE_TRACKING_TOKEN_SECRET = "test-token-secret"
  const touch = () =>
    handleTouchRequest(new Request("https://example.test/api/line/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "web", idempotencyKey: crypto.randomUUID() }),
    }), crmTouchStore)
  mockGateway(() => Response.json({ error: { code: "P0001", message: "rate_limited" } }, { status: 409 }))
  assert.equal((await touch()).status, 429)
  mockGateway(() => Response.json({ error: { code: "P0001", message: "idempotency_conflict" } }, { status: 409 }))
  assert.equal((await touch()).status, 409)
})

test("BOT_DB selects the primary; the other configured side is the seal fallback", () => {
  assert.equal(botDbs().primary === gatewayBotDb, false)
  assert.equal(botDbs().fallback, gatewayBotDb)
  process.env.BOT_DB = "crm"
  assert.equal(botDbs().primary, gatewayBotDb)
  assert.ok(botDbs().fallback)
  delete process.env.SUPABASE_URL
  assert.equal(botDbs().fallback, null)
  delete process.env.LINE_BOT_DATA_URL
  assert.throws(() => botDbs(), /BOT_DB=crm needs/)
  process.env.BOT_DB = "CRM"
  assert.throws(() => botDbs(), /Invalid BOT_DB/)
})

test("BOT_DB=quote without the gateway configured has no fallback", () => {
  delete process.env.LINE_BOT_DATA_SECRET
  assert.equal(botDbs().fallback, null)
})

test("a sealed quote-drone168 write lands in the CRM gateway with the same id", async () => {
  const net = mockGateway(() => Response.json({ data: true }))
  const row = { id: chatMessageId("Ubot", "e1", "assistant"), user_id: "U1", role: "assistant" as const, content: "您好" }
  await insertMessageWithFallback(botDbs(), row)
  assert.equal(net.quoteCalls.length, 1)
  assert.deepEqual(net.seen, [{ action: "history.append", args: { p_id: row.id, p_user_id: "U1", p_role: "assistant", p_content: "您好" } }])
})

test("a 200 that is not JSON, or has no data, is an error rather than an empty success", async () => {
  mockGateway(() => new Response("<html>proxy</html>", { status: 200 }))
  await assert.rejects(callGateway("pause.get", { p_user_id: "U1" }))
  mockGateway(() => Response.json({}))
  await assert.rejects(callGateway("pause.get", { p_user_id: "U1" }), /200 without data/)
  mockGateway(() => Response.json({ data: null }))
  assert.equal(await callGateway("pause.get", { p_user_id: "U1" }), null)
})

const LINE_SECRET = "test-channel-secret"
function signedWebhook() {
  const body = JSON.stringify({
    destination: "Ubot",
    events: [{ type: "message", webhookEventId: "e1", timestamp: 1, replyToken: "r", source: { type: "user", userId: "U1" }, message: { type: "text", id: "m1", text: "hi" } }],
  })
  const signature = crypto.createHmac("SHA256", LINE_SECRET).update(body).digest("base64")
  return new Request("https://example.test/api/webhook", { method: "POST", headers: { "x-line-signature": signature }, body })
}

/** Tracking via the gateway; `claim` answers tracking.claimReply, finishReply statuses are collected. */
function trackedGateway(claim: () => Response) {
  const finished: string[] = []
  mockGateway((action, args) => {
    if (action === "tracking.claimReply") return claim()
    if (action === "tracking.processEvent") return Response.json({ data: "no_token" })
    if (action === "tracking.finishReply") finished.push(String(args.p_status))
    return Response.json({ data: null })
  })
  return finished
}

test("an unreadable or malformed claim never runs the handler", async () => {
  process.env.LINE_CHANNEL_SECRET = LINE_SECRET
  for (const claim of [
    () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")) } }), { status: 200 }),
    () => Response.json({ data: "1" }),
    () => Response.json({ data: -1 }),
  ]) {
    trackedGateway(claim)
    let runs = 0
    const res = await handleWebhookRequest(signedWebhook(), async () => (runs++, "sent"), crmTrackingStore)
    assert.equal(res.status, 500)
    assert.equal(runs, 0)
  }
})

test("a gateway 422 inside the handler is terminal; a 500 stays retryable", async () => {
  process.env.LINE_CHANNEL_SECRET = LINE_SECRET
  const failWith = (status: number) => async () => {
    throw new GatewayError("history.append", status, status === 422 ? "23514" : undefined, "x")
  }
  let finished = trackedGateway(() => Response.json({ data: 1 }))
  assert.equal((await handleWebhookRequest(signedWebhook(), failWith(422), crmTrackingStore)).status, 200)
  assert.deepEqual(finished, ["failed"])
  finished = trackedGateway(() => Response.json({ data: 1 }))
  assert.equal((await handleWebhookRequest(signedWebhook(), failWith(500), crmTrackingStore)).status, 500)
  assert.deepEqual(finished, ["pending"])
})

test("a gateway 422 while tracking does not ask LINE to redeliver; a 500 does", async () => {
  process.env.LINE_CHANNEL_SECRET = LINE_SECRET
  for (const [status, expected] of [[422, 200], [500, 500]] as const) {
    mockGateway((action) => {
      if (action === "tracking.processEvent") return Response.json({ error: { code: "22P02", message: "bad" } }, { status })
      if (action === "tracking.claimReply") return Response.json({ data: 1 })
      return Response.json({ data: null })
    })
    assert.equal((await handleWebhookRequest(signedWebhook(), async () => "sent", crmTrackingStore)).status, expected)
  }
})
