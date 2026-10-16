import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { GET, POST } from "@/app/api/bot-pause/route"

const TOKEN = "test-bot-pause-token"
let saved: string | undefined

beforeEach(() => {
  saved = process.env.BOT_PAUSE_API_TOKEN
  process.env.BOT_PAUSE_API_TOKEN = TOKEN
})

afterEach(() => {
  if (saved === undefined) delete process.env.BOT_PAUSE_API_TOKEN
  else process.env.BOT_PAUSE_API_TOKEN = saved
})

const url = "https://example.test/api/bot-pause"

function postRequest(authorization?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (authorization) headers.authorization = authorization
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: "U1", action: "pause" }),
  })
}

test("GET without env token configured returns 503", async () => {
  delete process.env.BOT_PAUSE_API_TOKEN
  const res = await GET(new Request(`${url}?userId=U1`, { headers: { authorization: `Bearer ${TOKEN}` } }))
  assert.equal(res.status, 503)
})

test("GET without Authorization returns 401", async () => {
  const res = await GET(new Request(`${url}?userId=U1`))
  assert.equal(res.status, 401)
})

test("POST with wrong bearer token returns 401", async () => {
  const res = await POST(postRequest("Bearer test-bot-pause-tokeX"))
  assert.equal(res.status, 401)
})

test("POST with token of different length returns 401", async () => {
  const res = await POST(postRequest("Bearer short"))
  assert.equal(res.status, 401)
})

test("POST without env token configured returns 503", async () => {
  delete process.env.BOT_PAUSE_API_TOKEN
  const res = await POST(postRequest(`Bearer ${TOKEN}`))
  assert.equal(res.status, 503)
})

test("unauthorized POST with non-JSON body returns 401 before parsing", async () => {
  const res = await POST(new Request(url, { method: "POST", body: "{not json" }))
  assert.equal(res.status, 401)
})

// Valid token passes auth and reaches the existing validation (no database call)
test("GET with valid token and no userId returns 400", async () => {
  const res = await GET(new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } }))
  assert.equal(res.status, 400)
})

test("POST with valid token and no action returns 400", async () => {
  const res = await POST(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ userId: "U1" }),
    })
  )
  assert.equal(res.status, 400)
})
