import { NextResponse } from "next/server"
import { CHAT_MODEL, getAnthropicClient } from "@/lib/ai/client"
import { describeError } from "@/lib/errors"
import { rejectUnlessBearer } from "@/lib/services/bearer-auth"

/**
 * Checks the deployed ANTHROPIC_API_KEY without touching LINE or the database:
 * GET /v1/models/{chat model} is free and fails with 401/403/404 for a bad key or missing model access.
 * Does not prove billing; a credit problem only shows on messages.create.
 * Requires `Authorization: Bearer $BOT_PAUSE_API_TOKEN`.
 */
export async function GET(request: Request) {
  const rejected = rejectUnlessBearer(request, process.env.BOT_PAUSE_API_TOKEN, "Health API")
  if (rejected) return rejected

  try {
    await getAnthropicClient().models.retrieve(CHAT_MODEL)
    return NextResponse.json({ status: 200 })
  } catch (err) {
    // Other errors get a fixed type: a malformed key ends up inside the SDK's header error message
    const described = describeError(err)
    const body = described instanceof Error ? { status: null, type: "internal_error", requestId: null } : described
    return NextResponse.json(body, { status: 502 })
  }
}
