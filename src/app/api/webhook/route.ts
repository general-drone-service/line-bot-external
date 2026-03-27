import { NextResponse } from "next/server"
import { verifySignature } from "@/lib/line"
import type { LineEvent, LineWebhookBody } from "@/lib/line"
import { handleFollow } from "@/lib/handlers"
import { handleAiChat } from "@/lib/ai"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()

    const signature = request.headers.get("x-line-signature")
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 })
    }

    try {
      if (!verifySignature(rawBody, signature)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    } catch {
      console.warn("LINE signature verification skipped (missing secret?)")
    }

    const body = JSON.parse(rawBody) as LineWebhookBody

    for (const event of body.events) {
      try {
        await handleEvent(event)
      } catch (err) {
        console.error("Error handling event:", event.type, err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("LINE webhook error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

async function handleEvent(event: LineEvent) {
  if (event.type === "follow" && event.source?.userId) {
    await handleFollow(event.source.userId)
    return
  }

  if (
    event.type === "message" &&
    event.message?.type === "text" &&
    event.message.text &&
    event.replyToken
  ) {
    const userId = event.source?.userId ?? "unknown"
    await handleAiChat(event.replyToken, event.message.text, userId)
  }
}
