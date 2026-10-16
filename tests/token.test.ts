import assert from "node:assert/strict"
import { test } from "node:test"
import {
  deriveToken,
  extractToken,
  hashToken,
  lineChatUrl,
  prefillMessage,
  stripToken,
} from "@/lib/tracking/token"

const KEY = "3f2b8c1e-6d4a-4f7b-9a1c-2e5d8b7a6c40"

test("derived token is stable per idempotency key and secret", () => {
  assert.equal(deriveToken("s1", KEY), deriveToken("s1", KEY))
  assert.notEqual(deriveToken("s1", KEY), deriveToken("s2", KEY))
  assert.notEqual(deriveToken("s1", KEY), deriveToken("s1", "4f2b8c1e-6d4a-4f7b-9a1c-2e5d8b7a6c40"))
  assert.match(deriveToken("s1", KEY), /^L-[0-9a-f]{32}$/)
})

test("token never looks like a quote code", () => {
  for (let i = 0; i < 200; i++) {
    const token = deriveToken(`secret-${i}`, KEY)
    assert.doesNotMatch(prefillMessage(token), /Q-\w{8}-\w{3}/i)
  }
})

test("hash is sha256 hex and differs from the token", () => {
  const token = deriveToken("s1", KEY)
  assert.match(hashToken(token), /^[0-9a-f]{64}$/)
  assert.notEqual(hashToken(token), token)
})

test("prefilled message round-trips through extract and strip", () => {
  const token = deriveToken("s1", KEY)
  const message = prefillMessage(token)
  assert.equal(message, `您好，我想了解外牆清洗服務。〔來源：${token}〕`)
  assert.equal(extractToken(message), token)
  assert.equal(stripToken(message), "您好，我想了解外牆清洗服務。")
})

test("token is found when the user edits around it", () => {
  const token = deriveToken("s1", KEY)
  assert.equal(extractToken(`請問報價 ${token} 謝謝`), token)
  assert.equal(stripToken(`請問報價 ${token} 謝謝`), "請問報價 謝謝")
  assert.equal(extractToken(`〔來源：${token.toUpperCase()}〕`), null)
})

test("text without a token is unchanged", () => {
  assert.equal(extractToken("我想詢問 Q-20260323-456"), null)
  assert.equal(stripToken("我想詢問 Q-20260323-456"), "我想詢問 Q-20260323-456")
})

test("chat url percent-encodes the account id and message", () => {
  assert.equal(
    lineChatUrl("Hi there!"),
    "https://line.me/R/oaMessage/%40058xfgns/?Hi%20there!"
  )
  const url = lineChatUrl(prefillMessage(deriveToken("s1", KEY)))
  assert.ok(url.startsWith("https://line.me/R/oaMessage/%40058xfgns/?"))
  assert.equal(decodeURIComponent(url.split("?")[1]), prefillMessage(deriveToken("s1", KEY)))
})
