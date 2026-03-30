import { NextResponse } from "next/server"
import { pauseBot, resumeBot, isBotPaused } from "@/lib/services/bot-pause"

/**
 * Bot pause management API for customer service agents.
 *
 * GET  /api/bot-pause?userId=xxx        — Check if bot is paused for a user
 * POST /api/bot-pause  { userId, action: "pause" | "resume", hours? }
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const userId = searchParams.get("userId")

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 })
  }

  const paused = await isBotPaused(userId)
  return NextResponse.json({ userId, paused })
}

export async function POST(request: Request) {
  const body = await request.json()
  const { userId, action, hours } = body as {
    userId?: string
    action?: "pause" | "resume"
    hours?: number
  }

  if (!userId || !action) {
    return NextResponse.json(
      { error: "Missing userId or action (pause | resume)" },
      { status: 400 }
    )
  }

  if (action === "pause") {
    await pauseBot(userId, hours)
    return NextResponse.json({ userId, paused: true, message: "Bot paused" })
  }

  if (action === "resume") {
    await resumeBot(userId)
    return NextResponse.json({ userId, paused: false, message: "Bot resumed" })
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 })
}
