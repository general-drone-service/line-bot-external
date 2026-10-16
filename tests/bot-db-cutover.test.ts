import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { POST as webhook } from "@/app/api/webhook/route"
import { POST as botPause } from "@/app/api/bot-pause/route"
import {
  chatMessageId,
  insertMessageWithFallback,
  SEALED_CODE,
  setBotDbsForTest,
  uuidV5,
  type BotDb,
  type NewChatRow,
} from "@/lib/botdb"

const SECRET = "test-channel-secret"
const REPLY = "https://api.line.me/v2/bot/message/reply"
const PUSH = "https://api.line.me/v2/bot/message/push"
const ANTHROPIC = "https://api.anthropic.com/v1/messages"
const IMAGE = "https://api-data.line.me/v2/bot/message/img1/content"
const savedEnv = { ...process.env }

// The Anthropic client is cached and binds fetch once, so one dispatcher stays installed for the file
type Handler = (init: RequestInit | undefined) => Response | Promise<Response>
let routes: Record<string, Handler> = {}
let calls: { url: string; body: unknown }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
  const handler = routes[url]
  if (!handler) throw new Error(`unexpected fetch ${url}`)
  return handler(init)
}) as typeof fetch

const sealed = () => Object.assign(new Error("sealed"), { code: SEALED_CODE })

function fakeDb(overrides: Partial<BotDb> = {}) {
  const rows = new Map<string, NewChatRow>()
  const pauses = new Map<string, string>()
  const db: BotDb = {
    async recentMessages() {
      return []
    },
    async insertMessage(row) {
      if (!rows.has(row.id)) rows.set(row.id, row)
    },
    async pausedUntil(userId) {
      return pauses.get(userId) ?? null
    },
    async setPause(userId, until) {
      pauses.set(userId, until)
    },
    async clearPause(userId) {
      pauses.delete(userId)
    },
    async matchKnowledge() {
      return []
    },
    ...overrides,
  }
  return { db, rows, pauses }
}

const textReply = (text: string) => () =>
  Response.json({
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token"
  process.env.ANTHROPIC_API_KEY = "test-anthropic"
  process.env.BUSINESS_HOURS_DAYS = "7" // never business hours
  process.env.BOT_PAUSE_API_TOKEN = "test-pause-token"
  delete process.env.LINE_TRACKING_ENABLED
  delete process.env.BOT_CUTOVER_FREEZE
  calls = []
  routes = { [REPLY]: () => Response.json({}), [PUSH]: () => Response.json({}), [ANTHROPIC]: textReply("您好") }
})

afterEach(() => {
  process.env = { ...savedEnv }
  setBotDbsForTest(null)
})

function signed(events: unknown[]) {
  const body = JSON.stringify({ destination: "Ubot", events })
  const signature = crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
  return new Request("https://example.test/api/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  })
}

const text = (id: string, message: string) => ({
  type: "message", webhookEventId: id, timestamp: 1760600000000, replyToken: `r-${id}`,
  source: { type: "user", userId: "U1" }, message: { type: "text", id: `m-${id}`, text: message },
})
const image = {
  type: "message", webhookEventId: "img-ev", timestamp: 1760600000000, replyToken: "r-img",
  source: { type: "user", userId: "U1" }, message: { type: "image", id: "img1" },
}
const follow = {
  type: "follow", webhookEventId: "f1", timestamp: 1760600000000, source: { type: "user", userId: "U1" },
}
const sent = (url: string) => calls.filter((c) => c.url === url).length

test("uuidV5 matches the RFC 4122 reference vector", () => {
  assert.equal(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2")
})

test("chat ids are stable per event and role, and differ across roles and accounts", () => {
  assert.equal(chatMessageId("Ubot", "e1", "user"), chatMessageId("Ubot", "e1", "user"))
  assert.notEqual(chatMessageId("Ubot", "e1", "user"), chatMessageId("Ubot", "e1", "assistant"))
  assert.notEqual(chatMessageId("Ubot", "e1", "user"), chatMessageId("Uother", "e1", "user"))
})

test("insertMessageWithFallback only falls back on the seal error", async () => {
  const row = { id: "x", user_id: "U1", role: "user" as const, content: "hi" }
  const target = fakeDb()
  await insertMessageWithFallback({ primary: fakeDb({ insertMessage: async () => { throw sealed() } }).db, fallback: target.db }, row)
  assert.ok(target.rows.has("x"))

  const other = fakeDb()
  await assert.rejects(
    insertMessageWithFallback({ primary: fakeDb({ insertMessage: async () => { throw new Error("down") } }).db, fallback: other.db }, row),
    /down/
  )
  assert.equal(other.rows.size, 0)
  await assert.rejects(insertMessageWithFallback({ primary: fakeDb({ insertMessage: async () => { throw sealed() } }).db, fallback: null }, row))
})

test("a text turn stores user and assistant rows once, even when LINE redelivers it", async () => {
  const { db, rows } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 200)
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 200)
  assert.deepEqual([...rows.keys()].sort(), [chatMessageId("Ubot", "e1", "user"), chatMessageId("Ubot", "e1", "assistant")].sort())
})

