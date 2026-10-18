import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { requestHumanHandoff } from "@/lib/services/notify"

const ALERT = "https://manager-line.example.workers.dev/alert"
let respond: () => Response
let calls: { url: string; init: RequestInit }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), init: init ?? {} })
  return respond()
}) as typeof fetch

beforeEach(() => {
  calls = []
  process.env.MANAGER_LINE_ALERT_URL = ALERT
  process.env.MANAGER_LINE_ALERT_TOKEN = "test-alert-token"
  delete process.env.SENDGRID_API_KEY
  delete process.env.NOTIFY_EMAIL_TO
  delete process.env.DISCORD_WEBHOOK_URL
  delete process.env.LINE_NOTIFY_ACCESS_TOKEN
  respond = () => Response.json({ sent: true }, { status: 202 })
})

const payload = (over: Partial<Parameters<typeof requestHumanHandoff>[0]> = {}) => ({
  userId: "U123",
  reason: "客戶要報價",
  lastMessages: ["user: 一", "assistant: 二", "user: 三", "assistant: 四", "user: 五"],
  ...over,
})

test("posts a whitelisted warning alert with bearer and no dedupe_key", async () => {
  assert.equal(await requestHumanHandoff(payload()), true)
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, ALERT)
  assert.equal(init.method, "POST")
  const headers = new Headers(init.headers)
  assert.equal(headers.get("authorization"), "Bearer test-alert-token")
  assert.equal(headers.get("content-type"), "application/json")
  const body = JSON.parse(String(init.body))
  assert.deepEqual(Object.keys(body).sort(), ["body", "severity", "source", "title"])
  assert.equal(body.source, "line-bot-handoff")
  assert.equal(body.severity, "warning")
  assert.match(body.title, /客戶要報價/)
  assert.match(body.body, /U123/)
  // Last 4 messages only
  assert.doesNotMatch(body.body, /user: 一/)
  assert.match(body.body, /user: 五/)
})

test("long reason and messages stay within the alert limits", async () => {
  await requestHumanHandoff(payload({ reason: "因".repeat(300), lastMessages: Array(6).fill("user: " + "字".repeat(900)) }))
  const body = JSON.parse(String(calls[0].init.body))
  assert.ok([...body.title].length <= 100)
  assert.ok([...body.body].length <= 1000)
  assert.ok(new TextEncoder().encode(String(calls[0].init.body)).length <= 4096)
})

test("control characters and emoji cannot push the request past 4 KB", async () => {
  for (const filler of ["\u0001", "😀", '"']) {
    calls = []
    await requestHumanHandoff(payload({ reason: filler.repeat(300), lastMessages: Array(6).fill(filler.repeat(900)) }))
    assert.ok(new TextEncoder().encode(String(calls[0].init.body)).length <= 4000, `filler ${JSON.stringify(filler)}`)
  }
})

test("a deduped alert still counts as delivered", async () => {
  respond = () => Response.json({ sent: false, reason: "deduped" }, { status: 200 })
  assert.equal(await requestHumanHandoff(payload()), true)
})

for (const status of [400, 401, 413, 429, 502, 503]) {
  test(`alert answering ${status} is not delivered`, async () => {
    respond = () => Response.json({ error: "x" }, { status })
    assert.equal(await requestHumanHandoff(payload()), false)
  })
}

test("a network failure is not delivered", async () => {
  respond = () => {
    throw new TypeError("fetch failed")
  }
  assert.equal(await requestHumanHandoff(payload()), false)
})

test("no configured channel means not delivered and no request", async () => {
  delete process.env.MANAGER_LINE_ALERT_URL
  assert.equal(await requestHumanHandoff(payload()), false)
  assert.equal(calls.length, 0)
})

test("Discord and LINE Notify are never called", async () => {
  process.env.DISCORD_WEBHOOK_URL = "https://discord.example/webhook"
  process.env.LINE_NOTIFY_ACCESS_TOKEN = "x"
  await requestHumanHandoff(payload())
  assert.deepEqual(calls.map((c) => c.url), [ALERT])
})

test("email answering non-2xx is not delivered", async () => {
  delete process.env.MANAGER_LINE_ALERT_URL
  process.env.SENDGRID_API_KEY = "test-sendgrid"
  process.env.NOTIFY_EMAIL_TO = "ops@example.test"
  respond = () => new Response("forbidden", { status: 403 })
  assert.equal(await requestHumanHandoff(payload()), false)
  respond = () => new Response(null, { status: 202 })
  assert.equal(await requestHumanHandoff(payload()), true)
})
