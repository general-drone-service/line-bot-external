import type { LineEvent } from "@/lib/line"

const INQUIRY_MEDIA_TYPES = new Set(["image", "video", "audio", "file", "location"])

/** A user-sent one-to-one message that counts as "開始詢問"; group/room chats and stickers never count. */
export function isInquiryEvent(event: LineEvent): boolean {
  if (event.type !== "message" || event.source?.type !== "user" || !event.source.userId) return false
  const message = event.message
  if (!message) return false
  if (message.type === "text") return (message.text ?? "").trim() !== ""
  return INQUIRY_MEDIA_TYPES.has(message.type)
}
