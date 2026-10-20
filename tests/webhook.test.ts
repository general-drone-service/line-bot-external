import assert from "node:assert/strict"
import crypto from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { handleWebhookRequest } from "@/lib/line/webhook"
import { LineApiError } from "@/lib/line/send"
import type { EventOutcome, LineEvent } from "@/lib/line"
import { deriveToken, hashToken, prefillMessage } from "@/lib/tracking/token"
import { fakeStore } from "./helpers/fake-store"

const SECRET = "test-channel-secret"
const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.LINE_CHANNEL_SECRET = SECRET
  delete process.env.LINE_TEST_USER_IDS
})

afterEach(() => {
  process.env = { ...savedEnv }
})

function sign(body: string) {
  return crypto.createHmac("SHA256", SECRET).update(body).digest("base64")
}

function webhookRequest(body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (signature !== null) headers["x-line-signature"] = signature
  return new Request("https://example.test/api/webhook", { method: "POST", headers, body })
}

const batch = (...events: LineEvent[]) => JSON.stringify({ destination: "Ubot", events })

let seq = 0
const textEvent = (text: string, id = `ev${++seq}`, userId = "U1"): LineEvent => ({
  type: "message",
  webhookEventId: id,
  timestamp: 1760600000000,
  replyToken: "r",
  source: { type: "user", userId },
  message: { type: "text", id: `m-${id}`, text },
})

/** Handler that records every call; `behave` decides the outcome per call number (1-based). */
function recorder(behave: (call: number) => EventOutcome | Error = () => "sent") {
  const seen: LineEvent[] = []
  const handle = async (event: LineEvent) => {
    seen.push(event)
    const result = behave(seen.length)
    if (result instanceof Error) throw result
    return result
  }
  return { seen, handle }
}

// ─── Signature and body validation (P0) ──────────────────────────────────────

test("missing signature header returns 401", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch(), null), handle, fakeStore().store)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("missing channel secret returns 500 and does not handle events", async () => {
  const req = webhookRequest(batch(textEvent("hi")))
  delete process.env.LINE_CHANNEL_SECRET
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(req, handle, fakeStore().store)
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: "Server misconfigured" })
  assert.equal(seen.length, 0)
})

test("wrong-length signature is rejected", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("hi")), "short"), handle, fakeStore().store)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("same-length wrong signature is rejected", async () => {
  const body = batch(textEvent("hi"))
  const forged = sign(body + "x")
  assert.equal(forged.length, sign(body).length)
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(body, forged), handle, fakeStore().store)
  assert.equal(res.status, 401)
  assert.equal(seen.length, 0)
})

test("valid signature over multibyte body is accepted", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(
    webhookRequest(batch(textEvent("您好，我想了解外牆清洗服務"))),
    handle,
    fakeStore().store
  )
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message?.text, "您好，我想了解外牆清洗服務")
})

test("empty events returns 200 without touching the store", async () => {
  const { handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch()), handle, fakeStore({ recordEvents: 1 }).store)
  assert.equal(res.status, 200)
})

test("invalid JSON returns 400", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest("{not json"), handle, fakeStore().store)
  assert.equal(res.status, 400)
  assert.equal(seen.length, 0)
})

test("events without webhookEventId or destination return 400", async () => {
  const { seen, handle } = recorder()
  const noId = JSON.stringify({ destination: "Ubot", events: [{ ...textEvent("hi"), webhookEventId: undefined }] })
  assert.equal((await handleWebhookRequest(webhookRequest(noId), handle, fakeStore().store)).status, 400)
  const noDest = JSON.stringify({ events: [textEvent("hi")] })
  assert.equal((await handleWebhookRequest(webhookRequest(noDest), handle, fakeStore().store)).status, 400)
  assert.equal(seen.length, 0)
})

// ─── Persistence before reply (P1) ───────────────────────────────────────────

test("record failure returns 500 before any reply", async () => {
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("a"), textEvent("b"))), handle, fakeStore({ recordEvents: 1 }).store)
  assert.equal(res.status, 500)
  assert.equal(seen.length, 0)
})

test("redelivering the same event three times replies once", async () => {
  const fake = fakeStore()
  const { seen, handle } = recorder()
  const body = batch(textEvent("hi", "dup"))
  for (let i = 0; i < 3; i++) {
    assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 200)
  }
  assert.equal(seen.length, 1)
  assert.equal(fake.status("dup"), "sent")
})

