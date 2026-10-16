import { getChannelAccessToken, handleWebhookRequest, LineApiError, retryKeyFor } from "@/lib/line"
import type { EventOutcome, LineEvent } from "@/lib/line"
import { handleFollow } from "@/lib/handlers"
import { handleAiChat, handleAiImage } from "@/lib/ai"
import { isBotPaused } from "@/lib/services/bot-pause"
import { isDuringBusinessHours } from "@/lib/services/business-hours"
import { cutoverFrozen } from "@/lib/botdb"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return handleWebhookRequest(request, handleEvent)
}

async function handleEvent(event: LineEvent, accountId: string): Promise<EventOutcome> {
  if (event.type === "follow" && event.source?.userId) {
    await handleFollow(event.source.userId, retryKeyFor(event.webhookEventId!))
    return "sent"
  }

  if (event.type !== "message" || !event.replyToken) return "skipped"

  const userId = event.source?.userId ?? "unknown"

  // Cutover freeze: staff answer by hand while the bot database is moved
  if (cutoverFrozen()) {
    console.log(`[bot] Skipping auto-reply for ${userId} — database cutover freeze`)
    return "skipped"
  }

  if (isDuringBusinessHours()) {
    console.log(`[bot] Skipping auto-reply for ${userId} — during business hours`)
    return "skipped"
  }

  if (await isBotPaused(userId)) {
    console.log(`[bot] Skipping auto-reply for ${userId} — bot paused (human handoff)`)
    return "skipped"
  }

  const turn = { accountId, webhookEventId: event.webhookEventId!, userId }

  if (event.message?.type === "text" && event.message.text) {
    await handleAiChat(event.replyToken, event.message.text, turn)
    return "sent"
  }

  if (event.message?.type === "image" && event.message.id) {
    const imageData = await fetchLineImage(event.message.id)
    await handleAiImage(event.replyToken, imageData, turn)
    return "sent"
  }

  return "skipped"
}

// Throws LineApiError on non-2xx (4xx is terminal, 5xx retried) and the fetch error on network failure
async function fetchLineImage(messageId: string): Promise<string> {
  const token = getChannelAccessToken()
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    console.error("Failed to fetch LINE image:", res.status)
    throw new LineApiError("content", res.status)
  }
  const buffer = await res.arrayBuffer()
  return Buffer.from(buffer).toString("base64")
}