test("writes go to the fallback once the primary is sealed", async () => {
  const primary = fakeDb({ insertMessage: async () => { throw sealed() } })
  const fallback = fakeDb()
  setBotDbsForTest({ primary: primary.db, fallback: fallback.db })
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 200)
  assert.equal(fallback.rows.size, 2)
  assert.equal(sent(REPLY), 1)
})

test("sealed primary with no fallback fails the event before any AI call or reply", async () => {
  setBotDbsForTest({ primary: fakeDb({ insertMessage: async () => { throw sealed() } }).db, fallback: null })
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 500)
  assert.equal(sent(ANTHROPIC), 0)
  assert.equal(sent(REPLY), 0)
})

test("a failed assistant write fails the event without replying", async () => {
  const { db, rows } = fakeDb()
  const insert = db.insertMessage
  db.insertMessage = async (row) => {
    if (row.role === "assistant") throw new Error("down")
    return insert(row)
  }
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 500)
  assert.equal(sent(REPLY), 0)
  assert.equal(rows.size, 1)
})

test("a failed assistant write on an image fails the event without replying", async () => {
  const { db } = fakeDb({
    insertMessage: async (row) => {
      if (row.role === "assistant") throw new Error("down")
    },
  })
  setBotDbsForTest({ primary: db, fallback: null })
  routes[IMAGE] = () => new Response("jpeg")
  assert.equal((await webhook(signed([image]))).status, 500)
  assert.equal(sent(REPLY), 0)
})

test("a quote code no longer bypasses the human-handoff pause", async () => {
  const { db, pauses } = fakeDb()
  pauses.set("U1", new Date(Date.now() + 3600_000).toISOString())
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await webhook(signed([text("e1", "Q-20260327-619")]))).status, 200)
  assert.equal(sent(ANTHROPIC), 0)
  assert.equal(sent(REPLY), 0)
})

test("the AI no longer offers a quote lookup tool", async () => {
  setBotDbsForTest({ primary: fakeDb().db, fallback: null })
  await webhook(signed([text("e1", "Q-20260327-619")]))
  const request = calls.find((c) => c.url === ANTHROPIC)!.body as { tools: { name: string }[] }
  assert.deepEqual(request.tools.map((t) => t.name), ["search_knowledge", "request_human"])
})

test("cutover freeze stops AI replies and history writes but keeps the follow greeting", async () => {
  process.env.BOT_CUTOVER_FREEZE = "on"
  const { db, rows } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await webhook(signed([text("e1", "想洗外牆"), follow]))).status, 200)
  assert.equal(sent(ANTHROPIC), 0)
  assert.equal(sent(REPLY), 0)
  assert.equal(sent(PUSH), 1)
  assert.equal(rows.size, 0)
})

test("request_human that cannot pause tells the AI the handoff failed", async () => {
  const { db, pauses } = fakeDb({ setPause: async () => { throw sealed() } })
  setBotDbsForTest({ primary: db, fallback: null })
  let turn = 0
  routes[ANTHROPIC] = () =>
    turn++ === 0
      ? Response.json({
          id: "msg_0", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
          content: [{ type: "tool_use", id: "tu1", name: "request_human", input: { reason: "要真人" } }],
          stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        })
      : textReply("請撥打 02-7733-7678")()
  assert.equal((await webhook(signed([text("e1", "我要找真人")]))).status, 200)
  const second = calls.filter((c) => c.url === ANTHROPIC)[1].body as { messages: { content: unknown }[] }
  const toolResult = JSON.stringify(second.messages.at(-1)!.content)
  assert.match(toolResult, /轉接失敗/)
  assert.doesNotMatch(toolResult, /已暫停/)
  assert.equal(pauses.size, 0)
})

function pauseRequest(action: string) {
  return new Request("https://example.test/api/bot-pause", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-pause-token" },
    body: JSON.stringify({ userId: "U1", action }),
  })
}

test("bot-pause API stores pause and resume", async () => {
  const { db, pauses } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await botPause(pauseRequest("pause"))).status, 200)
  assert.ok(pauses.has("U1"))
  assert.equal((await botPause(pauseRequest("resume"))).status, 200)
  assert.equal(pauses.size, 0)
})

test("bot-pause API returns 503 during the cutover freeze without writing", async () => {
  process.env.BOT_CUTOVER_FREEZE = "on"
  const { db, pauses } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  assert.equal((await botPause(pauseRequest("pause"))).status, 503)
  assert.equal((await botPause(pauseRequest("resume"))).status, 503)
  assert.equal(pauses.size, 0)
})