test("event already being handled by another delivery is not replied again", async () => {
  const fake = fakeStore()
  const { seen, handle } = recorder()
  const event = textEvent("hi", "busy")
  await fake.store.recordEvents("Ubot", [event])
  await fake.store.claimReply("Ubot", "busy")
  const res = await handleWebhookRequest(webhookRequest(batch(event)), handle, fake.store)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 0)
})

test("recorded but unclaimed event is recovered on redelivery", async () => {
  const fake = fakeStore()
  const event = textEvent("hi", "crash")
  await fake.store.recordEvents("Ubot", [event]) // simulates a crash right after recording
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch(event)), handle, fake.store)
  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
})

test("one failing event still processes others and returns 500", async () => {
  const { seen, handle } = recorder((call) => (call === 2 ? new Error("boom") : "sent"))
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("a"), textEvent("b"), textEvent("c"))), handle, fakeStore().store)
  assert.equal(seen.length, 3)
  assert.equal(res.status, 500)
})

test("LINE 4xx is terminal: 200, failed, not retried on redelivery", async () => {
  const fake = fakeStore()
  const { seen, handle } = recorder(() => new LineApiError("reply", 400))
  const body = batch(textEvent("hi", "bad-token"))
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 200)
  assert.equal(fake.status("bad-token"), "failed")
  await handleWebhookRequest(webhookRequest(body), handle, fake.store)
  assert.equal(seen.length, 1)
})

test("LINE 5xx returns 500 and the redelivery retries", async () => {
  const fake = fakeStore()
  const { seen, handle } = recorder((call) => (call === 1 ? new LineApiError("reply", 503) : "sent"))
  const body = batch(textEvent("hi", "flaky"))
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 500)
  assert.equal(fake.status("flaky"), "pending")
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 200)
  assert.equal(seen.length, 2)
  assert.equal(fake.status("flaky"), "sent")
})

test("network error returns 500 and stays retryable", async () => {
  const fake = fakeStore()
  const { handle } = recorder(() => new TypeError("fetch failed"))
  assert.equal((await handleWebhookRequest(webhookRequest(batch(textEvent("hi", "net"))), handle, fake.store)).status, 500)
  assert.equal(fake.status("net"), "pending")
})

test("4xx after an earlier failed attempt is recorded as unknown", async () => {
  const fake = fakeStore()
  const { handle } = recorder((call) => (call === 1 ? new TypeError("fetch failed") : new LineApiError("reply", 400)))
  const body = batch(textEvent("hi", "ambiguous"))
  await handleWebhookRequest(webhookRequest(body), handle, fake.store)
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 200)
  assert.equal(fake.status("ambiguous"), "unknown")
})

test("skipped outcome is terminal", async () => {
  const fake = fakeStore()
  const { seen, handle } = recorder(() => "skipped")
  const body = batch(textEvent("hi", "office-hours"))
  await handleWebhookRequest(webhookRequest(body), handle, fake.store)
  await handleWebhookRequest(webhookRequest(body), handle, fake.store)
  assert.equal(fake.status("office-hours"), "skipped")
  assert.equal(seen.length, 1)
})

// ─── Tracking (P1) ───────────────────────────────────────────────────────────

test("token is hashed for tracking and stripped before the handler sees the text", async () => {
  const fake = fakeStore()
  const token = deriveToken("s", "3f2b8c1e-6d4a-4f7b-9a1c-2e5d8b7a6c40")
  const { seen, handle } = recorder()
  await handleWebhookRequest(webhookRequest(batch(textEvent(prefillMessage(token), "tok"))), handle, fake.store)
  assert.deepEqual(fake.processed, [{ id: "tok", tokenHash: hashToken(token), isTestUser: false }])
  assert.equal(seen[0].message?.text, "您好，我想了解外牆清洗服務。")
  assert.ok(!JSON.stringify(seen[0]).includes(token))
})

test("message that is only a token reaches the handler as a greeting", async () => {
  const token = deriveToken("s", "3f2b8c1e-6d4a-4f7b-9a1c-2e5d8b7a6c40")
  const { seen, handle } = recorder()
  await handleWebhookRequest(webhookRequest(batch(textEvent(token, "only-token"))), handle, fakeStore().store)
  assert.equal(seen[0].message?.text, "您好")
})

