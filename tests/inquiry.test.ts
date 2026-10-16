import assert from "node:assert/strict"
import { test } from "node:test"
import { isInquiryEvent } from "@/lib/tracking/inquiry"
import type { LineEvent } from "@/lib/line"

const user = { type: "user", userId: "U1" }
const msg = (message: LineEvent["message"], source: LineEvent["source"] = user): LineEvent => ({
  type: "message",
  source,
  message,
})

test("one-to-one text is an inquiry", () => {
  assert.equal(isInquiryEvent(msg({ type: "text", text: "想詢問外牆清洗" })), true)
})

test("whitespace-only text is not an inquiry", () => {
  assert.equal(isInquiryEvent(msg({ type: "text", text: "  \n " })), false)
  assert.equal(isInquiryEvent(msg({ type: "text" })), false)
})

test("image, video, audio, file, location are inquiries", () => {
  for (const type of ["image", "video", "audio", "file", "location"]) {
    assert.equal(isInquiryEvent(msg({ type, id: "m1" })), true, type)
  }
})

test("sticker is not an inquiry", () => {
  assert.equal(isInquiryEvent(msg({ type: "sticker", id: "m1" })), false)
})

test("group and room messages are not inquiries", () => {
  const text = { type: "text", text: "hi" }
  assert.equal(isInquiryEvent(msg(text, { type: "group", groupId: "C1", userId: "U1" })), false)
  assert.equal(isInquiryEvent(msg(text, { type: "room", roomId: "R1", userId: "U1" })), false)
  assert.equal(isInquiryEvent(msg(text, { type: "user" })), false)
})

test("follow and unsend are not inquiries", () => {
  assert.equal(isInquiryEvent({ type: "follow", source: user }), false)
  assert.equal(isInquiryEvent({ type: "unsend", source: user }), false)
})
