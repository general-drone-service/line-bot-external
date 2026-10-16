import { NextResponse } from "next/server"
import { extractToken, hashToken, stripToken } from "@/lib/tracking/token"
import {
  passthroughTrackingStore,
  crmTrackingStore,
  trackingEnabled,
  type ReplyStatus,
  type TrackingStore,
} from "@/lib/tracking/store"
import { isTerminalGatewayError } from "@/lib/botdb/gateway"
import { describeError } from "@/lib/errors"
import { LineApiError } from "./send"
import { verifySignature } from "./signature"
import type { LineEvent, LineWebhookBody } from "./types"

/** What the customer-service handler did: replied/pushed, or deliberately did nothing (terminal). */
export type EventOutcome = "sent" | "skipped"
export type EventHandler = (event: LineEvent, accountId: string) => Promise<EventOutcome>

export async function handleWebhookRequest(
  request: Request,
  handleEvent: EventHandler,
  store: TrackingStore = trackingEnabled() ? crmTrackingStore : passthroughTrackingStore
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
  // LINE console "Verify" sends no events
  if (body.events.length === 0) return NextResponse.json({ ok: true })

  const accountId = body.destination
  if (
    typeof accountId !== "string" ||
    !accountId ||
    body.events.some((e) => typeof e?.webhookEventId !== "string" || typeof e.timestamp !== "number")
  ) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  // Persist the whole batch before any reply: on failure nothing was sent, so LINE redelivery is safe
  try {
    await store.recordEvents(accountId, body.events)
  } catch (err) {
    console.error("LINE webhook: failed to record events", err)
    return NextResponse.json({ error: "Tracking unavailable" }, { status: 500 })
  }

  const testUsers = testUserIds()
  let failed = 0
  for (const event of body.events) {
    if (!(await trackEvent(store, accountId, event, testUsers))) failed++
    if (!(await replyToEvent(store, accountId, event, handleEvent))) failed++
  }

  if (failed > 0) {
    return NextResponse.json({ error: "Event handling failed", failed }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

async function trackEvent(store: TrackingStore, accountId: string, event: LineEvent, testUsers: Set<string>) {
  const text = event.message?.type === "text" ? event.message.text ?? "" : ""
  const token = extractToken(text)
  try {
    await store.processEvent(
      accountId,
      event.webhookEventId!,
      token ? hashToken(token) : null,
      testUsers.has(event.source?.userId ?? "")
    )
    return true
  } catch (err) {
    console.error("LINE webhook: tracking failed", event.webhookEventId, err)
    // Invalid data stays invalid on redelivery; tracking is best-effort next to the reply
    return isTerminalGatewayError(err)
  }
}

async function replyToEvent(store: TrackingStore, accountId: string, event: LineEvent, handleEvent: EventHandler) {
  const eventId = event.webhookEventId!
  let attempt: number
  try {
    attempt = await store.claimReply(accountId, eventId)
  } catch (err) {
    console.error("LINE webhook: reply claim failed", eventId, err)
    return false
  }
  // Already handled (or being handled) by an earlier delivery
  if (attempt === 0) return true

  let status: ReplyStatus
  let ok = true
  try {
    status = await handleEvent(withoutToken(event), accountId)
  } catch (err) {
    if ((err instanceof LineApiError && err.status >= 400 && err.status < 500) || isTerminalGatewayError(err)) {
      // LINE 4xx (e.g. used/expired reply token) and gateway 422 are terminal. After an earlier
      // failed attempt the first send may actually have reached the user, so that case is only "unknown".
      status = attempt > 1 ? "unknown" : "failed"
    } else {
      // 5xx / network / handler error: release for LINE redelivery
      status = "pending"
      ok = false
    }
    console.error("LINE webhook: event handling failed", eventId, event.type, status, describeError(err))
  }

  try {
    await store.finishReply(accountId, eventId, status)
  } catch (err) {
    console.error("LINE webhook: failed to store reply status", eventId, status, err)
    return false
  }
  return ok
}

function withoutToken(event: LineEvent): LineEvent {
  const text = event.message?.type === "text" ? event.message.text : undefined
  if (!text) return event
  const stripped = stripToken(text)
  if (stripped === text) return event
  return { ...event, message: { ...event.message!, text: stripped || "您好" } }
}

function testUserIds() {
  return new Set((process.env.LINE_TEST_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean))
}