test("configured test users are flagged", async () => {
  process.env.LINE_TEST_USER_IDS = "Utest1, Utest2"
  const fake = fakeStore()
  const { handle } = recorder()
  await handleWebhookRequest(webhookRequest(batch(textEvent("hi", "t1", "Utest2"), textEvent("hi", "t2", "U9"))), handle, fake.store)
  assert.deepEqual(fake.processed.map((p) => p.isTestUser), [true, false])
})

test("tracking failure still replies, returns 500, and is retried without a second reply", async () => {
  const fake = fakeStore({ processEvent: 1 })
  const { seen, handle } = recorder()
  const body = batch(textEvent("hi", "track-fail"))
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 500)
  assert.equal(seen.length, 1)
  assert.equal(fake.processed.length, 0)
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 200)
  assert.equal(fake.processed.length, 1)
  assert.equal(seen.length, 1)
})

test("failure to store the reply status after sending returns 500 but never re-sends", async () => {
  const fake = fakeStore({ finishReply: 1 })
  const { seen, handle } = recorder()
  const body = batch(textEvent("hi", "finish-fail"))
  assert.equal((await handleWebhookRequest(webhookRequest(body), handle, fake.store)).status, 500)
  assert.equal(fake.status("finish-fail"), "sending")
  await handleWebhookRequest(webhookRequest(body), handle, fake.store)
  assert.equal(seen.length, 1)
})

// ─── Deferred processing: respond first, reply in the background (#100) ─────

/** Captures the background task instead of running it, like a platform waitUntil. */
function deferred() {
  const tasks: (() => Promise<void>)[] = []
  return { tasks, defer: (task: () => Promise<void>) => (tasks.push(task), true) }
}

function captureConsoleError() {
  const lines: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  return { lines, restore: () => (console.error = real) }
}

test("with defer, responds 200 before the handler settles and replies afterwards", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const seen: LineEvent[] = []
  const handle = async (event: LineEvent): Promise<EventOutcome> => {
    seen.push(event)
    await gate
    return "sent"
  }
  const { store, status } = fakeStore()
  const { tasks, defer } = deferred()
  const event = textEvent("hi")
  const res = await handleWebhookRequest(webhookRequest(batch(event)), handle, store, { defer })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.equal(tasks.length, 1)
  assert.equal(status(event.webhookEventId!), "pending")

  const running = tasks[0]()
  release()
  await running
  assert.equal(seen.length, 1)
  assert.equal(status(event.webhookEventId!), "sent")
})

test("with defer, a handler failure is logged and never rejects the background task", async () => {
  const { handle } = recorder(() => new Error("boom"))
  const { tasks, defer } = deferred()
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("hi"))), handle, fakeStore().store, { defer })
  assert.equal(res.status, 200)
  const log = captureConsoleError()
  try {
    await tasks[0]()
  } finally {
    log.restore()
  }
  assert.ok(log.lines.some((l) => l.includes("failed in background")), log.lines.join("\n"))
})

test("with defer, a batch still running past slowMs is logged", async () => {
  const handle = async (): Promise<EventOutcome> => {
    await new Promise((r) => setTimeout(r, 40))
    return "sent"
  }
  const { tasks, defer } = deferred()
  await handleWebhookRequest(webhookRequest(batch(textEvent("hi"))), handle, fakeStore().store, { defer, slowMs: 5 })
  const log = captureConsoleError()
  try {
    await tasks[0]()
  } finally {
    log.restore()
  }
  assert.ok(log.lines.some((l) => l.includes("still running")), log.lines.join("\n"))
})

test("a defer that cannot schedule falls back to inline replies with the 500 retry contract", async () => {
  const { seen, handle } = recorder(() => new Error("boom"))
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("hi"))), handle, fakeStore().store, { defer: () => false })
  assert.equal(res.status, 500)
  assert.equal(seen.length, 1)
})

test("with defer, an invalid signature is still rejected without scheduling work", async () => {
  const { tasks, defer } = deferred()
  const { seen, handle } = recorder()
  const res = await handleWebhookRequest(webhookRequest(batch(textEvent("hi")), "short"), handle, fakeStore().store, { defer })
  assert.equal(res.status, 401)
  assert.equal(tasks.length, 0)
  assert.equal(seen.length, 0)
})
