import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { POST } from "@/app/api/health/handoff/route"

const TOKEN = "test-bot-pause-token"
const ALERT = "https://manager-line.example.workers.dev/alert"
let respond: () => Response
let calls: { url: string; body: string }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), body: String(init?.body ?? "") })
  return respond()
}) as typeof fetch

beforeEach(() => {
  calls = []
  process.env.BOT_PAUSE_API_TOKEN = TOKEN
  process.env.MANAGER_LINE_ALERT_URL = ALERT
  process.env.MANAGER_LINE_ALERT_TOKEN = "test-alert-token"
  delete process.env.SENDGRID_API_KEY
  delete process.env.NOTIFY_EMAIL_TO
  respond = () => Response.json({ sent: true }, { status: 202 })
})

const url = "https://example.test/api/health/handoff"
const authed = () => new Request(url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })

test("without bearer returns 401 and sends nothing", async () => {
  const res = await POST(new Request(url, { method: "POST" }))
  assert.equal(res.status, 401)
  assert.equal(calls.length, 0)
})

test("sends only fixed test data to the alert channel and reports delivered", async () => {
  const res = await POST(authed())
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { delivered: true })
  // Only the alert endpoint: no LINE, database or Anthropic call
  assert.deepEqual(calls.map((c) => c.url), [ALERT])
  const body = JSON.parse(calls[0].body)
  assert.match(body.title, /端到端測試，請忽略/)
  assert.match(body.body, /TEST-e2e/)
})

test("an undelivered alert returns 502 with delivered false", async () => {
  respond = () => Response.json({ error: "forbidden" }, { status: 403 })
  const res = await POST(authed())
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), { delivered: false })
})

test("delivered means any channel accepted: email success hides a manager-line failure", async () => {
  process.env.SENDGRID_API_KEY = "test-sendgrid"
  process.env.NOTIFY_EMAIL_TO = "ops@example.test"
  respond = () =>
    calls.at(-1)!.url === ALERT ? Response.json({ error: "x" }, { status: 503 }) : new Response(null, { status: 202 })
  const res = await POST(authed())
  assert.deepEqual(await res.json(), { delivered: true })
  assert.deepEqual(calls.map((c) => c.url).sort(), [ALERT, "https://api.sendgrid.com/v3/mail/send"].sort())
})
