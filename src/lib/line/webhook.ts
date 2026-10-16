import { NextResponse } from "next/server"
import { verifySignature } from "./signature"
import type { LineEvent, LineWebhookBody } from "./types"

export async function handleWebhookRequest(
  request: Request,
  handleEvent: (event: LineEvent) => Promise<void>
): Promise<Response> {
  const rawBody = await request.text()

  const signature = request.headers.get("x-line-signature")
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 })
  }

  if (!process.env.LINE_CHANNEL_SECRET) {
    console.error("LINE webhook rejected: LINE_CHANNEL_SECRET is not set")
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
  }

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let body: LineWebhookBody
  try {
    body = JSON.parse(rawBody) as LineWebhookBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (!Array.isArray(body?.events)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // Keep handling the rest of the batch, but never report success for a failed event
  let failed = 0
  for (const event of body.events) {
    try {
      await handleEvent(event)
    } catch (err) {
      failed++
      console.error("Error handling event:", event?.type, err)
    }
  }

  if (failed > 0) {
    return NextResponse.json({ error: "Event handling failed", failed }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
