import { getChannelAccessToken, handleWebhookRequest } from "@/lib/line"
import type { LineEvent } from "@/lib/line"
import { handleFollow } from "@/lib/handlers"
import { handleAiChat, handleAiImage } from "@/lib/ai"
import { isBotPaused } from "@/lib/services/bot-pause"
import { isDuringBusinessHours } from "@/lib/services/business-hours"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return handleWebhookRequest(request, handleEvent)
}

async function handleEvent(event: LineEvent) {
  if (event.type === "follow" && event.source?.userId) {
    await handleFollow(event.source.userId)
    return
  }

  if (event.type !== "message" || !event.replyToken) return

  const userId = event.source?.userId ?? "unknown"
  const text = event.message?.type === "text" ? event.message.text ?? "" : ""
  const isQuoteLookup = /Q-\w{8}-\w{3}/i.test(text)

  // Quote lookup is available 24/7; other auto-replies are skipped during business hours
  if (!isQuoteLookup) {
    if (isDuringBusinessHours()) {
      console.log(`[bot] Skipping auto-reply for ${userId} — during business hours`)
      return
    }

    if (await isBotPaused(userId)) {
      console.log(`[bot] Skipping auto-reply for ${userId} — bot paused (human handoff)`)
      return
    }
  }

  if (event.message?.type === "text" && event.message.text) {
    await handleAiChat(event.replyToken, event.message.text, userId)
    return
  }

  if (event.message?.type === "image" && event.message.id) {
    const imageData = await fetchLineImage(event.message.id)
    if (!imageData) throw new Error(`Failed to fetch LINE image ${event.message.id}`)
    await handleAiImage(event.replyToken, imageData, userId)
  }
}

async function fetchLineImage(messageId: string): Promise<string | null> {
  try {
    const token = getChannelAccessToken()
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.error("Failed to fetch LINE image:", res.status)
      return null
    }
    const buffer = await res.arrayBuffer()
    return Buffer.from(buffer).toString("base64")
  } catch (err) {
    console.error("Error fetching LINE image:", err)
    return null
  }
}