test("bot-pause API returns 500 when the write fails (e.g. sealed)", async () => {
  setBotDbsForTest({ primary: fakeDb({ setPause: async () => { throw sealed() }, clearPause: async () => { throw sealed() } }).db, fallback: null })
  assert.equal((await botPause(pauseRequest("pause"))).status, 500)
  assert.equal((await botPause(pauseRequest("resume"))).status, 500)
})

const assistantWriteFails = () => {
  const { db, rows } = fakeDb()
  const insert = db.insertMessage
  db.insertMessage = async (row) => {
    if (row.role === "assistant") throw new Error("down")
    return insert(row)
  }
  return { db, rows }
}
const maxTokens = () =>
  Response.json({
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "..." }], stop_reason: "max_tokens", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })

test("the text apology fallback is stored before it is sent", async () => {
  const { db, rows } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  routes[ANTHROPIC] = maxTokens
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 200)
  assert.match(rows.get(chatMessageId("Ubot", "e1", "assistant"))!.content, /抱歉/)
  assert.equal(sent(REPLY), 1)
})

test("the text apology fallback is not sent when it cannot be stored", async () => {
  setBotDbsForTest({ primary: assistantWriteFails().db, fallback: null })
  routes[ANTHROPIC] = maxTokens
  assert.equal((await webhook(signed([text("e1", "想洗外牆")]))).status, 500)
  assert.equal(sent(REPLY), 0)
})

test("the image apology fallback is stored before it is sent", async () => {
  const { db, rows } = fakeDb()
  setBotDbsForTest({ primary: db, fallback: null })
  routes[IMAGE] = () => new Response("jpeg")
  routes[ANTHROPIC] = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 })
  assert.equal((await webhook(signed([image]))).status, 200)
  assert.match(rows.get(chatMessageId("Ubot", "img-ev", "assistant"))!.content, /圖片分析暫時無法使用/)
  assert.equal(sent(REPLY), 1)
})

test("the image apology fallback is not sent when it cannot be stored", async () => {
  setBotDbsForTest({ primary: assistantWriteFails().db, fallback: null })
  routes[IMAGE] = () => new Response("jpeg")
  routes[ANTHROPIC] = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 })
  assert.equal((await webhook(signed([image]))).status, 500)
  assert.equal(sent(REPLY), 0)
})

test("an Anthropic API error is logged with status, type and request id but no customer text", async () => {
  setBotDbsForTest({ primary: fakeDb().db, fallback: null })
  routes[ANTHROPIC] = () =>
    Response.json(
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_test_1" },
      { status: 401, headers: { "request-id": "req_test_1" } }
    )
  const logged: unknown[][] = []
  const realError = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    assert.equal((await webhook(signed([text("e1", "想洗外牆的秘密內容")]))).status, 500)
  } finally {
    console.error = realError
  }
  const line = logged.find((a) => a[0] === "LINE webhook: event handling failed")
  assert.ok(line, "handler failure is logged")
  assert.deepEqual(line.at(-1), { status: 401, type: "authentication_error", requestId: "req_test_1" })
  assert.doesNotMatch(JSON.stringify(logged), /秘密內容|test-anthropic/)
  assert.equal(sent(REPLY), 0)
})

test("connection-level SDK errors are told apart without their cause", async () => {
  const { describeError } = await import("@/lib/errors")
  const Anthropic = (await import("@anthropic-ai/sdk")).default
  const cause = new Error("secret customer text")
  assert.deepEqual(describeError(new Anthropic.APIConnectionTimeoutError()), { status: null, type: "timeout", requestId: null })
  assert.deepEqual(describeError(new Anthropic.APIConnectionError({ cause })), { status: null, type: "connection_error", requestId: null })
  assert.deepEqual(describeError(new Anthropic.APIUserAbortError()), { status: null, type: "aborted", requestId: null })
  const plain = new Error("x")
  assert.equal(describeError(plain), plain)
})

test("a handoff followed by a failing AI call logs no customer details anywhere", async () => {
  setBotDbsForTest({ primary: fakeDb().db, fallback: null })
  let turn = 0
  routes[ANTHROPIC] = () =>
    turn++ === 0
      ? Response.json({
          id: "msg_0", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
          content: [{ type: "tool_use", id: "tu1", name: "request_human", input: { reason: "客戶地址台北市秘密路1號" } }],
          stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        })
      : Response.json({ type: "error", error: { type: "invalid_request_error", message: "echo: 秘密路" } }, { status: 400 })
  const logged: unknown[][] = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = (...args: unknown[]) => void logged.push(args)
  try {
    assert.equal((await webhook(signed([text("e1", "我住秘密路，請找真人")]))).status, 500)
  } finally {
    Object.assign(console, saved)
  }
  assert.ok(logged.some((a) => a[0] === "Human handoff requested for user:"))
  assert.doesNotMatch(JSON.stringify(logged), /秘密/)
})
